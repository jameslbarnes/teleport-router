/**
 * Agent Hook Handlers
 *
 * These handlers implement the Router agent's core behavior:
 * "make connections between people and ideas"
 *
 * Triggered by notebook events and platform messages.
 * Uses the intelligence layer for scoring, sparks, and heat detection.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { HookContext } from './types.js';
import type { HookDispatcher } from './dispatcher.js';
import type { JournalEntry, Storage, User } from '../storage.js';
import { shouldRoute, evaluateEntry, type RecentPost } from '../intelligence/scoring.js';
import { detectSparks, evaluateSpark, getConnectionInfo, executeSpark, type SparkAction, type SparkCandidate } from '../intelligence/sparks.js';
import { RoomBufferManager, type BufferedMessage } from '../intelligence/heat.js';
import { generateLinkToken } from '../intelligence/link-tokens.js';
import { MatrixPlatform, type MatrixHistoryMessage } from '../platform/matrix.js';
import type { Platform } from '../platform/types.js';
import { hasPublicAudience, isPublicNotebookEntry } from '../public-views.js';
import { sharingReceipt, formatVisibleSharingNotice } from '../sharing-receipt.js';
import { announcePlatformEntry } from '../platform-sharing-notice.js';
import { canView, normalizeEntry } from '../delivery.js';
import { noticeDestinations } from '../sharing-notice.js';
import { resolvePostingAudience } from '../posting-rules.js';

// ── State ────────────────────────────────────────────────────

const recentPosts: RecentPost[] = [];
const MAX_RECENT_POSTS = 20;
const MIN_PLATFORM_CONTENT_LENGTH = 50;
const MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID = 'bot-noise';
const MATRIX_DEFAULT_FIREHOSE_CHANNEL_NAME = 'Bot Noise';
const MATRIX_DEFAULT_FIREHOSE_DESCRIPTION = 'Router firehose for public notebook entries';
const MATRIX_SPARKS_CHANNEL_ID = 'sparks';
const MATRIX_SPARKS_CHANNEL_NAME = 'Sparks';
const MATRIX_SPARKS_CHANNEL_DESCRIPTION = 'Router-curated overlaps and connections from the notebook';
const SPARK_MATRIX_DEBOUNCE_WINDOW_MS = process.env.SPARK_MATRIX_DEBOUNCE_WINDOW_MS
  ? parseInt(process.env.SPARK_MATRIX_DEBOUNCE_WINDOW_MS)
  : 72 * 60 * 60 * 1000;
const SPARK_MATRIX_DEBOUNCE_LIMIT = process.env.SPARK_MATRIX_DEBOUNCE_LIMIT
  ? parseInt(process.env.SPARK_MATRIX_DEBOUNCE_LIMIT)
  : 160;

const SPARK_DEBOUNCE_STOP_WORDS = new Set([
  'about', 'after', 'again', 'already', 'also', 'around', 'because', 'between',
  'could', 'different', 'directly', 'entry', 'exactly', 'having', 'might',
  'notes', 'people', 'question', 'recent', 'recently', 'router', 'should',
  'spark', 'subject', 'their', 'there', 'these', 'thing', 'think', 'those',
  'through', 'together', 'would', 'worth',
]);

const roomBuffers = new RoomBufferManager();

export function hasLinkedPlatformAccount(
  user: Pick<User, 'linkedAccounts'> | null | undefined,
  platform: string,
): boolean {
  return !!user?.linkedAccounts?.some(account =>
    account.platform === platform
    && !!account.platformUserId
    && account.verified !== false,
  );
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

export function getUnexpectedSparkHandles(
  text: string | undefined,
  sourceHandle: string,
  targetHandle: string,
): string[] {
  if (!text) return [];

  const allowed = new Set([
    normalizeHandle(sourceHandle),
    normalizeHandle(targetHandle),
  ]);
  const unexpected = new Set<string>();
  const handlePattern = /(^|[\s([{"'`])@([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)(?=$|[\s)\]}:.,!?'"`])/g;

  for (const match of text.matchAll(handlePattern)) {
    const handle = normalizeHandle(match[2]);
    if (!allowed.has(handle)) {
      unexpected.add(handle);
    }
  }

  return [...unexpected];
}

function tokenizeSparkDebounceText(text: string | undefined): string[] {
  return (text || '')
    .toLowerCase()
    .match(/[a-z0-9][a-z0-9-]{3,}/g)
    ?.map(term => term.replace(/^-+|-+$/g, ''))
    .filter(term => term.length >= 4 && !SPARK_DEBOUNCE_STOP_WORDS.has(term))
    .slice(0, 80) || [];
}

export function getSparkDebounceTopicTerms(
  action: Pick<SparkAction, 'reason'>,
  candidate: Pick<SparkCandidate, 'overlapTopics' | 'matchingEntries'>,
  sourceEntry: Pick<JournalEntry, 'content' | 'topicHints' | 'keywords'>,
  maxTerms = 16,
): string[] {
  const scores = new Map<string, number>();
  const add = (terms: string[], weight: number) => {
    for (const term of terms) {
      scores.set(term, (scores.get(term) || 0) + weight);
    }
  };

  add(tokenizeSparkDebounceText(candidate.overlapTopics.join(' ')), 5);
  add(tokenizeSparkDebounceText([...(sourceEntry.topicHints || []), ...(sourceEntry.keywords || [])].join(' ')), 4);
  add(tokenizeSparkDebounceText(action.reason), 3);
  add(tokenizeSparkDebounceText(sourceEntry.content), 2);
  add(tokenizeSparkDebounceText(candidate.matchingEntries.map(e => e.content).join(' ')), 1);

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term)
    .slice(0, maxTerms);
}

function messageMatchesSparkTerms(message: MatrixHistoryMessage, terms: string[]): string[] {
  const text = message.text.toLowerCase();
  return terms.filter(term => text.includes(term));
}

export function findRecentMatrixSparkConversation(
  messages: MatrixHistoryMessage[],
  sourceHandle: string,
  targetHandle: string,
  terms: string[],
): { roomId: string; roomName: string; matchedTerms: string[]; sourceCount: number; targetCount: number } | null {
  if (terms.length === 0) return null;

  const source = normalizeHandle(sourceHandle);
  const target = normalizeHandle(targetHandle);
  const byRoom = new Map<string, MatrixHistoryMessage[]>();
  for (const message of messages) {
    if (message.isDM) continue;
    const sender = message.senderHandle ? normalizeHandle(message.senderHandle) : '';
    if (sender !== source && sender !== target) continue;
    const existing = byRoom.get(message.roomId) || [];
    existing.push(message);
    byRoom.set(message.roomId, existing);
  }

  for (const [roomId, roomMessages] of byRoom) {
    const sourceMessages = roomMessages.filter(message => normalizeHandle(message.senderHandle || '') === source);
    const targetMessages = roomMessages.filter(message => normalizeHandle(message.senderHandle || '') === target);
    if (sourceMessages.length === 0 || targetMessages.length === 0) continue;

    const matchedTerms = new Set<string>();
    const matchedHandles = new Set<string>();
    for (const message of roomMessages) {
      const hits = messageMatchesSparkTerms(message, terms);
      if (hits.length === 0) continue;
      hits.forEach(term => matchedTerms.add(term));
      matchedHandles.add(normalizeHandle(message.senderHandle || ''));
    }

    const pairIsActivelyTalking = roomMessages.length >= 4 && matchedTerms.size >= 2;
    const bothUsedTopicTerms = matchedHandles.has(source) && matchedHandles.has(target);
    if (bothUsedTopicTerms || pairIsActivelyTalking) {
      return {
        roomId,
        roomName: roomMessages[0]?.roomAlias || roomMessages[0]?.roomName || roomId,
        matchedTerms: [...matchedTerms],
        sourceCount: sourceMessages.length,
        targetCount: targetMessages.length,
      };
    }
  }

  return null;
}

async function findRecentMatrixSparkConversationForAction(
  action: SparkAction,
  candidate: SparkCandidate,
  sourceEntry: JournalEntry,
  matrixPlatform: MatrixPlatform,
): Promise<ReturnType<typeof findRecentMatrixSparkConversation>> {
  const queryable = matrixPlatform as MatrixPlatform & {
    queryRecentMessages?: MatrixPlatform['queryRecentMessages'];
  };
  if (typeof queryable.queryRecentMessages !== 'function') return null;

  const terms = getSparkDebounceTopicTerms(action, candidate, sourceEntry);
  if (terms.length === 0) return null;

  const messages = await queryable.queryRecentMessages({
    since: Date.now() - SPARK_MATRIX_DEBOUNCE_WINDOW_MS,
    limit: SPARK_MATRIX_DEBOUNCE_LIMIT,
    perRoomLimit: 40,
    includeDMs: false,
    spaceOnly: false,
    botScope: true,
  }).catch(() => []);

  return findRecentMatrixSparkConversation(messages, action.sourceHandle, action.targetHandle, terms);
}

function getAnthropic(): Anthropic | null {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  return new Anthropic({ apiKey: key });
}

function matrixMentionsHandledByRouterAgent(): boolean {
  const raw = process.env.ROUTER_AGENT_HANDLES_MATRIX;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'remote'].includes(raw.trim().toLowerCase());
}

export function getPublishedEntryFromEvent(
  storedEntry: JournalEntry | null,
  eventData: Record<string, any>,
): JournalEntry | null {
  if (storedEntry) return storedEntry;

  const snapshot = eventData.entry;
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (typeof snapshot.id !== 'string') return null;
  if (typeof snapshot.pseudonym !== 'string') return null;
  if (snapshot.client !== 'desktop' && snapshot.client !== 'mobile' && snapshot.client !== 'code') return null;
  if (typeof snapshot.content !== 'string') return null;
  if (typeof snapshot.timestamp !== 'number') return null;

  return snapshot as JournalEntry;
}

export function getMatrixRoutingTargets(entry: JournalEntry): { postToFeed: boolean; channelDests: string[] } {
  if (entry.aiOnly === true || entry.humanVisible === false) return { postToFeed: false, channelDests: [] };
  if (entry.content.length < MIN_PLATFORM_CONTENT_LENGTH) return { postToFeed: false, channelDests: [] };

  const destinations = entry.to || [];
  const channelDests = destinations
    .filter(dest => dest.startsWith('#'))
    .map(dest => dest.slice(1));

  if (entry.visibility === 'private' && channelDests.length === 0) {
    return { postToFeed: false, channelDests: [] };
  }

  return {
    postToFeed: destinations.length === 0,
    channelDests,
  };
}

type PendingEntryStorage = Storage & {
  getAllPendingEntries(): JournalEntry[];
  isPending(id: string): boolean;
  publishEntry(id: string): Promise<JournalEntry | null>;
};

function hasPendingEntryApi(storage: Storage): storage is PendingEntryStorage {
  const candidate = storage as Partial<PendingEntryStorage>;
  return typeof candidate.getAllPendingEntries === 'function'
    && typeof candidate.isPending === 'function'
    && typeof candidate.publishEntry === 'function';
}

function getVerifiedLinkedAccount(user: User | null | undefined, platformName: string): string | null {
  return user?.linkedAccounts?.find(account =>
    account.platform === platformName
    && !!account.platformUserId
    && account.verified !== false,
  )?.platformUserId || null;
}

function entryBelongsToUser(entry: JournalEntry, user: User): boolean {
  if (entry.handle && normalizeHandle(entry.handle) === normalizeHandle(user.handle)) return true;
  return !!user.legacyPseudonym && entry.pseudonym === user.legacyPseudonym;
}

async function findUserByLinkedAccount(storage: Storage, platformName: string, platformUserId: string): Promise<User | null> {
  const users = await storage.getAllUsers();
  return users.find(user =>
    user.linkedAccounts?.some(account =>
      account.platform === platformName
      && account.platformUserId === platformUserId
      && account.verified !== false,
    ),
  ) || null;
}

async function findEntryAuthorUser(storage: Storage, entry: JournalEntry): Promise<User | null> {
  if (entry.handle) {
    return storage.getUser(entry.handle).catch(() => null);
  }

  const users = await storage.getAllUsers().catch(() => []);
  return users.find(user => user.legacyPseudonym === entry.pseudonym) || null;
}

function formatRelativePublishTime(publishAt: number | undefined): string {
  if (!publishAt) return 'soon';

  const ms = publishAt - Date.now();
  if (ms <= 0) return 'now';

  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hour${hours === 1 ? '' : 's'}`;

  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function truncateForMatrix(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function getPendingCommandAction(command: string | undefined): 'publish' | 'delete' | null {
  if (command === 'publish' || command === '/publish') return 'publish';
  if (command === 'delete' || command === '/delete' || command === 'remove') return 'delete';
  return null;
}

function getPendingCommandTarget(query: string, replyPendingEntryId?: string): { action: 'publish' | 'delete'; target: string } | null {
  const tokens = query.split(/\s+/).filter(Boolean);
  const action = getPendingCommandAction(tokens[0]);
  if (!action) return null;

  const explicitId = tokens
    .slice(1)
    .find(token => /^[a-z0-9]+-[a-z0-9]+$/.test(token));
  if (explicitId) return { action, target: explicitId };

  if (tokens.length === 1 && replyPendingEntryId) return { action, target: replyPendingEntryId };
  return null;
}

export async function notifyLinkedMatrixPendingEntry(ctx: HookContext, entry: JournalEntry): Promise<void> {
  if (!entry.publishAt || entry.publishAt <= Date.now()) return;

  const matrix = ctx.platforms.find(platform => platform.name === 'matrix') as (Platform & {
    sendPendingEntryReviewDM?: (userId: string, text: string, entryId: string) => Promise<string>;
  }) | undefined;
  if (!matrix) return;

  const author = await findEntryAuthorUser(ctx.storage, entry);
  const matrixUserId = getVerifiedLinkedAccount(author, 'matrix');
  if (!matrixUserId) return;

  const message = [
    formatVisibleSharingNotice(sharingReceipt(entry, process.env.BASE_URL || 'https://router.teleport.computer', true)),
    ``,
    `Reply to this message with \`publish\` to publish now, or \`delete\` to remove it.`,
  ].join('\n');

  if (typeof matrix.sendPendingEntryReviewDM === 'function') {
    await matrix.sendPendingEntryReviewDM(matrixUserId, message, entry.id);
  } else {
    await matrix.sendDM(matrixUserId, message);
  }
}

async function executePendingEntryAction(params: {
  storage: Storage;
  platform: Platform;
  platformName: string;
  roomId: string;
  messageId?: string;
  senderId?: string;
  action: 'publish' | 'delete';
  target: string;
}): Promise<boolean> {
  const reply = (text: string) => params.platform.sendMessage(params.roomId, text, { replyTo: params.messageId });

  if (!params.senderId) {
    await reply('I could not identify your Matrix account for this command.');
    return true;
  }

  const user = await findUserByLinkedAccount(params.storage, params.platformName, params.senderId);
  if (!user) {
    await reply('Link this Matrix account first by sending `link`, then run the Router linking tool with the code.');
    return true;
  }

  if (!hasPendingEntryApi(params.storage)) {
    await reply('This Router deployment does not have a pending-post buffer enabled.');
    return true;
  }

  const entry = await params.storage.getEntry(params.target);
  if (!entry || !params.storage.isPending(params.target)) {
    await reply(`Entry ${params.target} is not pending. It may already be published or deleted.`);
    return true;
  }
  if (!entryBelongsToUser(entry, user)) {
    await reply('You can only publish your own pending posts.');
    return true;
  }

  if (params.action === 'delete') {
    await params.storage.deleteEntry(entry.id);
    await reply(`Deleted entry ${entry.id}. It will not publish.`);
    return true;
  }

  const published = await params.storage.publishEntry(entry.id);
  if (!published) {
    await reply(`Entry ${entry.id} could not be published. It may already be gone from the buffer.`);
    return true;
  }

  const url = `${process.env.BASE_URL || 'https://router.teleport.computer'}/entry.html?id=${encodeURIComponent(published.id)}`;
  const publishedLabel = published.id === entry.id ? published.id : `${entry.id} as ${published.id}`;
  await reply(`Published entry ${publishedLabel}.\n\n${url}`);
  return true;
}

export async function handlePendingPublishCommand(params: {
  storage: Storage;
  platform: Platform;
  platformName: string;
  roomId: string;
  messageId?: string;
  senderId?: string;
  query: string;
  replyPendingEntryId?: string;
}): Promise<boolean> {
  const tokens = params.query.split(/\s+/).filter(Boolean);
  const action = getPendingCommandAction(tokens[0]);
  if (!action) return false;
  const reply = (text: string) => params.platform.sendMessage(params.roomId, text, { replyTo: params.messageId });
  const command = getPendingCommandTarget(params.query, params.replyPendingEntryId);
  if (!command) {
    await reply('Reply to the post review message with `publish` or `delete`.');
    return true;
  }

  return executePendingEntryAction({
    storage: params.storage,
    platform: params.platform,
    platformName: params.platformName,
    roomId: params.roomId,
    messageId: params.messageId,
    senderId: params.senderId,
    action: command.action,
    target: command.target,
  });
}

// ── Registration ─────────────────────────────────────────────

/**
 * Register all agent hooks with the dispatcher.
 */
export function registerAgentHooks(dispatcher: HookDispatcher): void {
  dispatcher.register({
    id: 'agent:entry-published',
    triggers: ['entry_published'],
    handler: onEntryPublished,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:entry-staged',
    triggers: ['entry_staged'],
    handler: onEntryStaged,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:platform-message',
    triggers: ['platform_message'],
    handler: onPlatformMessage,
    priority: 50,
  });

  dispatcher.register({
    id: 'agent:platform-mention',
    triggers: ['platform_mention'],
    handler: onPlatformMention,
    priority: 50,
  });
}

// ── Handlers ─────────────────────────────────────────────────

/**
 * Entry published → evaluate for routing and spark detection.
 */
async function onEntryPublished(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const entryId = event.data.entry_id;
  if (!entryId) return;

  const storedEntry = await storage.getEntry(entryId);
  const entry = getPublishedEntryFromEvent(storedEntry, event.data);
  if (!entry) {
    console.warn(`[Agent] Published entry ${entryId} not found in storage and no usable snapshot was attached`);
    return;
  }
  if (!storedEntry) {
    console.warn(`[Agent] Published entry ${entryId} missing from storage lookup, using event snapshot`);
  }

  const authorDisplay = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  // Logs are not private: log the entry ID and size, never its text or author.
  console.log(`[Agent] Entry ${entry.id} published (${entry.content.length} chars)`);

  const anthropic = getAnthropic();

  // ── Routing: should this entry be surfaced on platforms? ──
  let evaluationKeywords: string[] | undefined;
  const matrixTargets = getMatrixRoutingTargets(entry);
  const shouldEvaluateForPlatforms = shouldRoute(entry) || matrixTargets.channelDests.length > 0;

  let evaluation: { route: boolean; hook?: string; score?: number; keywords?: string[] } = { route: false };
  if (shouldEvaluateForPlatforms) {
    const evaluableEntry = entry.to && entry.to.length > 0
      ? { ...entry, to: undefined }
      : entry;
    evaluation = await evaluateEntry(evaluableEntry, anthropic, storage, recentPosts);
    evaluationKeywords = evaluation.keywords;
  }

  const shouldRecordRecentPost = evaluation.route || matrixTargets.postToFeed || matrixTargets.channelDests.length > 0;
  if (shouldRecordRecentPost && isPublicNotebookEntry(entry)) {
    recentPosts.push({
      author: authorDisplay,
      contentSnippet: entry.content.slice(0, 200),
      hook: evaluation.hook,
    });
    if (recentPosts.length > MAX_RECENT_POSTS) recentPosts.shift();
  }

  for (const platform of platforms) {
    try {
      if (platform instanceof MatrixPlatform) {
        if (matrixTargets.postToFeed || matrixTargets.channelDests.length > 0) {
          console.log(
            `[Agent] Matrix routing plan for ${entry.id}: feed=${matrixTargets.postToFeed} channels=${matrixTargets.channelDests.join(',') || '(none)'}`
          );
        }

        if (matrixTargets.channelDests.length > 0) {
          for (const channelId of matrixTargets.channelDests) {
            const roomId = await platform.ensureChannelRoom(channelId, channelId);
            await platform.postEntry(roomId, entry, evaluation.hook);
            console.log(`[Agent] Posted entry to #${channelId} on Matrix`);
          }
        }

        if (matrixTargets.postToFeed) {
          const feedRoomId = await platform.ensureChannelRoom(
            MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID,
            MATRIX_DEFAULT_FIREHOSE_CHANNEL_NAME,
            MATRIX_DEFAULT_FIREHOSE_DESCRIPTION,
          );
          await platform.postEntry(feedRoomId, entry, evaluation.hook);
          console.log(`[Agent] Posted entry to #${MATRIX_DEFAULT_FIREHOSE_CHANNEL_ID} on Matrix`);
        }
      } else if (evaluation.route) {
        const content = evaluation.hook || entry.content;
        console.log(`[Agent] Routing entry ${entry.id} to ${platform.name} (${content.length} chars)`);
      }
    } catch (err) {
      console.error(`[Agent] Failed to route to ${platform.name}:`, err);
    }
  }

  // ── Sparks: does this entry create connections? ──
  if (entry.handle && anthropic) {
    try {
      const candidates = await detectSparks(entry, storage, evaluationKeywords);
      if (candidates.length > 0) {
        console.log(`[Agent] ${candidates.length} spark candidates for entry ${entry.id}`);

        // Evaluate top candidates
        for (const candidate of candidates.slice(0, 3)) {
          const connectionInfo = await getConnectionInfo(entry.handle, candidate.handle, platforms, storage);
          const action = await evaluateSpark(entry, candidate, connectionInfo, anthropic);

          if (action.action !== 'skip') {
            console.log(`[Agent] Spark: ${action.action} @${action.sourceHandle} ↔ @${action.targetHandle} (${action.confidence}): ${action.reason}`);
            await executeSparkWithContext(action, candidate, entry, platforms, storage);
          }
        }
      }
    } catch (err) {
      console.error('[Agent] Spark detection failed:', err);
    }
  }
}

/**
 * Entry staged → log for now, future: content moderation.
 */
async function onEntryStaged(ctx: HookContext): Promise<void> {
  const { event, storage } = ctx;
  const author = event.data.author_handle || event.data.author_pseudonym;
  console.log(`[Agent] Entry staged by ${author}: ${event.data.entry_id}`);

  const entryId = event.data.entry_id;
  if (!entryId) return;

  try {
    const entry = await storage.getEntry(entryId);
    if (!entry) return;
    await notifyLinkedMatrixPendingEntry(ctx, entry);
  } catch (err) {
    console.error('[Agent] Failed to notify linked Matrix account for staged entry:', err);
  }
}

/**
 * Platform message → buffer, heat detection, writeback evaluation.
 */
async function onPlatformMessage(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const { platform: platformName, room_id, text, sender_handle, sender_id, timestamp } = event.data;

  if (!text || !room_id) return;

  // ── Reply-to-entry writeback ──────────────────────────────
  // If someone replies to a notebook entry in Matrix, write it
  // back as a threaded reply in the notebook
  const replyToEntryId = event.data.reply_to_entry_id;
  if (replyToEntryId && sender_handle) {
    try {
      const writer = await storage.getUser(sender_handle);
      const parent = await storage.getEntry(replyToEntryId);
      // Platform replies remain automatic copies, subject to the writer's rules
      // and the parent's audience. Never turn a private thread into a public post.
      const isAuthor = !!parent && (parent.handle === sender_handle || !!writer?.legacyPseudonym && parent.pseudonym === writer.legacyPseudonym);
      if (writer && parent && getVerifiedLinkedAccount(writer, platformName) === sender_id
        && (!hasPendingEntryApi(storage) || !storage.isPending(parent.id) || isAuthor)
        && await canView(normalizeEntry(parent), writer.handle, writer.email, isAuthor, storage, new Map())) {
        let destinations = noticeDestinations(parent);
        if (destinations.length && !destinations.some(d => d.startsWith('#')) && parent.handle) {
          destinations = [...new Set([...destinations, '@' + parent.handle])];
        }
        const to = resolvePostingAudience(writer.postingRules, 'automatic', destinations);
        const saved = await storage.addEntry({
          pseudonym: sender_handle,
          handle: sender_handle,
          client: 'code' as const,
          content: text,
          timestamp: Date.now(),
          inReplyTo: replyToEntryId,
          to,
          visibility: parent.visibility === 'private' ? 'private' : undefined,
        });
        const origin = platforms.find(platform => platform.name === platformName);
        if (origin) await announcePlatformEntry(saved, storage, process.env.BASE_URL || 'https://router.teleport.computer', async notice => {
          const messageId = await origin.sendMessage(room_id, notice, { replyTo: event.data.message_id });
          return `${platformName}:${room_id}:${messageId}`;
        });
        console.log(`[Agent] Wrote Matrix reply from @${sender_handle} as notebook reply to ${replyToEntryId}`);
      }
    } catch (err) {
      console.error('[Agent] Failed to write reply to notebook:', err);
    }
  }

  // Buffer the message
  const buffer = roomBuffers.getBuffer(room_id);
  const msg: BufferedMessage = {
    text,
    senderName: sender_handle || sender_id || 'unknown',
    senderId: sender_id,
    timestamp: timestamp || Date.now(),
    platform: platformName,
    roomId: room_id,
  };
  buffer.push(msg);

  // Check heat — is this conversation worth evaluating?
  const heat = buffer.measureHeat();
  if (heat.isHot && buffer.messagesSinceCheck >= 10) {
    buffer.resetCheckCounter();
    console.log(`[Agent] Hot conversation in ${room_id} on ${platformName}: ${heat.uniqueSenders} senders, ${heat.recentCount} messages`);

    // Future: detect sparks from conversation topics
    // Future: evaluate for notebook writeback
  }
}

/**
 * Platform mention → search notebook, respond.
 */
async function onPlatformMention(ctx: HookContext): Promise<void> {
  const { event, storage, platforms } = ctx;
  const { platform: platformName, room_id, text, sender_handle, sender_id, message_id, is_dm, pending_entry_id } = event.data;

  if (!text || !room_id) return;

  const platform = platforms.find(p => p.name === platformName);
  if (!platform) return;

  console.log(`[Agent] ${is_dm ? 'DM' : 'Mention'} on ${platformName} (${text.length} chars)`);

  // Extract the query (remove @mentions, slashes, etc.)
  const query = text.replace(/@\w+/g, '').trim().toLowerCase();
  const firstWord = query.split(/\s+/)[0];

  // ── Link command ──────────────────────────────────────────
  // User DMs "link" to get a code that ties their platform account
  // to their Router identity (completed via MCP tool).
  if ((firstWord === 'link' || firstWord === '/link') && sender_id) {
    const code = generateLinkToken(platformName, sender_id);
    const reply = [
      `Your one-time link code: **${code}**`,
      '',
      `In the Router notebook, tell Claude:`,
      `"Link my ${platformName} account with code ${code}"`,
      '',
      `Claude should use the \`router_link_platform\` tool automatically.`,
      `If you haven't created a Router handle yet, do that first, then run the link step again.`,
      '',
      `(expires in 10 minutes)`,
    ].join('\n');
    await platform.sendMessage(room_id, reply, { replyTo: message_id });
    console.log(`[Agent] Generated link code ${code} for ${sender_id}`);
    return;
  }

  // ── Help command ──────────────────────────────────────────
  if (firstWord === 'help' || firstWord === '/help') {
    const helpText = [
      `I'm the Router — I connect people and ideas from the notebook.`,
      ``,
      `Commands:`,
      `• **link** — get a code to connect this ${platformName} account to your Router identity`,
      `• Reply **publish** to a post review message to publish it now`,
      `• Reply **delete** to a post review message to delete it`,
      `• **help** — show this message`,
      ``,
      `Or just ask me a question about the notebook and I'll search it.`,
    ].join('\n');
    await platform.sendMessage(room_id, helpText, { replyTo: message_id });
    return;
  }

  if (platformName === 'matrix' && is_dm) {
    const handled = await handlePendingPublishCommand({
      storage,
      platform,
      platformName,
      roomId: room_id,
      messageId: message_id,
      senderId: sender_id,
      query,
      replyPendingEntryId: pending_entry_id,
    });
    if (handled) return;
  }

  // Matrix DMs/@mentions should be handled by the external Router agent
  // when that path is enabled. Keep link/help local, but otherwise let the
  // event queue be the handoff boundary.
  if (platformName === 'matrix' && matrixMentionsHandledByRouterAgent()) {
    console.log(
      `[Agent] Deferring Matrix ${is_dm ? 'DM' : 'mention'} in ${room_id} to router-agent`,
    );
    return;
  }

  if (query.length < 3) {
    await platform.sendMessage(room_id, "Say `help` for what I can do, or ask me anything about the notebook.", {
      replyTo: message_id,
    });
    return;
  }

  try {
    const results = await storage.searchEntries(query, 5);
    if (results.length === 0) {
      await platform.sendMessage(room_id, `No entries found for "${query}".`, { replyTo: message_id });
      return;
    }

    const summary = results.map(e => {
      const author = e.handle ? `@${e.handle}` : e.pseudonym;
      const snippet = e.content.substring(0, 150).replace(/\n/g, ' ');
      return `**${author}**: ${snippet}...`;
    }).join('\n\n');

    await platform.sendMessage(room_id, summary, { replyTo: message_id });
  } catch (err) {
    console.error('[Agent] Mention handler error:', err);
    await platform.sendMessage(room_id, 'Sorry, something went wrong searching the notebook.', { replyTo: message_id });
  }
}

// ── Helpers ──────────────────────────────────────────────────

async function findKeyHashForHandle(handle: string, storage: import('../storage.js').Storage): Promise<string | null> {
  try {
    const user = await storage.getUser(handle);
    return user?.secretKeyHash || null;
  } catch {
    return null;
  }
}

// ── Spark Execution ──────────────────────────────────────────

/**
 * Forward the source entry into #sparks, then post the warm message as a
 * reply to that forwarded entry — so anchor and commentary always live in
 * the same curated room. Linked-Matrix isn't required: the room is public
 * to subscribers and unlinked @handles still render as text mentions.
 */
async function executeSparkWithContext(
  action: SparkAction,
  candidate: SparkCandidate,
  sourceEntry: JournalEntry,
  platforms: import('../platform/types.js').Platform[],
  storage?: Storage,
  options: { debounceMatrix?: boolean } = {},
): Promise<void> {
  if (action.action === 'skip') return;
  if (!action.message) return;

  const matrixPlatform = platforms.find(p => p instanceof MatrixPlatform) as MatrixPlatform | undefined;

  const unexpectedHandles = getUnexpectedSparkHandles(
    [action.reason, action.message].filter(Boolean).join('\n'),
    action.sourceHandle,
    action.targetHandle,
  );
  if (unexpectedHandles.length > 0) {
    console.warn(
      `[Agent] Skipping spark @${action.sourceHandle} ↔ @${action.targetHandle}: ` +
      `message mentioned unrelated handles (${unexpectedHandles.map(h => `@${h}`).join(', ')})`,
    );
    return;
  }

  if (matrixPlatform && options.debounceMatrix !== false) {
    const existingConversation = await findRecentMatrixSparkConversationForAction(
      action,
      candidate,
      sourceEntry,
      matrixPlatform,
    );
    if (existingConversation) {
      console.log(
        `[Agent] Skipping spark @${action.sourceHandle} ↔ @${action.targetHandle}: ` +
        `recent Matrix conversation already active in ${existingConversation.roomName} ` +
        `(terms=${existingConversation.matchedTerms.slice(0, 5).join(', ') || 'none'})`,
      );
      return;
    }
  }

  if (!matrixPlatform) {
    console.warn('[Agent] No Matrix platform available; cannot post spark to #sparks');
    return;
  }

  const sparksRoomId = await matrixPlatform.ensureChannelRoom(
    MATRIX_SPARKS_CHANNEL_ID,
    MATRIX_SPARKS_CHANNEL_NAME,
    MATRIX_SPARKS_CHANNEL_DESCRIPTION,
  );

  const forwardedEventId = await matrixPlatform.postEntry(sparksRoomId, sourceEntry);

  await executeSpark(action, platforms, {
    roomId: sparksRoomId,
    replyToEventId: forwardedEventId,
  });
}

export async function triggerManualSpark(
  sourceHandle: string,
  targetHandle: string,
  reason: string,
  platforms: import('../platform/types.js').Platform[],
  storage: Storage,
  message?: string,
): Promise<void> {
  const [sourceEntries, targetEntries] = await Promise.all([
    storage.getEntriesByHandle(sourceHandle, 1),
    storage.getEntriesByHandle(targetHandle, 3),
  ]);

  const sourceEntry = sourceEntries.find(hasPublicAudience) || {
    id: `manual-spark-${Date.now()}`,
    handle: sourceHandle,
    pseudonym: `@${sourceHandle}`,
    client: 'desktop' as const,
    content: reason,
    timestamp: Date.now(),
  };

  const candidate: import('../intelligence/sparks.js').SparkCandidate = {
    handle: targetHandle,
    matchingEntries: targetEntries.filter(hasPublicAudience),
    overlapTopics: [],
  };

  const action: SparkAction = {
    action: 'introduce',
    confidence: 'high',
    sourceHandle,
    targetHandle,
    reason,
    message,
  };

  await executeSparkWithContext(action, candidate, sourceEntry, platforms, storage, { debounceMatrix: false });
}
