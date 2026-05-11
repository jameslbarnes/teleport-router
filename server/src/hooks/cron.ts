/**
 * Cron Hook Handlers
 *
 * Scheduled tasks: daily digest and channel room initialization.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry, User } from '../storage.js';
import { MatrixPlatform, type MatrixHistoryMessage } from '../platform/matrix.js';
import { getPlatform } from '../platform/registry.js';
import { getDailyDigestPostRecord, postDailyDigestToMatrix } from '../daily-digest-post.js';
import { formatNewsletterDigestForMatrix, generateNewsletterDigest } from '../newsletter-digest.js';

// ── Digest ───────────────────────────────────────────────────

export const PERSONALIZED_DIGEST_MODEL = 'claude-opus-4-7';

const PERSONALIZED_DIGEST_PROMPT = `You are the Router, writing a personalized daily digest for a specific person.

Use the person's actual notebook corpus and follow graph as context. Do not rely on a precomputed profile or abstract labels.

Write their digest with THEM in mind. Lead with what matters to THEM — entries from people they follow, work that overlaps with theirs, problems they could help solve (or that could help them).

Some context may come from Matrix room discussion snippets. Public room snippets are community context; private DM snippets are only included when the recipient is in that DM.

Structure:
- "For you" section: entries directly relevant to their current work or interests
- "From your network" section: what people they follow wrote about
- "You might want to meet" section: if someone new wrote about something they care about, suggest the connection with a specific reason

Voice: you're a thoughtful friend who reads everything and knows what this person cares about. Not a news aggregator.

Keep it under 500 words. Cite @handles. Be specific about WHY something is relevant to them.`;

export interface GlobalDigestResult {
  posted: boolean;
  queued?: boolean;
  eventId?: number;
  roomId?: string;
  messageId?: string;
  entryCount: number;
  includedEntryCount: number;
  matrixMessageCount?: number;
  date: string;
  skipped?: string;
  failed?: boolean;
}

function getUtcDayRange(date: string): { start: number; end: number } {
  const start = new Date(`${date}T00:00:00.000Z`).getTime();
  return { start, end: start + 24 * 60 * 60 * 1000 };
}

function getYesterdayUtcDate(now = new Date()): string {
  const yesterday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
  ));
  return yesterday.toISOString().slice(0, 10);
}

function isChannelDestination(dest: string): boolean {
  return dest.trim().startsWith('#');
}

function isPublicDigestEntry(entry: JournalEntry): boolean {
  if (entry.aiOnly === true || entry.humanVisible === false) return false;
  if (entry.visibility === 'private' || entry.visibility === 'ai-only') return false;
  if (entry.to && entry.to.length > 0 && !entry.to.every(isChannelDestination)) return false;
  return true;
}

function formatMatrixMessageForDigestPrompt(message: MatrixHistoryMessage, max = 320): string {
  const time = new Date(message.timestamp).toISOString().slice(11, 16);
  const sender = message.senderHandle ? `@${message.senderHandle}` : message.senderId;
  const room = message.isDM
    ? `DM ${message.roomName}`
    : (message.roomAlias || message.roomName || message.roomId);
  const content = message.text.replace(/\s+/g, ' ').trim();
  return `[${time}] ${room} ${sender}: ${content.slice(0, max)}${content.length > max ? '...' : ''}`;
}

function formatMatrixMessagesForDigestPrompt(messages: MatrixHistoryMessage[], maxMessages = 80): string {
  return messages
    .slice(0, maxMessages)
    .map(message => formatMatrixMessageForDigestPrompt(message))
    .join('\n');
}

function formatEntryForDigestPrompt(entry: JournalEntry, max = 520): string {
  const time = new Date(entry.timestamp).toISOString().slice(11, 16);
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const destination = entry.to && entry.to.length > 0 ? ` to ${entry.to.join(', ')}` : '';
  const content = entry.content.replace(/\s+/g, ' ').trim();
  return `[${time}] ${author}${destination}: ${content.slice(0, max)}${content.length > max ? '...' : ''}`;
}

function formatEntriesForDigestPrompt(entries: JournalEntry[], maxEntries = 80): string {
  return entries
    .slice(0, maxEntries)
    .map(entry => formatEntryForDigestPrompt(entry))
    .join('\n');
}

async function queryMatrixDigestMessages(
  matrix: MatrixPlatform,
  opts: {
    since: number;
    until: number;
    limit: number;
    includeDMs?: boolean;
    onlyDMs?: boolean;
    viewerUserId?: string;
  },
): Promise<MatrixHistoryMessage[]> {
  const queryable = matrix as MatrixPlatform & {
    queryRecentMessages?: MatrixPlatform['queryRecentMessages'];
  };

  if (typeof queryable.queryRecentMessages !== 'function') return [];

  try {
    return await queryable.queryRecentMessages({
      since: opts.since,
      until: opts.until,
      limit: opts.limit,
      includeDMs: opts.includeDMs,
      onlyDMs: opts.onlyDMs,
      viewerUserId: opts.viewerUserId,
      spaceOnly: !opts.onlyDMs,
    });
  } catch (error) {
    console.warn('[Cron] Failed to query Matrix history for digest:', error);
    return [];
  }
}

/**
 * Generate and post a global daily digest to the Matrix #digest room.
 * Called by the cron scheduler (typically 8am UTC).
 */
export async function generateDailyDigest(
  storage: Storage,
  opts?: { date?: string },
): Promise<GlobalDigestResult> {
  console.log('[Cron] Generating global daily digest...');

  const date = opts?.date || getYesterdayUtcDate();
  const { start: startOfDay, end: endOfDay } = getUtcDayRange(date);

  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) {
    console.log('[Cron] Skipping global digest: Matrix platform not connected');
    return { posted: false, entryCount: 0, includedEntryCount: 0, date, skipped: 'matrix-not-connected' };
  }

  const allEntries = await storage.getEntriesSince(startOfDay, 1000);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && isPublicDigestEntry(e)
  );
  const matrixMessages = await queryMatrixDigestMessages(matrix, {
    since: startOfDay,
    until: endOfDay,
    limit: 80,
  });

  if (yesterdayEntries.length === 0 && matrixMessages.length === 0) {
    console.log('[Cron] No public notebook or Matrix activity yesterday, skipping global digest');
    return { posted: false, entryCount: 0, includedEntryCount: 0, matrixMessageCount: 0, date, skipped: 'no-public-activity' };
  }

  const existingPost = getDailyDigestPostRecord(date);
  if (existingPost) {
    console.log(`[Cron] Global daily digest for ${date} already posted as ${existingPost.messageId}`);
    return {
      posted: false,
      roomId: existingPost.roomId,
      messageId: existingPost.messageId,
      entryCount: yesterdayEntries.length,
      includedEntryCount: yesterdayEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
      skipped: 'already-posted',
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Cron] Skipping global digest: ANTHROPIC_API_KEY is not configured');
    return {
      posted: false,
      entryCount: yesterdayEntries.length,
      includedEntryCount: yesterdayEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
      skipped: 'anthropic-not-configured',
    };
  }

  try {
    const anthropic = new Anthropic({ apiKey });
    const result = await generateNewsletterDigest(anthropic, {
      audienceName: 'the Router Matrix #digest room',
      productName: 'Router',
      mode: 'matrix',
      date,
      discoveryEntriesText: formatEntriesForDigestPrompt(yesterdayEntries),
      matrixMessagesText: formatMatrixMessagesForDigestPrompt(matrixMessages),
    });
    if (!result) {
      throw new Error('Could not parse digest from Claude response');
    }

    const postAttempt = await postDailyDigestToMatrix(
      matrix,
      date,
      formatNewsletterDigestForMatrix(result),
      'server-cron',
    );

    if (postAttempt.status === 'already-posted') {
      console.log(`[Cron] Global daily digest for ${date} already posted as ${postAttempt.record.messageId}`);
      return {
        posted: false,
        roomId: postAttempt.record.roomId,
        messageId: postAttempt.record.messageId,
        entryCount: yesterdayEntries.length,
        includedEntryCount: yesterdayEntries.length,
        matrixMessageCount: matrixMessages.length,
        date,
        skipped: 'already-posted',
      };
    }

    console.log(`[Cron] Posted global daily digest for ${date} to ${postAttempt.record.roomId} as ${postAttempt.record.messageId}`);

    return {
      posted: true,
      roomId: postAttempt.record.roomId,
      messageId: postAttempt.record.messageId,
      entryCount: yesterdayEntries.length,
      includedEntryCount: yesterdayEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
    };
  } catch (err) {
    console.error('[Cron] Failed to post global digest:', err);
    return {
      posted: false,
      entryCount: yesterdayEntries.length,
      includedEntryCount: yesterdayEntries.length,
      matrixMessageCount: matrixMessages.length,
      date,
      failed: true,
    };
  }
}

/**
 * Send personalized digests to individual users via Matrix DM.
 * Each user gets a digest curated from their notebook corpus, follow graph,
 * and the prior day's public notebook activity.
 */
function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

function getVerifiedLinkedPlatformUserId(user: User, platform: string): string | null {
  const account = user.linkedAccounts?.find(acc =>
    acc.platform === platform
    && !!acc.platformUserId
    && acc.verified !== false,
  );
  return account?.platformUserId || null;
}

function formatEntryForPrompt(entry: JournalEntry, max = 300): string {
  const date = new Date(entry.timestamp).toISOString().slice(0, 10);
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const content = entry.content.trim() || '[no text content]';
  return `[${date}] ${author}: ${content.slice(0, max)}${content.length > max ? '...' : ''}`;
}

async function getMatrixDigestRecipients(storage: Storage, handles?: string[]): Promise<Array<{ user: User; matrixUserId: string }>> {
  const users = handles?.length
    ? (await Promise.all(handles.map(handle => storage.getUser(normalizeHandle(handle))))).filter((u): u is User => !!u)
    : await storage.getAllUsers();

  const seen = new Set<string>();
  const recipients: Array<{ user: User; matrixUserId: string }> = [];
  for (const user of users) {
    if (seen.has(user.handle)) continue;
    seen.add(user.handle);

    const matrixUserId = getVerifiedLinkedPlatformUserId(user, 'matrix');
    if (!matrixUserId) {
      console.log(`[Cron] Skipping Matrix digest for @${user.handle}: no verified linked Matrix account`);
      continue;
    }

    recipients.push({ user, matrixUserId });
  }

  return recipients;
}

export async function sendPersonalizedDigests(
  storage: Storage,
  opts?: { handles?: string[]; force?: boolean },
): Promise<{ sent: number; failed: number; skipped: number }> {
  let sent = 0;
  let failed = 0;
  let skipped = 0;

  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) {
    console.log('[Cron] Skipping Matrix personalized digests: Matrix platform not connected');
    return { sent, failed, skipped };
  }

  const recipients = await getMatrixDigestRecipients(storage, opts?.handles);
  if (recipients.length === 0) {
    console.log('[Cron] Skipping Matrix personalized digests: no verified linked Matrix recipients');
    return { sent, failed, skipped };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('[Cron] Skipping Matrix personalized digests: ANTHROPIC_API_KEY is not configured');
    return { sent, failed, skipped: skipped + recipients.length };
  }
  const anthropic = new Anthropic({ apiKey });

  const yesterday = getYesterdayUtcDate();
  const { start: startOfDay, end: endOfDay } = getUtcDayRange(yesterday);
  const allEntries = await storage.getEntriesSince(startOfDay, 500);
  const yesterdayEntries = allEntries.filter(e =>
    e.timestamp >= startOfDay && e.timestamp < endOfDay && isPublicDigestEntry(e)
  );

  for (const { user, matrixUserId } of recipients) {
    const handle = user.handle;
    try {
      const following = user.following || [];
      const followingHandles = new Set(following.map(f => normalizeHandle(f.handle)));
      const recentUserEntries = await storage.getEntriesByHandle(handle, 50);
      const addressedEntries = await storage.getEntriesAddressedTo(handle, user.email, 20)
        .catch(() => [] as JournalEntry[]);
      const publicMatrixMessages = await queryMatrixDigestMessages(matrix, {
        since: startOfDay,
        until: endOfDay,
        limit: 80,
        viewerUserId: matrixUserId,
      });
      const recipientDmMessages = await queryMatrixDigestMessages(matrix, {
        since: startOfDay,
        until: endOfDay,
        limit: 25,
        includeDMs: true,
        onlyDMs: true,
        viewerUserId: matrixUserId,
      });
      const matrixMessages = [
        ...publicMatrixMessages,
        ...recipientDmMessages,
      ].sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);

      const followedEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && followingHandles.has(normalizeHandle(e.handle))
      );
      const discoveryEntries = yesterdayEntries.filter(e =>
        e.handle && e.handle !== handle && !followingHandles.has(normalizeHandle(e.handle))
      );
      const ownYesterdayEntries = yesterdayEntries.filter(e => e.handle === handle);

      const hasDigestContext =
        recentUserEntries.length > 0
        || addressedEntries.length > 0
        || ownYesterdayEntries.length > 0
        || followedEntries.length > 0
        || discoveryEntries.length > 0
        || matrixMessages.length > 0;

      if (!hasDigestContext && !opts?.force) {
        console.log(`[Cron] Skipping Matrix digest for @${handle}: no notebook context available`);
        skipped++;
        continue;
      }

      const personContext = [
        `Recipient: @${handle}${user.displayName ? ` (${user.displayName})` : ''}`,
        user.bio ? `Bio: ${user.bio}` : '',
        following.length > 0
          ? `Follows:\n${following.map(f => `@${f.handle}${f.note ? ` - ${f.note}` : ''}`).join('\n')}`
          : 'Follows: nobody yet',
      ].filter(Boolean).join('\n\n');

      const entrySummaries = [
        recentUserEntries.length > 0
          ? `Recipient's recent notebook corpus:\n${recentUserEntries.slice(0, 25).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        ownYesterdayEntries.length > 0
          ? `Recipient's public entries yesterday:\n${ownYesterdayEntries.slice(0, 5).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        addressedEntries.length > 0
          ? `Entries addressed to recipient:\n${addressedEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        followedEntries.length > 0
          ? `From people they follow yesterday:\n${followedEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 300)).join('\n\n')}`
          : '',
        discoveryEntries.length > 0
          ? `Other public notebook activity yesterday:\n${discoveryEntries.slice(0, 8).map(e => formatEntryForPrompt(e, 260)).join('\n\n')}`
          : '',
        matrixMessages.length > 0
          ? `Matrix conversations yesterday:\n${formatMatrixMessagesForDigestPrompt(matrixMessages, 40)}`
          : '',
      ].filter(Boolean).join('\n\n---\n\n') || 'No public notebook or Matrix activity was available.';

      const response = await anthropic.messages.create({
        model: PERSONALIZED_DIGEST_MODEL,
        max_tokens: 800,
        system: PERSONALIZED_DIGEST_PROMPT,
        messages: [
          {
            role: 'user',
            content: `${personContext}\n\n${yesterdayEntries.length} public entries and ${matrixMessages.length} Matrix messages yesterday (${yesterday}).\n\n${entrySummaries}`,
          },
        ],
      });

      const text = response.content.find(b => b.type === 'text');
      if (!text) {
        console.log(`[Cron] Skipping Matrix digest for @${handle}: Claude returned no text`);
        skipped++;
        continue;
      }
      const digestContent = (text as Anthropic.TextBlock).text;

      await matrix.sendDM(matrixUserId, `📰 Your daily digest\n\n${digestContent}`);
      console.log(`[Cron] Sent personalized digest to @${handle}`);
      sent++;
    } catch (err) {
      console.error(`[Cron] Failed personalized digest for @${handle}:`, err);
      failed++;
    }
  }

  return { sent, failed, skipped };
}

// ── Channel Room Initialization ──────────────────────────────

/**
 * Ensure all existing Router channels have corresponding Matrix rooms.
 * Called on server startup.
 */
export async function initializeChannelRooms(storage: Storage): Promise<void> {
  const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
  if (!matrix) return;

  try {
    const channels = await storage.listChannels();
    for (const channel of channels) {
      try {
        await matrix.ensureChannelRoom(channel.id, channel.name, channel.description);
      } catch (err) {
        console.error(`[Cron] Failed to create room for #${channel.id}:`, err);
      }
    }

    // Always ensure the public firehose room and #digest exist
    await matrix.ensureChannelRoom('bot-noise', 'Bot Noise', 'Router firehose for public notebook entries');
    await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');

    console.log(`[Cron] Channel rooms initialized (${channels.length} channels + bot-noise + digest)`);
  } catch (err) {
    console.error('[Cron] Failed to initialize channel rooms:', err);
  }
}

// ── Cron Scheduler ───────────────────────────────────────────

let digestInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Start the cron scheduler.
 */
export function startCronJobs(storage: Storage): void {
  // Initialize channel rooms immediately
  initializeChannelRooms(storage).catch(err => {
    console.error('[Cron] Channel room init failed:', err);
  });

  // Run digest check every hour — only actually generates once per day
  let lastDigestDate = '';
  digestInterval = setInterval(async () => {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const hour = now.getUTCHours();

    // Generate digest at 8am UTC if we haven't already today
    if (hour === 8 && todayStr !== lastDigestDate) {
      lastDigestDate = todayStr;
      await generateDailyDigest(storage).catch(err => {
        console.error('[Cron] Global digest failed:', err);
      });
      // Send personalized digests to each user via Matrix DM
      await sendPersonalizedDigests(storage).catch(err => {
        console.error('[Cron] Personalized digests failed:', err);
      });
    }
  }, 60 * 60 * 1000); // Check every hour

  console.log('[Cron] Scheduled: daily digest at 8am UTC');
}

export function stopCronJobs(): void {
  if (digestInterval) {
    clearInterval(digestInterval);
    digestInterval = null;
  }
}
