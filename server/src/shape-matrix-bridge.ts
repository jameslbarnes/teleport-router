/**
 * Shape Rotator Matrix -> private Router bridge.
 *
 * This is intentionally a standalone process: it reuses teleport-router's
 * Matrix transport/E2EE implementation, but all notebook reads/writes go to
 * the private router-teamwork instance over HTTP/MCP.
 */

import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getEventsSince, getLatestCursor, type RouterEvent } from './events.js';
import { MatrixPlatform, type MatrixHistoryMessage } from './platform/matrix.js';

export type BridgeState = {
  cursor: number;
  initialized: boolean;
  handledMatrixMessageIds?: string[];
  handledOnboardingKeys?: string[];
};

export type PrivateEntry = {
  id: string;
  summary: string;
  content?: string;
  tags: string[];
  publishAt?: number | null;
};

const DEFAULT_SHAPE_ROUTER_URL = 'https://shaperotator.teleport.computer';
const DEFAULT_MATRIX_SERVER_URL = 'https://mtrx.shaperotator.xyz';
const DEFAULT_MATRIX_SPACE_ROOM_ID = '!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g';
const DEFAULT_TAGS = ['shape-rotator', 'matrix'];
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function log(message: string): void {
  console.log(`[shape-matrix-bridge] ${message}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalEnv(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number.parseInt(raw || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

function shapeBaseUrl(): string {
  return optionalEnv('SHAPE_ROUTER_BASE_URL', DEFAULT_SHAPE_ROUTER_URL).replace(/\/$/, '');
}

function matrixServerUrl(): string {
  return (process.env.MATRIX_SERVER_URL?.trim() || process.env.MATRIX_HOMESERVER?.trim() || DEFAULT_MATRIX_SERVER_URL).replace(/\/$/, '');
}

function matrixServerName(serverUrl = matrixServerUrl()): string {
  const explicit = process.env.MATRIX_SERVER_NAME?.trim();
  if (explicit) return explicit;
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return 'mtrx.shaperotator.xyz';
  }
}

function matrixSignupUrl(serverUrl = matrixServerUrl()): string | undefined {
  const explicit = process.env.MATRIX_SIGNUP_URL?.trim();
  if (explicit) return explicit;
  return process.env.MATRIX_REGISTRATION_TOKEN?.trim() ? `${serverUrl}/signup/api` : undefined;
}

export function matrixBotSecretKey(): string | undefined {
  if (process.env.MATRIX_ACCESS_TOKEN?.trim()) return undefined;
  const secret = process.env.MATRIX_BOT_SECRET_KEY?.trim();
  if (secret) return secret;
  throw new Error('MATRIX_BOT_SECRET_KEY is required unless MATRIX_ACCESS_TOKEN is set');
}

function shapeTags(): string[] {
  const raw = process.env.SHAPE_MATRIX_BRIDGE_TAGS || process.env.SHAPE_ROUTER_DEFAULT_TAGS;
  if (!raw) return DEFAULT_TAGS;
  const tags = raw
    .split(',')
    .map(tag => normalizeTag(tag))
    .filter(Boolean);
  return tags.length > 0 ? [...new Set(tags)] : DEFAULT_TAGS;
}

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/[^a-z0-9:_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\//, '') || '';
}

export function stripBotAddressing(text: string): string {
  const botHandle = process.env.MATRIX_BOT_HANDLE || 'router';
  return text
    .replace(new RegExp(`@${escapeRegExp(botHandle)}(?=$|\\s|[)>:.,!?])`, 'gi'), '')
    .replace(/<?@[^\s:>]+:[^\s>]+>?/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function relativeSinceMs(text: string): number {
  const lower = text.toLowerCase();
  const explicit = lower.match(/\b(\d{1,3})\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)\b/);
  if (explicit) {
    const amount = Number.parseInt(explicit[1], 10);
    const unit = explicit[2];
    if (unit.startsWith('m')) return amount * 60 * 1000;
    if (unit.startsWith('h')) return amount * 60 * 60 * 1000;
    if (unit.startsWith('d')) return amount * 24 * 60 * 60 * 1000;
  }
  if (lower.includes('week')) return 7 * 24 * 60 * 60 * 1000;
  if (lower.includes('today')) return 18 * 60 * 60 * 1000;
  return parsePositiveInt('SHAPE_MATRIX_SUMMARY_WINDOW_MS', 24 * 60 * 60 * 1000);
}

async function loadState(path: string): Promise<BridgeState> {
  try {
    const raw = await readFile(path, 'utf8');
    return { ...JSON.parse(raw), initialized: true };
  } catch {
    return { cursor: 0, initialized: false };
  }
}

async function saveState(path: string, state: BridgeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function remember(list: string[] | undefined, value: string, limit: number): string[] {
  const next = Array.isArray(list) ? [...list] : [];
  const existing = next.indexOf(value);
  if (existing >= 0) next.splice(existing, 1);
  next.push(value);
  if (next.length > limit) next.splice(0, next.length - limit);
  return next;
}

export function hasSeenMessage(state: BridgeState, messageId: string | undefined): boolean {
  return !!messageId && Array.isArray(state.handledMatrixMessageIds)
    && state.handledMatrixMessageIds.includes(messageId);
}

export function rememberMessage(state: BridgeState, messageId: string | undefined): void {
  if (!messageId) return;
  state.handledMatrixMessageIds = remember(
    state.handledMatrixMessageIds,
    messageId,
    parsePositiveInt('SHAPE_MATRIX_HANDLED_MESSAGE_LIMIT', 5000),
  );
}

export function initializeRuntimeCursor(state: BridgeState, latestCursor: number): number {
  state.cursor = latestCursor;
  state.initialized = true;
  return latestCursor;
}

function hasSeenOnboarding(state: BridgeState, key: string): boolean {
  return Array.isArray(state.handledOnboardingKeys) && state.handledOnboardingKeys.includes(key);
}

function rememberOnboarding(state: BridgeState, key: string): void {
  state.handledOnboardingKeys = remember(
    state.handledOnboardingKeys,
    key,
    parsePositiveInt('SHAPE_MATRIX_HANDLED_ONBOARDING_LIMIT', 5000),
  );
}

async function shapeFetch(path: string, init: RequestInit = {}): Promise<any> {
  const base = shapeBaseUrl();
  const key = requiredEnv('SHAPE_ROUTER_SECRET_KEY');
  const url = new URL(path, `${base}/`);
  url.searchParams.set('key', key);
  const response = await fetch(url, {
    ...init,
    headers: {
      'User-Agent': 'shape-matrix-bridge/1.0',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await response.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    throw new Error(`${init.method || 'GET'} ${url.pathname} failed ${response.status}: ${detail}`);
  }
  return body;
}

async function configureShapeBotProfile(): Promise<void> {
  if (!parseBool('SHAPE_ROUTER_CONFIGURE_BOT_PROFILE', true)) return;
  const displayName = process.env.SHAPE_ROUTER_BOT_DISPLAY_NAME || 'Shape Matrix Bridge';
  await shapeFetch('/api/users/me', {
    method: 'PATCH',
    body: JSON.stringify({
      displayName,
      stagingDelayMs: parseBool('SHAPE_MATRIX_PUBLISH_IMMEDIATELY', true) ? 0 : undefined,
    }),
  });
  log(`Private Router bot profile checked on ${shapeBaseUrl()}`);
}

async function verifyShapeRouterPrivateAccess(): Promise<void> {
  const me = await shapeFetch('/api/me');
  const handle = me?.user?.handle || me?.handle || 'unknown';
  log(`Private Router auth OK for @${handle}`);

  const tags = await shapeFetch('/api/preset-tags');
  const tagCount = Array.isArray(tags) ? tags.length : 0;
  log(`Private Router preset tags reachable (${tagCount})`);
}

async function createShapeEntry(args: {
  summary: string;
  content: string;
  tags?: string[];
  oneliner?: string;
}): Promise<PrivateEntry> {
  const tags = [...new Set([...(args.tags || []), ...shapeTags()].map(normalizeTag).filter(Boolean))].slice(0, 5);
  const body = {
    summary: truncate(args.summary.trim(), 300),
    content: args.content.trim(),
    tags,
    client: 'code',
    oneliner: args.oneliner ? truncate(args.oneliner, 50) : undefined,
  };

  const created = await shapeFetch('/api/entries', {
    method: 'POST',
    body: JSON.stringify(body),
  }) as { entry: PrivateEntry };

  if (created.entry.publishAt && parseBool('SHAPE_MATRIX_PUBLISH_IMMEDIATELY', true)) {
    await shapeFetch(`/api/entries/${encodeURIComponent(created.entry.id)}/publish`, { method: 'POST' });
    created.entry.publishAt = null;
  }

  return created.entry;
}

async function connectShapeMcp(): Promise<Client | null> {
  if (!parseBool('SHAPE_ROUTER_USE_MCP_SEARCH', true)) return null;
  const url = new URL('/mcp/', shapeBaseUrl());
  url.searchParams.set('key', requiredEnv('SHAPE_ROUTER_SECRET_KEY'));
  const client = new Client({ name: 'shape-matrix-bridge', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(url);
  await client.connect(transport);
  const tools = await client.listTools();
  const names = new Set((tools.tools || []).map(tool => tool.name));
  if (!names.has('router_search')) {
    log('Private MCP connected, but router_search is unavailable; falling back to recent entries');
    await client.close();
    return null;
  }
  log(`Private MCP connected with ${tools.tools.length} tools`);
  return client;
}

async function runPreflight(): Promise<void> {
  log(`Preflight starting for private Router ${shapeBaseUrl()}`);
  await verifyShapeRouterPrivateAccess();
  await configureShapeBotProfile();
  const mcpClient = await connectShapeMcp();
  if (!mcpClient) {
    throw new Error('Private Router MCP router_search is unavailable');
  }
  try {
    await searchShapeRouter(mcpClient, 'shape rotator', 1);
    log('Private Router MCP search OK');
  } finally {
    await mcpClient.close();
  }
}

async function searchShapeRouter(mcpClient: Client | null, query: string, limit = 5): Promise<string> {
  const cleanQuery = query.trim();
  if (!cleanQuery) return 'Give me a search phrase or ask `help` for commands.';

  if (mcpClient) {
    const result = await mcpClient.callTool({
      name: 'router_search',
      arguments: { query: cleanQuery, limit },
    });
    const contentItems = Array.isArray((result as any).content) ? (result as any).content : [];
    return contentItems
      .map((item: any) => item?.type === 'text' ? String(item.text || '') : '')
      .filter(Boolean)
      .join('\n')
      .trim() || 'No results found.';
  }

  const fetchLimit = Math.max(limit, parsePositiveInt('SHAPE_MATRIX_HTTP_SEARCH_POOL_LIMIT', 100));
  const entries = await shapeFetch(`/api/entries?limit=${fetchLimit}`) as { entries?: PrivateEntry[] };
  const lower = cleanQuery.toLowerCase();
  const filtered = (entries.entries || []).filter(entry =>
    [entry.summary, entry.content || '', entry.id, ...(entry.tags || [])].join(' ').toLowerCase().includes(lower),
  );
  if (filtered.length === 0) return 'No results found.';
  return filtered
    .slice(0, limit)
    .map(entry => `[${entry.id}] ${entry.summary}\nTags: ${entry.tags.map(tag => `#${tag}`).join(' ')}`)
    .join('\n\n');
}

export function matrixMessageLine(message: MatrixHistoryMessage): string {
  const who = message.senderHandle ? `@${message.senderHandle}` : message.senderId;
  const ts = new Date(message.timestamp).toISOString();
  return `- ${ts} ${who}: ${message.text.replace(/\s+/g, ' ').trim()}`;
}

function extractAnthropicText(response: Awaited<ReturnType<Anthropic['messages']['create']>>): string {
  const content = Array.isArray((response as any).content) ? (response as any).content : [];
  return content
    .map((block: any) => block?.type === 'text' ? String(block.text || '') : '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function summarizeWithClaude(messages: MatrixHistoryMessage[], windowMs: number): Promise<string | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || messages.length === 0) return null;

  const hours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)));
  const transcript = messages.slice(-80).map(matrixMessageLine).join('\n');
  const anthropic = new Anthropic({ apiKey });
  const response = await anthropic.messages.create({
    model: process.env.SHAPE_MATRIX_SUMMARY_MODEL || 'claude-sonnet-4-6',
    max_tokens: parsePositiveInt('SHAPE_MATRIX_SUMMARY_MAX_TOKENS', 700),
    messages: [{
      role: 'user',
      content: [
        `Summarize this Shape Rotator Matrix room activity from the last ${hours}h.`,
        '',
        'Write concise private-router notes with:',
        '- TL;DR',
        '- Decisions / updates',
        '- Open questions / asks',
        '- Follow-ups',
        '',
        'Do not invent facts. If the transcript is thin, say so.',
        '',
        transcript,
      ].join('\n'),
    }],
  });

  return extractAnthropicText(response) || null;
}

export async function buildRoomSummary(messages: MatrixHistoryMessage[], windowMs: number): Promise<{ summary: string; content: string }> {
  const chronological = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const participants = [...new Set(chronological.map(message =>
    message.senderHandle ? `@${message.senderHandle}` : message.senderId,
  ))];
  const hours = Math.max(1, Math.round(windowMs / (60 * 60 * 1000)));
  const roomName = chronological[0]?.roomName || messages[0]?.roomName || 'Matrix room';
  const llmSummary = await summarizeWithClaude(chronological, windowMs).catch(error => {
    log(`LLM room summary failed, falling back to extractive capture: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const summary = messages.length === 0
    ? `No Matrix messages found in ${roomName} over the last ${hours}h.`
    : llmSummary
      ? `Summarized ${messages.length} Matrix messages from ${participants.length} participant${participants.length === 1 ? '' : 's'} in ${roomName} over the last ${hours}h.`
      : `Captured ${messages.length} Matrix messages from ${participants.length} participant${participants.length === 1 ? '' : 's'} in ${roomName} over the last ${hours}h.`;

  const content = [
    `> Source: Matrix room "${roomName}"`,
    `> Window: last ${hours}h`,
    `> Captured by: Shape Matrix Bridge`,
    `> Participants: ${participants.join(', ') || '(none)'}`,
    '',
    llmSummary ? '## Summary' : '## Recent Matrix Context',
    '',
    llmSummary || (
      chronological.length > 0
        ? chronological.slice(-80).map(matrixMessageLine).join('\n')
        : '_No messages available to the bridge for this window._'
    ),
    '',
    ...(llmSummary ? [
      '## Source Messages',
      '',
      chronological.slice(-80).map(matrixMessageLine).join('\n'),
    ] : []),
  ].join('\n');

  return { summary, content };
}

export function buildProvenanceContent(event: RouterEvent, body: string): string {
  const data = event.data || {};
  const sender = data.sender_handle ? `@${data.sender_handle}` : data.sender_id || 'unknown';
  return [
    `> Source: Matrix ${data.is_dm ? 'DM' : 'room'}`,
    `> Room ID: ${data.room_id || 'unknown'}`,
    `> Matrix event: ${data.message_id || 'unknown'}`,
    `> Organizer: ${sender}`,
    `> Captured at: ${new Date().toISOString()}`,
    '',
    body,
  ].join('\n');
}

async function sendReply(matrix: MatrixPlatform, event: RouterEvent, text: string): Promise<void> {
  const roomId = String(event.data?.room_id || '');
  if (!roomId) return;
  await matrix.sendMessage(roomId, truncate(text, matrix.maxMessageLength), {
    replyTo: event.data?.message_id,
    format: 'markdown',
  });
}

async function handleOnboarding(matrix: MatrixPlatform, event: RouterEvent): Promise<void> {
  const userId = String(event.data?.platform_user_id || '');
  if (!userId) return;
  const text = [
    'Welcome to Shape Rotator Router.',
    '',
    `The private Router is at ${shapeBaseUrl()}. It is separate from the public Router.`,
    '',
    'Ask an organizer for a Shape Router invite, then use the setup page or CLI:',
    `${shapeBaseUrl()}/setup`,
    '',
    'After you have a Router key, the Matrix bridge can save room summaries and search the private Shape notebook from Matrix.',
  ].join('\n');
  await matrix.sendDM(userId, text, { format: 'markdown' });
}

export async function handleMention(matrix: MatrixPlatform, mcpClient: Client | null, event: RouterEvent): Promise<void> {
  const data = event.data || {};
  const roomId = String(data.room_id || '');
  const text = stripBotAddressing(String(data.text || ''));
  const command = firstWord(text);

  if (!roomId || !text) return;

  if (command === 'help') {
    await sendReply(matrix, event, [
      'Shape Router commands:',
      '',
      '- `search <query>`: search the private Shape Router notebook',
      '- `save <text>` or `sync <text>`: save a Matrix note to the private Router',
      '- `summarize this room [24h|7d]`: save recent Matrix room context to the private Router',
      '- `help`: show this message',
    ].join('\n'));
    return;
  }

  if (command === 'save' || command === 'sync' || command === 'record') {
    const body = text.replace(/^\S+\s*/, '').trim() || String(data.text || '').trim();
    const entry = await createShapeEntry({
      summary: truncate(body.split('\n')[0] || 'Matrix note saved to Shape Router', 300),
      content: buildProvenanceContent(event, body),
      tags: ['matrix-note'],
      oneliner: 'Matrix note',
    });
    await sendReply(matrix, event, `Saved to private Shape Router: ${shapeBaseUrl()}/entry?id=${entry.id}`);
    return;
  }

  if (command === 'summarize' || command === 'summary') {
    const windowMs = relativeSinceMs(text);
    const messages = await matrix.queryRecentMessages({
      roomIds: [roomId],
      since: Date.now() - windowMs,
      limit: parsePositiveInt('SHAPE_MATRIX_SUMMARY_MESSAGE_LIMIT', 80),
      perRoomLimit: parsePositiveInt('SHAPE_MATRIX_SUMMARY_MESSAGE_LIMIT', 80),
      includeDMs: !!data.is_dm,
      viewerUserId: data.sender_id,
    });
    const built = await buildRoomSummary(messages, windowMs);
    const entry = await createShapeEntry({
      summary: built.summary,
      content: [
        buildProvenanceContent(event, built.content),
      ].join('\n'),
      tags: ['matrix-summary'],
      oneliner: 'Matrix summary',
    });
    await sendReply(matrix, event, `Saved Matrix room context to private Shape Router: ${shapeBaseUrl()}/entry?id=${entry.id}`);
    return;
  }

  const query = command === 'search'
    ? text.replace(/^\S+\s*/, '').trim()
    : text;
  if (query.length < 3) {
    await sendReply(matrix, event, 'Ask `help`, `search <query>`, or `summarize this room`.');
    return;
  }

  const results = await searchShapeRouter(mcpClient, query, parsePositiveInt('SHAPE_MATRIX_SEARCH_LIMIT', 5));
  await sendReply(matrix, event, `Private Shape Router search results:\n\n${truncate(results, 3500)}`);
}

async function main(): Promise<void> {
  const homeserverUrl = matrixServerUrl();
  const ignoreMessagesBefore = Date.now() - parsePositiveInt('SHAPE_MATRIX_STARTUP_EVENT_GRACE_MS', 5000);
  const matrix = new MatrixPlatform({
    serverUrl: homeserverUrl,
    serverName: matrixServerName(homeserverUrl),
    botSecretKey: matrixBotSecretKey(),
    accessToken: process.env.MATRIX_ACCESS_TOKEN?.trim() || undefined,
    userId: process.env.MATRIX_USER_ID?.trim() || undefined,
    deviceId: process.env.MATRIX_DEVICE_ID?.trim() || undefined,
    cryptoSecret: process.env.MATRIX_CRYPTO_SECRET?.trim() || undefined,
    botHandle: optionalEnv('MATRIX_BOT_HANDLE', 'router'),
    spaceRoomId: process.env.MATRIX_SPACE_ROOM_ID || DEFAULT_MATRIX_SPACE_ROOM_ID,
    registrationToken: process.env.MATRIX_REGISTRATION_TOKEN,
    signupUrl: matrixSignupUrl(homeserverUrl),
    ignoreMessagesBefore,
  });

  log(`Starting Matrix bridge for private Router ${shapeBaseUrl()}`);
  await verifyShapeRouterPrivateAccess();
  await configureShapeBotProfile();
  const mcpClient = await connectShapeMcp().catch(error => {
    log(`Private MCP search unavailable: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });

  const statePath = process.env.SHAPE_MATRIX_BRIDGE_STATE_PATH || '/data/shape-matrix-bridge-state.json';
  const state = await loadState(statePath);
  const hadSavedState = state.initialized;
  let cursor = initializeRuntimeCursor(state, getLatestCursor());
  await saveState(statePath, state);
  log(
    hadSavedState
      ? `Loaded duplicate-prevention state; starting from current Matrix event cursor ${cursor}`
      : `No saved state; starting from latest Matrix event cursor ${cursor}`,
  );

  let shuttingDown = false;
  const enableOnboarding = parseBool('SHAPE_MATRIX_ENABLE_ONBOARDING', false);
  const requestShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Received ${signal}; stopping Matrix bridge`);
  };
  const onSigterm = () => requestShutdown('SIGTERM');
  const onSigint = () => requestShutdown('SIGINT');
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT', onSigint);

  try {
    await matrix.start();

    const pollMs = parsePositiveInt('SHAPE_MATRIX_BRIDGE_POLL_MS', 1000);
    while (!shuttingDown) {
      const events = getEventsSince(cursor, 100);
      for (const event of events) {
        try {
          if (enableOnboarding && event.type === 'platform_onboarding' && event.data?.platform === 'matrix') {
            const key = `${event.data.platform_user_id || ''}:${event.data.reason || 'onboarding'}`;
            if (!hasSeenOnboarding(state, key)) {
              await handleOnboarding(matrix, event);
              rememberOnboarding(state, key);
            }
          }

          if (event.type === 'platform_mention' && event.data?.platform === 'matrix') {
            const messageId = typeof event.data.message_id === 'string' ? event.data.message_id : undefined;
            if (!hasSeenMessage(state, messageId)) {
              await handleMention(matrix, mcpClient, event);
              rememberMessage(state, messageId);
            }
          }
        } catch (error) {
          log(`Failed to handle event ${event.id}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        } finally {
          cursor = event.id;
          state.cursor = cursor;
          await saveState(statePath, state);
        }
      }
      if (!shuttingDown) await sleep(pollMs);
    }
  } finally {
    process.off('SIGTERM', onSigterm);
    process.off('SIGINT', onSigint);
    await mcpClient?.close().catch(error => {
      log(`Private MCP close failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await matrix.stop().catch(error => {
      log(`Matrix stop failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    await saveState(statePath, state).catch(error => {
      log(`Final state save failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    log('Matrix bridge stopped');
  }
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isEntrypoint) {
  const run = process.argv.includes('--preflight') || parseBool('SHAPE_MATRIX_BRIDGE_PREFLIGHT', false)
    ? runPreflight
    : main;

  run()
    .then(() => process.exit(0))
    .catch(error => {
      console.error(error);
      process.exit(1);
    });
}
