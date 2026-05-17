/**
 * Matrix Platform Plugin with E2EE
 *
 * Implements the Platform interface using matrix-js-sdk with Rust crypto.
 * The bot authenticates with credentials derived from a Router secret key
 * and participates in encrypted rooms.
 *
 * Key lessons from Andrew's shape-rotator-matrix work:
 * - Crypto store must be persistent and created in-place (never copy)
 * - Trust relaxation: accept unverified devices or messages fail silently
 * - Send a wake message after joining encrypted rooms (Element withholds keys otherwise)
 * - Cross-signing requires password UIA
 */

import { createHmac } from 'crypto';
import { deflateSync } from 'zlib';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import {
  createClient,
  type MatrixClient,
  type ICreateClientOpts,
  type Room,
  type MatrixEvent,
  MatrixEventEvent,
  EventType,
  RelationType,
  MsgType,
  RoomMemberEvent,
  RoomEvent,
  ClientEvent,
  KnownMembership,
  Preset,
  Visibility,
} from 'matrix-js-sdk';
import type {
  Platform,
  PlatformRoom,
  PlatformMessage,
  PlatformIdentity,
  SendMessageOptions,
  CreateRoomOptions,
  RoomType,
} from './types.js';
import { pushEvent } from '../events.js';
import { SASVerificationManager } from './sas-verification.js';

// Polyfill IndexedDB for Node.js (required by matrix-sdk-crypto-wasm)
import 'fake-indexeddb/auto';
import {
  restoreCryptoStore,
  resetCryptoStoreSnapshot,
  startPersisting,
  flushCryptoStore,
  stopPersisting,
} from './crypto-store-persist.js';

export interface MatrixPlatformConfig {
  serverUrl: string;
  serverName: string;
  botSecretKey?: string;
  accessToken?: string;
  userId?: string;
  deviceId?: string;
  cryptoSecret?: string;
  botHandle: string;
  spaceRoomId?: string;
  registrationToken?: string;
  /** Signup wrapper URL (e.g. Shape Rotator's /signup/api). If set, registration
   *  uses this wrapper instead of the native Matrix registration endpoint. */
  signupUrl?: string;
  cryptoStoreName?: string;
  cryptoStorePassword?: string;
  baseUrl?: string;
  ignoreMessagesBefore?: number;
  resolveLinkedPlatformId?: (platform: string, routerHandle: string) => Promise<string | null>;
  resolveLinkedRouterHandle?: (platform: string, platformUserId: string) => Promise<string | null>;
}

export interface MatrixHistoryMessage {
  roomId: string;
  roomName: string;
  roomAlias?: string | null;
  eventId?: string;
  senderId: string;
  senderHandle?: string | null;
  text: string;
  timestamp: number;
  isDM: boolean;
  permalink?: string;
}

export interface MatrixHistoryQueryOptions {
  query?: string;
  since?: number;
  until?: number;
  limit?: number;
  includeDMs?: boolean;
  onlyDMs?: boolean;
  viewerUserId?: string;
  spaceOnly?: boolean;
  roomIds?: string[];
  perRoomLimit?: number;
  botScope?: boolean;
}

export function deriveMatrixBotPassword(config: Pick<MatrixPlatformConfig, 'accessToken' | 'botSecretKey' | 'serverName'>): string | null {
  if (config.accessToken?.trim()) return null;
  return config.botSecretKey
    ? createHmac('sha256', config.botSecretKey)
      .update(`matrix:${config.serverName}`)
      .digest('base64url')
    : null;
}

// Custom Matrix event types for tight notebook integration
export const ROUTER_ENTRY_EVENT = 'com.router.entry';
export const ROUTER_SPARK_EVENT = 'com.router.spark';
export const ROUTER_DIGEST_EVENT = 'com.router.digest';
export const ROUTER_CHANNEL_STATE = 'com.router.channel';

const MATRIX_AGENT_TRIGGER_REACTION_EMOJI = process.env.MATRIX_AGENT_TRIGGER_REACTION_EMOJI || '🪩';

const ROUTER_DISCO_AVATAR_FILENAME = 'matrix-router-disco-avatar-mxc.txt';

const pngCrcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function pngCrc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = pngCrcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(pngCrc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const rawOffset = y * (width * 4 + 1);
    raw[rawOffset] = 0;
    rgba.copy(raw, rawOffset + 1, y * width * 4, (y + 1) * width * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function blendPixel(rgba: Buffer, width: number, x: number, y: number, color: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= width || y >= width) return;
  const idx = (y * width + x) * 4;
  const alpha = color[3] / 255;
  const inv = 1 - alpha;
  rgba[idx] = Math.round(color[0] * alpha + rgba[idx] * inv);
  rgba[idx + 1] = Math.round(color[1] * alpha + rgba[idx + 1] * inv);
  rgba[idx + 2] = Math.round(color[2] * alpha + rgba[idx + 2] * inv);
  rgba[idx + 3] = Math.min(255, Math.round(color[3] + rgba[idx + 3] * inv));
}

function drawSparkle(rgba: Buffer, width: number, cx: number, cy: number, radius: number): void {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const dx = Math.abs(x - cx);
      const dy = Math.abs(y - cy);
      const dist = dx + dy;
      if (dist > radius) continue;
      const a = Math.round(230 * (1 - dist / (radius + 1)));
      if (dx <= 1 || dy <= 1 || dx === dy) {
        blendPixel(rgba, width, x, y, [255, 250, 210, a]);
      }
    }
  }
}

export function buildRouterDiscoBallAvatarPng(size = 256): Buffer {
  const rgba = Buffer.alloc(size * size * 4);
  const center = size / 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center;
      const dy = y - center;
      const d = Math.sqrt(dx * dx + dy * dy);
      const idx = (y * size + x) * 4;
      const shade = Math.max(0, 1 - d / (size * 0.72));
      rgba[idx] = Math.round(20 + shade * 34);
      rgba[idx + 1] = Math.round(22 + shade * 30);
      rgba[idx + 2] = Math.round(40 + shade * 60);
      rgba[idx + 3] = 255;
    }
  }

  const ballCx = center;
  const ballCy = Math.round(size * 0.48);
  const radius = size * 0.31;
  for (let y = Math.floor(ballCy - radius); y <= Math.ceil(ballCy + radius); y++) {
    for (let x = Math.floor(ballCx - radius); x <= Math.ceil(ballCx + radius); x++) {
      const nx = (x - ballCx) / radius;
      const ny = (y - ballCy) / radius;
      const r2 = nx * nx + ny * ny;
      if (r2 > 1) continue;

      const nz = Math.sqrt(1 - r2);
      const tileX = Math.floor((nx + 1) * 7.5);
      const tileY = Math.floor((ny + 1) * 7.5);
      const seamX = Math.abs(((nx + 1) * 7.5) % 1 - 0.5) > 0.43;
      const seamY = Math.abs(((ny + 1) * 7.5) % 1 - 0.5) > 0.43;
      const checker = (tileX + tileY) % 3;
      const light = Math.max(0, -0.55 * nx - 0.75 * ny + 0.65 * nz);
      const rim = Math.max(0, 1 - nz);
      const highlight = Math.pow(light, 5);

      let r = 126 + 95 * light + (checker === 0 ? 24 : 0) + 48 * highlight;
      let g = 162 + 72 * light + (checker === 1 ? 30 : 0) + 48 * highlight;
      let b = 188 + 56 * light + (checker === 2 ? 44 : 0) + 45 * highlight;

      if (seamX || seamY) {
        r *= 0.42;
        g *= 0.48;
        b *= 0.58;
      }

      r = r * (1 - rim * 0.22) + 160 * rim * 0.22;
      g = g * (1 - rim * 0.22) + 115 * rim * 0.22;
      b = b * (1 - rim * 0.22) + 220 * rim * 0.22;

      const idx = (y * size + x) * 4;
      rgba[idx] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[idx + 3] = 255;
    }
  }

  const stringX = Math.round(center);
  for (let y = 0; y < ballCy - radius + 7; y++) {
    blendPixel(rgba, size, stringX, y, [205, 214, 255, 180]);
  }

  drawSparkle(rgba, size, Math.round(size * 0.29), Math.round(size * 0.25), 13);
  drawSparkle(rgba, size, Math.round(size * 0.75), Math.round(size * 0.33), 10);
  drawSparkle(rgba, size, Math.round(size * 0.69), Math.round(size * 0.71), 8);

  return encodePng(size, size, rgba);
}

const matrixMarkdown = new MarkdownIt({
  breaks: true,
  html: false,
  linkify: true,
  typographer: false,
});

const MATRIX_ALLOWED_HTML_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'div',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
];

const MATRIX_ALLOWED_HTML_ATTRIBUTES = {
  a: ['href', 'name', 'target', 'rel'],
  code: ['class'],
  ol: ['start'],
  span: ['data-mx-bg-color', 'data-mx-color'],
  '*': ['data-mx-bg-color', 'data-mx-color'],
};

const MATRIX_ALLOWED_URL_SCHEMES = ['http', 'https', 'mailto', 'matrix'];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isMatrixUserId(value: string): boolean {
  return /^@[^:\s]+:[^:\s]+$/.test(value);
}

function sameMatrixRoomId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.split(':', 1)[0] === b.split(':', 1)[0];
}

function normalizeRouterHandle(value: string | undefined | null): string | null {
  const normalized = value?.replace(/^@/, '').trim().toLowerCase();
  return normalized || null;
}

type MatrixOnboardingStatus = 'queued' | 'sent' | 'skipped';

interface MatrixOnboardingRecord {
  status: MatrixOnboardingStatus;
  queuedAt?: number;
  sentAt?: number;
  skippedAt?: number;
  eventId?: number;
  displayName?: string;
  roomId?: string;
  reason?: string;
}

type MatrixOnboardingState = Record<string, MatrixOnboardingRecord>;

export function isMatrixMention(params: {
  isDM: boolean;
  text: string;
  content: Record<string, any>;
  botUserId: string | null;
  botHandle: string;
}): boolean {
  const { isDM, text, content, botUserId, botHandle } = params;

  if (isDM) return true;

  const mentions = content['m.mentions'];
  const mentionedUserIds = Array.isArray(mentions?.user_ids) ? mentions.user_ids : [];
  if (botUserId && mentionedUserIds.includes(botUserId)) {
    return true;
  }

  const formattedBody = typeof content.formatted_body === 'string' ? content.formatted_body : '';
  if (botUserId && (formattedBody.includes(botUserId) || formattedBody.includes(encodeURIComponent(botUserId)))) {
    return true;
  }

  const plainMention = new RegExp(`(^|\\s|[<(])@${escapeRegExp(botHandle)}(?=$|\\s|[)>:.,!?])`, 'i');
  return plainMention.test(text);
}

function markdownToMatrixHtml(markdown: string): string {
  const rendered = matrixMarkdown.render(markdown).trim();
  return sanitizeHtml(rendered, {
    allowedTags: MATRIX_ALLOWED_HTML_TAGS,
    allowedAttributes: MATRIX_ALLOWED_HTML_ATTRIBUTES,
    allowedSchemes: MATRIX_ALLOWED_URL_SCHEMES,
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
  });
}

function truncateMatrixEntryDisplay(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) {
    return { text, truncated: false };
  }

  const hardSlice = text.slice(0, maxChars);
  const paragraphBreak = hardSlice.lastIndexOf('\n\n');
  const lineBreak = hardSlice.lastIndexOf('\n');
  const wordBreak = hardSlice.lastIndexOf(' ');
  const boundary = Math.max(paragraphBreak, lineBreak, wordBreak);
  const end = boundary > maxChars * 0.8 ? boundary : maxChars;

  return {
    text: `${text.slice(0, end).trimEnd()}\n\n[truncated - read full entry]`,
    truncated: true,
  };
}

export class MatrixPlatform implements Platform {
  readonly name = 'matrix';
  readonly maxMessageLength = 65536;

  private client: MatrixClient | null = null;
  private botUserId: string | null = null;
  private config: MatrixPlatformConfig;
  private channelRooms = new Map<string, string>();
  private entryEventMap = new Map<string, string>();
  private pendingReviewEventMap = new Map<string, string>();
  private processedMessageEvents = new Set<string>();
  private pendingInviteJoins = new Set<string>();
  private joinedInviteRooms = new Set<string>();

  constructor(config: MatrixPlatformConfig) {
    this.config = config;
  }

  private getOnboardingStatePath(): string {
    return process.env.MATRIX_ONBOARDING_STATE_PATH || '/data/matrix-onboarding-state.json';
  }

  private loadOnboardingState(): MatrixOnboardingState {
    const path = this.getOnboardingStatePath();
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as MatrixOnboardingState;
    } catch (error) {
      console.warn(`[Matrix] Failed to read onboarding state from ${path}:`, error);
      return {};
    }
  }

  private saveOnboardingState(state: MatrixOnboardingState): void {
    const path = this.getOnboardingStatePath();
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  private isOnboardingCandidate(userId: string | null | undefined): userId is string {
    if (!userId || !isMatrixUserId(userId)) return false;
    return userId !== this.botUserId;
  }

  private queueMatrixOnboarding(userId: string, roomId: string, displayName?: string): void {
    const state = this.loadOnboardingState();
    const existing = state[userId];
    if (existing?.status === 'queued' || existing?.status === 'sent' || existing?.status === 'skipped') {
      return;
    }

    const event = pushEvent('platform_onboarding', {
      platform: 'matrix',
      platform_user_id: userId,
      display_name: displayName || undefined,
      space_room_id: this.config.spaceRoomId,
      room_id: roomId,
      reason: 'matrix_space_join',
      timestamp: Date.now(),
    });

    state[userId] = {
      status: 'queued',
      queuedAt: Date.now(),
      eventId: event.id,
      displayName,
      roomId,
      reason: 'matrix_space_join',
    };
    this.saveOnboardingState(state);
    console.log(`[Matrix] Queued Router onboarding for ${userId} from space ${roomId}`);
  }

  private handleSpaceMembershipForOnboarding(event: MatrixEvent, member: any): void {
    if (!this.config.spaceRoomId) return;
    if (member?.membership !== KnownMembership.Join) return;

    const roomId = member?.roomId || event.getRoomId?.();
    if (!sameMatrixRoomId(roomId, this.config.spaceRoomId)) return;

    const userId = member?.userId || event.getStateKey?.();
    if (!this.isOnboardingCandidate(userId)) return;

    const displayName =
      typeof member?.name === 'string' ? member.name :
      typeof member?.rawDisplayName === 'string' ? member.rawDisplayName :
      undefined;
    this.queueMatrixOnboarding(userId, roomId, displayName);
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async start(): Promise<void> {
    // Load any persisted crypto snapshot BEFORE initializing Rust crypto.
    // This restores device keys, cross-signing, Olm/Megolm sessions across
    // restarts — without this, every deploy wipes the bot's identity.
    const snapshotPath = process.env.MATRIX_CRYPTO_SNAPSHOT_PATH || '/data/matrix-crypto-snapshot.json';

    // Escape hatch: MATRIX_FRESH_CRYPTO=1 wipes the snapshot + credentials at
    // every boot. MATRIX_FRESH_CRYPTO=once does it exactly once and records a
    // marker in /data. Use when the local crypto store has drifted from the
    // server's view (symptom: persistent m.mismatched_sas / MAC validation
    // failures even with a clean device list).
    const freshCryptoMode = process.env.MATRIX_FRESH_CRYPTO;
    if (freshCryptoMode === '1' || freshCryptoMode === 'once') {
      const credsPath = process.env.MATRIX_CREDS_PATH || '/data/matrix-credentials.json';
      const onceMarkerPath = process.env.MATRIX_FRESH_CRYPTO_ONCE_MARKER
        || `${dirname(snapshotPath)}/matrix-fresh-crypto.once`;
      const shouldReset = freshCryptoMode === '1' || !existsSync(onceMarkerPath);

      if (shouldReset) {
        for (const p of [snapshotPath, credsPath]) {
          if (existsSync(p)) {
            try {
              const { unlinkSync } = await import('fs');
              unlinkSync(p);
              console.log(`[Matrix] MATRIX_FRESH_CRYPTO=${freshCryptoMode} deleted ${p}`);
            } catch (err: any) {
              console.warn(`[Matrix] Failed to delete ${p}:`, err.message);
            }
          }
        }

        if (freshCryptoMode === 'once') {
          const dir = dirname(onceMarkerPath);
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(onceMarkerPath, JSON.stringify({ reset_at: new Date().toISOString() }), 'utf8');
          console.log(`[Matrix] MATRIX_FRESH_CRYPTO=once marker written: ${onceMarkerPath}`);
        }
      } else {
        console.log(`[Matrix] MATRIX_FRESH_CRYPTO=once already consumed: ${onceMarkerPath}`);
      }
    }

    await restoreCryptoStore({ filePath: snapshotPath });

    const directAccessToken = this.config.accessToken?.trim();
    const password = deriveMatrixBotPassword(this.config);
    const username = this.config.botHandle;

    // Credential persistence: without this, every restart calls /login and
    // gets a fresh device_id, causing:
    //  - a device graveyard on the server (one orphan per restart)
    //  - Element verification requests getting targeted at dead devices
    //  - the crypto snapshot becoming useless (wrong device context)
    const credsPath = process.env.MATRIX_CREDS_PATH || '/data/matrix-credentials.json';

    let accessToken: string;
    let userId: string;
    let deviceId: string;

    if (directAccessToken) {
      const provided = await this.credentialsFromAccessToken(directAccessToken);
      accessToken = provided.access_token;
      userId = this.config.userId || provided.user_id;
      deviceId = this.config.deviceId || provided.device_id;
      console.log(`[Matrix] Using provided access token, device=${deviceId}`);
    } else {
      if (!password) throw new Error('Matrix botSecretKey or accessToken is required');
      const existingCreds = this.loadCredentials(credsPath);
      if (existingCreds && await this.validateCredentials(existingCreds)) {
        console.log(`[Matrix] Reusing persisted credentials, device=${existingCreds.device_id}`);
        accessToken = existingCreds.access_token;
        userId = existingCreds.user_id;
        deviceId = existingCreds.device_id;
      } else {
        try {
          const fresh = await this.obtainFreshCredentials(username, password);
          accessToken = fresh.access_token;
          userId = fresh.user_id;
          deviceId = fresh.device_id;
          this.saveCredentials(credsPath, fresh);
          console.log(`[Matrix] Obtained fresh credentials, device=${deviceId}`);
        } catch (e: any) {
          throw new Error(`Matrix auth failed: ${e.message}`);
        }
      }
    }

    this.botUserId = userId;

    // Crypto callbacks — getSecretStorageKey is called when SSSS needs to unlock
    // a secret. We derive keys from the bot's Router secret key.
    const stableSecret = this.config.cryptoSecret || directAccessToken || this.config.botSecretKey;
    if (!stableSecret) throw new Error('Matrix cryptoSecret, botSecretKey, or accessToken is required');
    const cryptoCallbacks: any = {
      getSecretStorageKey: async ({ keys }: { keys: Record<string, any> }): Promise<[string, Uint8Array] | null> => {
        const keyIds = Object.keys(keys);
        if (keyIds.length === 0) return null;
        // For bootstrap flow — the recovery key was created from stableSecret.
        // Return the first key ID with a derived 32-byte key.
        const raw = new TextEncoder().encode(`router-ssss-${stableSecret}`);
        const hashed = new Uint8Array(32);
        for (let i = 0; i < 32; i++) hashed[i] = raw[i % raw.length] ^ (i * 31);
        return [keyIds[0], hashed];
      },
    };

    const clientOpts: ICreateClientOpts = {
      baseUrl: this.config.serverUrl,
      userId,
      deviceId,
      accessToken,
      cryptoCallbacks,
    };

    this.client = createClient(clientOpts);
    await this.syncBotAccountProfile(`${dirname(credsPath)}/${ROUTER_DISCO_AVATAR_FILENAME}`);

    // Initialize Rust crypto
    try {
      const storeName = this.config.cryptoStoreName || `router-crypto-${this.config.botHandle}`;
      const cryptoInitOpts = {
        useIndexedDB: true,
        cryptoDatabasePrefix: storeName,
        storagePassword: this.config.cryptoStorePassword || `${userId}:${deviceId}`,
      };

      try {
        await this.client.initRustCrypto(cryptoInitOpts);
      } catch (err: any) {
        // Snapshots written by the old post-init restore path can be internally
        // inconsistent: the meta store decrypts, but encrypted records were
        // written under a different store cipher. The failed Rust open can keep
        // IndexedDB handles alive, so repair by quarantining the snapshot and
        // exiting. Docker/Phala restarts the service into a clean process.
        const message = err?.message || '';
        const isUnusableSnapshot =
          message.includes('failed to be decrypted')
          || message.includes('unpickling')
          || message.includes('pickle');
        if (!isUnusableSnapshot) throw err;

        console.warn(`[Matrix] Crypto store snapshot unusable, resetting before process restart: ${message}`);
        await resetCryptoStoreSnapshot(snapshotPath, storeName);
        console.warn('[Matrix] Exiting so rust-crypto restarts with clean IndexedDB handles');
        process.exit(1);
      }

      console.log('[Matrix] Rust crypto initialized');
      const ownKeys = await this.client.getCrypto()?.getOwnDeviceKeys();
      console.log(`[Matrix] Own device keys: device=${deviceId} ed25519=${ownKeys?.ed25519 || 'unavailable'}`);

      // Start periodic persistence so state survives the next restart
      startPersisting({ filePath: snapshotPath, flushIntervalMs: 30_000 });
      await flushCryptoStore();
    } catch (e: any) {
      console.warn('[Matrix] Crypto init failed, running without E2EE:', e.message);
    }

    // Set up event listeners (messages, invites)
    this.setupEventListeners();

    // Start syncing (must happen before cross-signing bootstrap so we can query our own keys)
    await this.client.startClient({ initialSyncLimit: 0 });

    // Install the hand-rolled SAS verification manager. Replaces the SDK's
    // broken VerificationRequest/Verifier high-level API which produces MACs
    // that Continuwuity rejects with m.mismatched_sas. Ports Andrew Miller's
    // sas_verification.py working implementation. Must happen AFTER
    // startClient (needs user/device/crypto to be populated).
    try {
      await SASVerificationManager.create(this.client);
    } catch (err: any) {
      console.warn('[Matrix] SAS manager init failed (non-fatal):', err.message);
    }

    // Bootstrap cross-signing and secret storage — makes the bot a first-class
    // Matrix citizen that Element clients trust like any other verified user.
    // This is a one-time operation; subsequent startups find existing keys.
    if (password) {
      this.bootstrapCryptoIdentity(username, password).catch(err => {
        console.warn('[Matrix] Cross-signing bootstrap failed (non-fatal):', err.message);
      });
    } else {
      console.log('[Matrix] Skipping password-based cross-signing bootstrap in access-token mode');
    }

    // Delete orphan devices from prior restarts — before credential persistence
    // landed, every restart created a new device. Element caches all of them
    // and gets confused during verification (MAC verification mismatch), which
    // shows up as m.mismatched_sas cancels.
    //
    // MUST complete before start() returns, otherwise clients verifying the
    // bot right after boot will still see the ghost devices in their cached
    // device list and SAS MAC validation will fail against phantoms.
    if (password) {
      try {
        await this.cleanupOrphanDevices(userId, deviceId, accessToken, username, password);
      } catch (err: any) {
        console.warn('[Matrix] Orphan device cleanup failed (non-fatal):', err.message);
      }
    } else {
      console.log('[Matrix] Skipping password-based orphan device cleanup in access-token mode');
    }

    console.log(`[Matrix] Authenticated as ${userId}, syncing...`);

    // Wait for first sync
    await new Promise<void>((resolve) => {
      this.client!.once(ClientEvent.Sync, (state: string) => {
        if (state === 'PREPARED' || state === 'SYNCING') {
          console.log('[Matrix] Initial sync complete');
          resolve();
        }
      });
    });

    await this.joinPendingInvitedRooms('initial sync');
  }

  async stop(): Promise<void> {
    // Flush crypto state to disk before shutting down
    try {
      stopPersisting();
      await flushCryptoStore();
    } catch (err: any) {
      console.warn('[Matrix] Final crypto flush failed:', err.message);
    }
    if (this.client) {
      this.client.stopClient();
      this.client = null;
    }
  }

  // ── Credential persistence ────────────────────────────────

  private loadCredentials(path: string): { access_token: string; user_id: string; device_id: string } | null {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return null;
    }
  }

  private saveCredentials(path: string, creds: { access_token: string; user_id: string; device_id: string }): void {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(creds), 'utf8');
  }

  /** Verify an access token is still valid by hitting /account/whoami. */
  private async validateCredentials(creds: { access_token: string; user_id: string; device_id: string }): Promise<boolean> {
    try {
      const resp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/account/whoami`, {
        headers: { 'Authorization': `Bearer ${creds.access_token}` },
      });
      if (!resp.ok) return false;
      const data = await resp.json() as any;
      return data.user_id === creds.user_id && data.device_id === creds.device_id;
    } catch {
      return false;
    }
  }

  /** Validate an externally provisioned Matrix access token. */
  private async credentialsFromAccessToken(accessToken: string): Promise<{ access_token: string; user_id: string; device_id: string }> {
    const resp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/account/whoami`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    const data = await resp.json().catch(() => null) as any;
    if (!resp.ok) {
      throw new Error(`Matrix access token whoami failed: ${resp.status} ${data?.error || JSON.stringify(data)}`);
    }
    const userId = this.config.userId || data?.user_id;
    const deviceId = this.config.deviceId || data?.device_id;
    if (!userId) throw new Error('Matrix access token did not return user_id; set MATRIX_USER_ID');
    if (!deviceId) throw new Error('Matrix access token did not return device_id; set MATRIX_DEVICE_ID');
    return { access_token: accessToken, user_id: userId, device_id: deviceId };
  }

  /** Run the login / signup / register flow to get fresh credentials. */
  private async obtainFreshCredentials(username: string, password: string): Promise<{ access_token: string; user_id: string; device_id: string }> {
    const loginResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
      }),
    });
    if (loginResp.ok) {
      const data = await loginResp.json() as any;
      return { access_token: data.access_token, user_id: data.user_id, device_id: data.device_id };
    }

    if (this.config.signupUrl && this.config.registrationToken) {
      const signupResp = await fetch(this.config.signupUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: this.config.registrationToken,
          username,
          password,
        }),
      });
      const signupData = await signupResp.json() as any;
      if (!signupResp.ok) {
        throw new Error(`Signup wrapper failed: ${signupData.error || JSON.stringify(signupData)}`);
      }
      return { access_token: signupData.access_token, user_id: signupData.user_id, device_id: signupData.device_id };
    }

    if (!this.config.registrationToken) {
      throw new Error('Bot account does not exist and no registration token provided');
    }

    const initResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const initData = await initResp.json() as any;

    const regResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username, password,
        auth: {
          type: 'm.login.registration_token',
          token: this.config.registrationToken,
          session: initData.session,
        },
      }),
    });
    const regData = await regResp.json() as any;
    if (!regResp.ok) throw new Error(`Registration failed: ${regData.error}`);

    await fetch(`${this.config.serverUrl}/_matrix/client/v3/profile/${regData.user_id}/displayname`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${regData.access_token}` },
      body: JSON.stringify({ displayname: this.config.botHandle }),
    }).catch(() => {});

    return { access_token: regData.access_token, user_id: regData.user_id, device_id: regData.device_id };
  }

  /**
   * Delete all the bot's devices except the currently-active one.
   *
   * Uses POST /delete_devices with UIA password auth in a single call so the
   * server only charges one round-trip for the UIA dance.
   */
  private async cleanupOrphanDevices(
    userId: string,
    currentDeviceId: string,
    accessToken: string,
    username: string,
    password: string,
  ): Promise<void> {
    const listResp = await fetch(`${this.config.serverUrl}/_matrix/client/v3/devices`, {
      headers: { 'Authorization': `Bearer ${accessToken}` },
    });
    if (!listResp.ok) {
      console.warn(`[Matrix] /devices list failed: ${listResp.status}`);
      return;
    }
    const listData = await listResp.json() as any;
    const orphanIds: string[] = (listData.devices || [])
      .map((d: any) => d.device_id)
      .filter((id: string) => id && id !== currentDeviceId);

    if (orphanIds.length === 0) {
      console.log('[Matrix] No orphan devices to clean up');
      return;
    }
    console.log(`[Matrix] Cleaning up ${orphanIds.length} orphan devices: ${orphanIds.join(',')}`);

    // Step 1: probe for UIA session
    const probe = await fetch(`${this.config.serverUrl}/_matrix/client/v3/delete_devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({ devices: orphanIds }),
    });
    if (probe.ok) {
      console.log('[Matrix] Orphan devices deleted (no UIA required)');
      return;
    }
    const probeData = await probe.json() as any;
    if (probe.status !== 401 || !probeData.session) {
      console.warn(`[Matrix] /delete_devices unexpected response: ${probe.status} ${JSON.stringify(probeData)}`);
      return;
    }

    // Step 2: complete UIA with password
    const doDelete = await fetch(`${this.config.serverUrl}/_matrix/client/v3/delete_devices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
      body: JSON.stringify({
        devices: orphanIds,
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: username },
          password,
          session: probeData.session,
        },
      }),
    });
    if (doDelete.ok) {
      console.log(`[Matrix] Deleted ${orphanIds.length} orphan devices`);
    } else {
      const errData = await doDelete.text();
      console.warn(`[Matrix] /delete_devices UIA step failed: ${doDelete.status} ${errData}`);
    }
  }

  // ── Messaging ──────────────────────────────────────────────

  async sendMessage(roomId: string, text: string, opts?: SendMessageOptions): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const result = await this.client.sendMessage(roomId, await this.createMessageContent(text, opts));
    return result.event_id!;
  }

  async sendDM(userId: string, text: string, opts?: SendMessageOptions): Promise<string> {
    const roomId = await this.findOrCreateDM(userId);
    return this.sendMessage(roomId, text, opts);
  }

  async sendEncryptedDM(userId: string, text: string, opts?: SendMessageOptions): Promise<string> {
    const roomId = await this.findOrCreateEncryptedDM(userId);
    return this.sendMessage(roomId, text, opts);
  }

  async sendPendingEntryReviewDM(userId: string, text: string, entryId: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const roomId = await this.findOrCreateDM(userId);
    const content = await this.createMessageContent(text);
    content.pending_entry_id = entryId;
    content['com.router.pending_entry'] = {
      entry_id: entryId,
      actions: ['publish', 'delete'],
    };

    const result = await this.client.sendMessage(roomId, content);
    const eventId = result.event_id!;
    this.pendingReviewEventMap.set(eventId, entryId);
    return eventId;
  }

  // ── Room Management ────────────────────────────────────────

  async createRoom(name: string, opts: CreateRoomOptions): Promise<PlatformRoom> {
    if (!this.client) throw new Error('Matrix client not started');

    const invite: string[] = [];
    if (opts.invite) {
      for (const recipient of opts.invite) {
        const platformId = isMatrixUserId(recipient)
          ? recipient
          : await this.resolvePlatformId(recipient);
        if (platformId) invite.push(platformId);
      }
    }

    const initialState: any[] = [];
    if (opts.encrypted !== false) {
      initialState.push({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
    }
    if (opts.type === 'channel') {
      initialState.push(...this.getSpaceRestrictedStateEvents().map(event => ({
        type: event.type,
        state_key: '',
        content: event.content,
      })));
    }

    const createOpts: any = {
      name: name || undefined,
      invite,
      preset: opts.type === 'dm' ? Preset.TrustedPrivateChat : Preset.PrivateChat,
      initial_state: initialState,
      is_direct: opts.type === 'dm',
    };

    if (opts.topic) {
      createOpts.topic = opts.topic;
    }

    const result = await this.client.createRoom(createOpts);

    if (opts.attachToSpace || opts.type === 'channel') {
      const label = name || result.room_id;
      await this.ensureSpaceMembership(result.room_id, label);
    }

    // Send wake message in encrypted rooms (Element withholds keys until bot speaks)
    if (opts.encrypted !== false) {
      try {
        await this.client.sendMessage(
          result.room_id,
          await this.createMessageContent(opts.type === 'dm' ? 'Connected.' : name ? `Room "${name}" created.` : 'Connected.'),
        );
      } catch {
        // Non-fatal
      }
    }

    return {
      id: result.room_id,
      name,
      type: opts.type,
      topic: opts.topic,
      platform: 'matrix',
    };
  }

  async inviteToRoom(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.invite(roomId, userId);
  }

  async removeFromRoom(roomId: string, userId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.kick(roomId, userId);
  }

  async setRoomTopic(roomId: string, topic: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.setRoomTopic(roomId, topic);
  }

  async setUserRole(roomId: string, userId: string, role: 'admin' | 'moderator' | 'member'): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    const powerLevel = role === 'admin' ? 100 : role === 'moderator' ? 50 : 0;
    await this.client.setPowerLevel(roomId, userId, powerLevel);
  }

  async deleteMessage(roomId: string, messageId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    await this.client.redactEvent(roomId, messageId);
  }

  // ── Deep Notebook Integration ──────────────────────────────

  private getSpaceRestrictedStateEvents(): Array<{ type: EventType | string; content: Record<string, unknown> }> {
    const joinRule = this.config.spaceRoomId
      ? {
        join_rule: 'restricted',
        allow: [
          {
            type: 'm.room_membership',
            room_id: this.config.spaceRoomId,
          },
        ],
      }
      : { join_rule: 'invite' };

    return [
      {
        type: EventType.RoomJoinRules,
        content: joinRule,
      },
      {
        type: EventType.RoomHistoryVisibility,
        content: { history_visibility: 'shared' },
      },
      {
        type: EventType.RoomGuestAccess,
        content: { guest_access: 'forbidden' },
      },
    ];
  }

  private async ensureChannelRoomAccess(roomId: string, channelId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');

    try {
      await this.client.setRoomDirectoryVisibility(roomId, Visibility.Private);
    } catch (error) {
      console.warn(`[Matrix] Failed to make #${channelId} private in room directory:`, error);
    }

    for (const event of this.getSpaceRestrictedStateEvents()) {
      try {
        await this.client.sendStateEvent(roomId, event.type as any, event.content as any, '');
      } catch (error) {
        console.warn(`[Matrix] Failed to apply ${event.type} policy to #${channelId}:`, error);
      }
    }
  }

  private async ensureSpaceMembership(roomId: string, label: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');
    if (!this.config.spaceRoomId) return;
    if (roomId === this.config.spaceRoomId) return;

    try {
      await this.client.joinRoom(this.config.spaceRoomId);

      await this.client.sendStateEvent(
        this.config.spaceRoomId,
        EventType.SpaceChild,
        { via: [this.config.serverName], suggested: true },
        roomId,
      );

      await this.client.sendStateEvent(
        roomId,
        EventType.SpaceParent,
        { via: [this.config.serverName], canonical: true },
        this.config.spaceRoomId,
      );

      console.log(`[Matrix] Attached ${label} (${roomId}) to space ${this.config.spaceRoomId}`);
    } catch (error) {
      console.warn(`[Matrix] Failed to attach ${label} to space ${this.config.spaceRoomId}:`, error);
    }
  }

  async attachRoomToSpace(roomId: string, label: string): Promise<void> {
    await this.ensureSpaceMembership(roomId, label);
  }

  async ensureChannelRoom(channelId: string, channelName: string, description?: string): Promise<string> {
    const cached = this.channelRooms.get(channelId);
    if (cached) return cached;

    if (!this.client) throw new Error('Matrix client not started');

    // Try to find existing room by alias
    const alias = `#${channelId}:${this.config.serverName}`;
    try {
      const resolved = await this.client.getRoomIdForAlias(alias);
      this.channelRooms.set(channelId, resolved.room_id);
      await this.ensureChannelRoomAccess(resolved.room_id, channelId);
      await this.ensureSpaceMembership(resolved.room_id, channelId);
      return resolved.room_id;
    } catch {
      // Room doesn't exist, create it
    }

    const result = await this.client.createRoom({
      name: channelName,
      topic: description || `Router channel: #${channelId}`,
      room_alias_name: channelId,
      visibility: Visibility.Private,
      preset: Preset.PrivateChat,
      initial_state: [
        {
          type: ROUTER_CHANNEL_STATE,
          state_key: '',
          content: { channel_id: channelId, name: channelName, description },
        },
        ...this.getSpaceRestrictedStateEvents().map(event => ({
          type: event.type,
          state_key: '',
          content: event.content,
        })),
      ],
    });

    this.channelRooms.set(channelId, result.room_id);
    await this.ensureChannelRoomAccess(result.room_id, channelId);
    await this.ensureSpaceMembership(result.room_id, channelId);
    console.log(`[Matrix] Created room for #${channelId}: ${result.room_id}`);
    return result.room_id;
  }

  async postEntry(roomId: string, entry: {
    id: string;
    handle?: string;
    pseudonym: string;
    content: string;
    timestamp: number;
    topicHints?: string[];
    isReflection?: boolean;
  }, editorialHook?: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const baseUrl = this.config.baseUrl || 'https://router.teleport.computer';
    const permalink = `${baseUrl}/#entry-${entry.id}`;
    const linkedAuthorId = entry.handle
      ? await this.config.resolveLinkedPlatformId?.(this.name, entry.handle)
      : null;
    const author = linkedAuthorId || (entry.handle ? `@${entry.handle}` : entry.pseudonym);
    const displayBudget = Math.max(1000, this.maxMessageLength - author.length - permalink.length - 2048);
    const display = truncateMatrixEntryDisplay(entry.content, displayBudget);
    const renderedBody = await this.renderLinkedMarkdownForMatrix(display.text);
    const renderedHook = editorialHook ? await this.renderLinkedMarkdownForMatrix(editorialHook) : null;
    const authorHtml = linkedAuthorId
      ? `<a href="https://matrix.to/#/${encodeURIComponent(linkedAuthorId)}">${escapeHtml(linkedAuthorId)}</a>`
      : escapeHtml(author);
    const permalinkHtml = `<a href="${escapeHtml(permalink)}">${escapeHtml(permalink)}</a>`;
    const formattedBody = renderedHook
      ? `${renderedHook.html}<p>&mdash; ${authorHtml} &middot; ${permalinkHtml}</p>`
      : `<p>${authorHtml}:</p>${renderedBody.html}<p>${permalinkHtml}</p>`;

    const content: any = {
      msgtype: MsgType.Text,
      // Custom fields for Router Client rendering
      entry_id: entry.id,
      author_handle: entry.handle,
      author_platform_id: linkedAuthorId || undefined,
      author_pseudonym: entry.pseudonym,
      content: entry.content,
      content_display_truncated: display.truncated,
      editorial_hook: editorialHook,
      permalink,
      topic_hints: entry.topicHints,
      is_reflection: entry.isReflection,
      format: 'org.matrix.custom.html',
      formatted_body: formattedBody,
      // Fallback text for stock clients
      body: renderedHook
        ? `${renderedHook.plain}\n\n— ${author} · ${permalink}`
        : `${author}:\n\n${renderedBody.plain}\n\n${permalink}`,
    };

    // We use m.room.message with custom fields instead of a custom event type
    // because custom types don't render at all in stock Element.
    // The Router Client checks for entry_id to render as a card.
    const result = await this.client.sendMessage(roomId, content);
    const eventId = result.event_id!;

    this.entryEventMap.set(eventId, entry.id);
    return eventId;
  }

  private async reactToEvent(roomId: string, eventId: string, emoji: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const result = await this.client.sendEvent(roomId, EventType.Reaction, {
      'm.relates_to': {
        rel_type: RelationType.Annotation,
        event_id: eventId,
        key: emoji,
      },
    });
    return result.event_id!;
  }

  async postSparkContext(roomId: string, spark: {
    sourceHandle: string;
    targetHandle: string;
    reason: string;
    evidence?: Array<{ entryId: string; author: string; snippet: string }>;
  }): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    // Set as room state
    await this.client.sendStateEvent(roomId, ROUTER_SPARK_EVENT as any, {
      source_handle: spark.sourceHandle,
      target_handle: spark.targetHandle,
      reason: spark.reason,
      evidence: spark.evidence || [],
      created_at: Date.now(),
    }, '');

    // Also send a visible message
    const result = await this.client.sendMessage(
      roomId,
      await this.createMessageContent(`**🔗 Connected:** ${spark.reason}`),
    );
    return result.event_id!;
  }

  async getSparkRoomPair(roomId: string): Promise<{ sourceHandle: string; targetHandle: string } | null> {
    if (!this.client) throw new Error('Matrix client not started');

    const room = this.client.getRoom(roomId);
    const event = room?.currentState?.getStateEvents(ROUTER_SPARK_EVENT as any, '');
    const content = event && !Array.isArray(event) ? event.getContent?.() : null;
    const sourceHandle = normalizeRouterHandle(content?.source_handle);
    const targetHandle = normalizeRouterHandle(content?.target_handle);

    if (!sourceHandle || !targetHandle) return null;
    return { sourceHandle, targetHandle };
  }

  async isSparkRoomForPair(roomId: string, handleA: string, handleB: string): Promise<boolean> {
    const pair = await this.getSparkRoomPair(roomId);
    if (!pair) return false;

    const expected = [normalizeRouterHandle(handleA), normalizeRouterHandle(handleB)].sort().join(':');
    const actual = [pair.sourceHandle, pair.targetHandle].sort().join(':');
    return expected === actual;
  }

  async syncProfile(handle: string, profile: { displayName?: string; bio?: string }): Promise<void> {
    if (!this.client) return;
    const userId = `@${handle}:${this.config.serverName}`;
    if (profile.displayName) {
      try {
        // Can only set own profile — would need admin API for others
        if (userId === this.botUserId) {
          await this.client.setDisplayName(profile.displayName);
        }
      } catch { /* Non-fatal */ }
    }
  }

  private async syncBotAccountProfile(avatarCachePath: string): Promise<void> {
    if (!this.client || !this.botUserId) return;

    try {
      await this.client.setDisplayName(this.config.botHandle);
    } catch (err: any) {
      console.warn('[Matrix] Failed to set bot display name:', err.message);
    }

    try {
      const avatarUrl = await this.getOrUploadRouterAvatar(avatarCachePath);
      await this.client.setAvatarUrl(avatarUrl);
      console.log('[Matrix] Router profile avatar set to disco ball');
    } catch (err: any) {
      console.warn('[Matrix] Failed to set bot avatar:', err.message);
    }
  }

  private async getOrUploadRouterAvatar(avatarCachePath: string): Promise<string> {
    const configuredAvatar = process.env.MATRIX_BOT_AVATAR_MXC?.trim();
    if (configuredAvatar) return configuredAvatar;

    if (existsSync(avatarCachePath)) {
      const cached = readFileSync(avatarCachePath, 'utf8').trim();
      if (cached.startsWith('mxc://')) return cached;
    }

    if (!this.client) throw new Error('Matrix client is not initialized');
    const upload = await this.client.uploadContent(
      buildRouterDiscoBallAvatarPng() as any,
      {
        name: 'router-disco-ball.png',
        type: 'image/png',
        includeFilename: true,
      },
    );

    const avatarUrl = upload.content_uri;
    if (!avatarUrl) throw new Error('Matrix media upload did not return a content_uri');

    const dir = dirname(avatarCachePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(avatarCachePath, avatarUrl, 'utf8');
    return avatarUrl;
  }

  async joinUserToChannel(handle: string, channelId: string, channelName: string): Promise<void> {
    const roomId = await this.ensureChannelRoom(channelId, channelName);
    const userId = await this.resolvePlatformId(handle);
    if (userId) {
      await this.inviteToRoom(roomId, userId);
    }
  }

  getChannelRoomId(channelId: string): string | undefined {
    return this.channelRooms.get(channelId);
  }

  private getPendingReviewEntryId(roomId: string, eventId: string): string | undefined {
    const mapped = this.pendingReviewEventMap.get(eventId);
    if (mapped) return mapped;

    const event = this.client?.getRoom(roomId)?.findEventById?.(eventId);
    const content = event?.getContent?.();
    if (typeof content?.pending_entry_id === 'string') return content.pending_entry_id;

    const structured = content?.['com.router.pending_entry'];
    return typeof structured?.entry_id === 'string' ? structured.entry_id : undefined;
  }

  // ── Identity ───────────────────────────────────────────────

  async resolveRouterHandle(platformUserId: string): Promise<string | null> {
    const linkedHandle = await this.config.resolveLinkedRouterHandle?.(this.name, platformUserId);
    if (linkedHandle) return linkedHandle;

    const match = platformUserId.match(/^@([^:]+):/);
    return match ? match[1] : null;
  }

  async resolvePlatformId(routerHandle: string): Promise<string | null> {
    const linkedUserId = await this.config.resolveLinkedPlatformId?.(this.name, routerHandle);
    if (linkedUserId) return linkedUserId;

    return `@${routerHandle}:${this.config.serverName}`;
  }

  isUserInConfiguredSpace(userId: string): boolean {
    if (!this.config.spaceRoomId || !this.client) return false;
    const spaceRoom = this.client.getRoom(this.config.spaceRoomId);
    return this.roomHasMember(spaceRoom, userId);
  }

  // ── Formatting ─────────────────────────────────────────────

  formatContent(markdown: string): string {
    return markdownToMatrixHtml(markdown);
  }

  // ── Private ────────────────────────────────────────────────

  private async createMessageContent(text: string, opts?: SendMessageOptions): Promise<any> {
    const content: Record<string, any> = {
      msgtype: MsgType.Text,
      body: text,
    };

    if (opts?.replyTo) {
      content['m.relates_to'] = {
        'm.in_reply_to': {
          event_id: opts.replyTo,
        },
      };
    }

    if (opts?.format === 'plain') {
      return content;
    }

    const rendered = await this.renderLinkedMarkdownForMatrix(text);
    content.body = rendered.plain;
    const formattedBody = rendered.html;
    if (formattedBody) {
      content.format = 'org.matrix.custom.html';
      content.formatted_body = formattedBody;
    }

    return content;
  }

  private async renderLinkedMarkdownForMatrix(text: string): Promise<{ plain: string; html: string }> {
    const renderedPlain = await this.renderLinkedHandlesForMatrix(text);
    const renderedHtml = await this.linkMatrixHandlesInHtml(markdownToMatrixHtml(text));
    return {
      plain: renderedPlain.plain,
      html: renderedHtml,
    };
  }

  private async linkMatrixHandlesInHtml(html: string): Promise<string> {
    const handlePattern = /(^|[\s([{"'`])@([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)(?=$|[\s)\]}:.,!?'"`])/g;
    const linkedCache = new Map<string, string | null>();
    const parts = html.split(/(<[^>]+>)/g);
    const linkedParts = await Promise.all(parts.map(async part => {
      if (!part || part.startsWith('<')) return part;

      let linked = '';
      let lastIndex = 0;
      for (const match of part.matchAll(handlePattern)) {
        const [, prefix, handle] = match;
        const mentionStart = (match.index || 0) + prefix.length;

        linked += part.slice(lastIndex, mentionStart);

        let linkedUserId = linkedCache.get(handle);
        if (linkedUserId === undefined) {
          linkedUserId = await this.config.resolveLinkedPlatformId?.(this.name, handle) || null;
          linkedCache.set(handle, linkedUserId);
        }

        linked += linkedUserId
          ? `<a href="https://matrix.to/#/${encodeURIComponent(linkedUserId)}">${escapeHtml(linkedUserId)}</a>`
          : `@${handle}`;

        lastIndex = mentionStart + (`@${handle}`).length;
      }

      linked += part.slice(lastIndex);
      return linked;
    }));
    return linkedParts.join('');
  }

  private async renderLinkedHandlesForMatrix(text: string): Promise<{ plain: string; html: string }> {
    const handlePattern = /(^|[\s([{"'`])@([a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?)(?=$|[\s)\]}:.,!?'"`])/g;
    const linkedCache = new Map<string, string | null>();

    let plain = '';
    let html = '';
    let lastIndex = 0;

    for (const match of text.matchAll(handlePattern)) {
      const prefix = match[1] || '';
      const handle = match[2];
      const index = match.index ?? 0;
      const mentionStart = index + prefix.length;

      plain += text.slice(lastIndex, mentionStart);
      html += escapeHtml(text.slice(lastIndex, mentionStart));

      let linkedId = linkedCache.get(handle);
      if (linkedId === undefined) {
        linkedId = await this.config.resolveLinkedPlatformId?.(this.name, handle) ?? null;
        linkedCache.set(handle, linkedId);
      }

      const replacement = linkedId || `@${handle}`;
      plain += replacement;
      html += linkedId
        ? `<a href="https://matrix.to/#/${encodeURIComponent(linkedId)}">${escapeHtml(linkedId)}</a>`
        : escapeHtml(replacement);

      lastIndex = mentionStart + (`@${handle}`).length;
    }

    plain += text.slice(lastIndex);
    html += escapeHtml(text.slice(lastIndex));

    return { plain, html };
  }

  private roomHasRouterManagedState(room: Room | null): boolean {
    const currentState = room?.currentState;
    if (!currentState?.getStateEvents) return false;

    const routerStateEvents = [
      currentState.getStateEvents(ROUTER_SPARK_EVENT as any, ''),
      currentState.getStateEvents(ROUTER_CHANNEL_STATE as any, ''),
    ];

    return routerStateEvents.some(event => !!event && !Array.isArray(event));
  }

  private isDirectMessageRoom(senderId: string, roomId: string, room: Room | null): boolean {
    if (this.getDirectRoomMap()[senderId]?.includes(roomId)) {
      return true;
    }

    // Spark rooms can temporarily have only Router + one human joined while
    // another invite is pending. Do not treat those rooms as DMs.
    if (this.roomHasRouterManagedState(room)) {
      return false;
    }

    if (this.roomIsInConfiguredSpace(room)) {
      return false;
    }

    return room ? room.getJoinedMemberCount() === 2 : false;
  }

  private roomHasMember(room: Room | null, userId: string | null | undefined): boolean {
    if (!room || !userId) return false;
    const member = room.getMember?.(userId);
    if (member?.membership === KnownMembership.Join || member?.membership === KnownMembership.Invite) {
      return true;
    }

    return (room.getJoinedMembers?.() || []).some(member => member.userId === userId);
  }

  private getRoomStateEvent(room: Room | null, eventType: EventType | string, stateKey: string): MatrixEvent | null {
    const event = room?.currentState?.getStateEvents?.(eventType as any, stateKey);
    if (!event || Array.isArray(event)) return null;
    return event as MatrixEvent;
  }

  private roomIsEncrypted(room: Room | null): boolean {
    return !!this.getRoomStateEvent(room, 'm.room.encryption', '');
  }

  private roomIsInConfiguredSpace(room: Room | null): boolean {
    if (!room || !this.config.spaceRoomId) return false;
    if (room.roomId === this.config.spaceRoomId) return false;
    if ([...this.channelRooms.values()].includes(room.roomId)) return true;

    const parent = this.getRoomStateEvent(room, EventType.SpaceParent, this.config.spaceRoomId);
    if (parent) return true;

    const spaceRoom = this.client?.getRoom(this.config.spaceRoomId) || null;
    const child = this.getRoomStateEvent(spaceRoom, EventType.SpaceChild, room.roomId);
    return !!child;
  }

  private getRoomAlias(room: Room): string | null {
    const canonicalAlias = (room as any).getCanonicalAlias?.();
    if (typeof canonicalAlias === 'string' && canonicalAlias) return canonicalAlias;

    const aliasEvent = this.getRoomStateEvent(room, 'm.room.canonical_alias', '');
    const alias = aliasEvent?.getContent?.()?.alias;
    return typeof alias === 'string' && alias ? alias : null;
  }

  private getRoomDisplayName(room: Room): string {
    const name = (room as any).name;
    if (typeof name === 'string' && name.trim()) return name.trim();
    return this.getRoomAlias(room) || room.roomId;
  }

  private getMatrixPermalink(roomId: string, eventId?: string): string | undefined {
    if (!eventId) return undefined;
    const via = this.config.serverName ? `?via=${encodeURIComponent(this.config.serverName)}` : '';
    return `https://matrix.to/#/${encodeURIComponent(roomId)}/${encodeURIComponent(eventId)}${via}`;
  }

  private matrixHistoryQueryMatches(text: string, query?: string): boolean {
    const normalizedQuery = query?.trim().toLowerCase();
    if (!normalizedQuery) return true;

    const normalizedText = text.toLowerCase();
    if (normalizedText.includes(normalizedQuery)) return true;

    const terms = normalizedQuery
      .split(/\s+/)
      .map(term => term.replace(/[^\p{L}\p{N}_-]/gu, ''))
      .filter(term => term.length > 2);

    return terms.length > 0 && terms.some(term => normalizedText.includes(term));
  }

  private async ensureRecentRoomHistoryLoaded(room: Room, since: number | undefined, perRoomLimit: number): Promise<void> {
    if (!this.client?.scrollback) return;

    let attempts = 0;
    while (attempts < 3) {
      const events = room.getLiveTimeline?.().getEvents?.() || [];
      const eventTimestamps = events
        .map(event => event.getTs?.() || 0)
        .filter(timestamp => timestamp > 0);
      const oldestTimestamp = eventTimestamps.length > 0 ? Math.min(...eventTimestamps) : undefined;
      const enoughEvents = events.length >= perRoomLimit;
      const loadedSince = since === undefined || (oldestTimestamp !== undefined && oldestTimestamp <= since);

      if (events.length > 0 && (enoughEvents || loadedSince)) return;

      const before = events.length;
      try {
        await this.client.scrollback(room, Math.min(100, perRoomLimit));
      } catch (error) {
        console.warn(`[Matrix] Failed to load history for ${room.roomId}:`, error);
        return;
      }

      const after = room.getLiveTimeline?.().getEvents?.().length || 0;
      if (after <= before) return;
      attempts++;
    }
  }

  async queryRecentMessages(opts: MatrixHistoryQueryOptions = {}): Promise<MatrixHistoryMessage[]> {
    if (!this.client) return [];

    const limit = Math.max(1, Math.min(opts.limit || 50, 200));
    const perRoomLimit = Math.max(20, Math.min(opts.perRoomLimit || 100, 500));
    const since = opts.since;
    const until = opts.until ?? Date.now();
    const includeDMs = opts.includeDMs === true || opts.onlyDMs === true;
    const onlyDMs = opts.onlyDMs === true;
    const spaceOnly = opts.spaceOnly !== false;
    const botScope = opts.botScope === true;
    const roomFilter = opts.roomIds?.length ? new Set(opts.roomIds) : null;
    const messages: MatrixHistoryMessage[] = [];
    const senderHandleCache = new Map<string, string | null>();
    const spaceRoom = this.config.spaceRoomId ? this.client.getRoom(this.config.spaceRoomId) : null;
    const viewerInSpace = this.roomHasMember(spaceRoom, opts.viewerUserId);

    const rooms = this.client.getRooms?.() || [];
    for (const room of rooms) {
      if (room.getMyMembership?.() !== KnownMembership.Join) continue;
      if (room.roomId === this.config.spaceRoomId) continue;
      if (roomFilter && !roomFilter.has(room.roomId)) continue;

      const roomInSpace = this.roomIsInConfiguredSpace(room);
      const viewerInRoom = this.roomHasMember(room, opts.viewerUserId);
      if (!botScope && !roomFilter && spaceOnly && !roomInSpace && !(includeDMs && viewerInRoom)) {
        continue;
      }

      await this.ensureRecentRoomHistoryLoaded(room, since, perRoomLimit);

      const roomAlias = this.getRoomAlias(room);
      const roomName = this.getRoomDisplayName(room);
      const events = room.getLiveTimeline?.().getEvents?.() || [];
      for (const event of events) {
        if (event.getType?.() !== EventType.RoomMessage) continue;
        const senderId = event.getSender?.();
        if (!senderId || senderId === this.botUserId) continue;

        const eventIsDM = this.isDirectMessageRoom(senderId, room.roomId, room);
        if (onlyDMs && !eventIsDM) continue;
        if (eventIsDM && (!includeDMs || (!viewerInRoom && !botScope))) continue;
        if (!eventIsDM && !botScope && opts.viewerUserId && !viewerInRoom && !viewerInSpace) continue;
        if (!eventIsDM && !botScope && spaceOnly && !roomInSpace && !roomFilter) continue;

        const timestamp = event.getTs?.() || 0;
        if (since !== undefined && timestamp < since) continue;
        if (timestamp >= until) continue;

        const content = event.getContent?.() || {};
        const text = typeof content.body === 'string' ? content.body.trim() : '';
        if (!text || !this.matrixHistoryQueryMatches(text, opts.query)) continue;

        let senderHandle = senderHandleCache.get(senderId);
        if (senderHandle === undefined) {
          senderHandle = await this.resolveRouterHandle(senderId).catch(() => null);
          senderHandleCache.set(senderId, senderHandle);
        }

        const eventId = event.getId?.();
        messages.push({
          roomId: room.roomId,
          roomName,
          roomAlias,
          eventId,
          senderId,
          senderHandle,
          text,
          timestamp,
          isDM: eventIsDM,
          permalink: this.getMatrixPermalink(room.roomId, eventId),
        });
      }
    }

    return messages
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  private setupEventListeners(): void {
    if (!this.client) return;

    // Handle incoming messages immediately when they are already decrypted.
    this.client.on(ClientEvent.Event, (event: MatrixEvent) => {
      this.handleIncomingMessageEvent(event);
    });

    // Also handle events that arrive encrypted and decrypt later once the room
    // key shows up. Without this, the first command after a fresh device reset
    // can be missed.
    this.client.on(MatrixEventEvent.Decrypted, (event: MatrixEvent, err?: Error) => {
      if (err) return;
      this.handleIncomingMessageEvent(event);
    });

    this.client.on(ClientEvent.Room, (room: Room) => {
      if (room.getMyMembership?.() === KnownMembership.Invite) {
        void this.joinInvitedRoom(room.roomId, 'room sync');
      }
    });

    this.client.on(RoomEvent.MyMembership, (room: Room, membership: string) => {
      if (membership === KnownMembership.Invite) {
        void this.joinInvitedRoom(room.roomId, 'my membership');
      }
    });

    // Auto-join on invite.
    this.client.on(RoomMemberEvent.Membership, (event: MatrixEvent, member: any) => {
      this.handleSpaceMembershipForOnboarding(event, member);

      if (member.userId !== this.botUserId) return;
      if (member.membership !== KnownMembership.Invite) return;
      void this.joinInvitedRoom(member.roomId, 'member event');
    });
  }

  private async joinPendingInvitedRooms(reason: string): Promise<void> {
    if (!this.client) return;
    const rooms = this.client.getRooms?.() || [];
    await Promise.all(rooms
      .filter(room => room.getMyMembership?.() === KnownMembership.Invite)
      .map(room => this.joinInvitedRoom(room.roomId, reason)));
  }

  private async joinInvitedRoom(roomId: string | null | undefined, reason: string): Promise<void> {
    if (!this.client || !roomId) return;
    if (this.pendingInviteJoins.has(roomId)) return;
    if (this.joinedInviteRooms.has(roomId)) return;

    this.pendingInviteJoins.add(roomId);
    try {
      await this.client.joinRoom(roomId);
      this.joinedInviteRooms.add(roomId);
      console.log(`[Matrix] Auto-joined room ${roomId} (${reason})`);

      // Delay the welcome message so room encryption state has time to sync.
      // Element withholds Megolm keys from devices that haven't "spoken" —
      // the wake message triggers key sharing — but sending too early fails
      // with "Cannot encrypt event in unconfigured room".
      setTimeout(async () => {
        try {
          await this.client!.sendMessage(
            roomId,
            await this.createMessageContent('Hi — I\'m the Router. Say `help` for what I can do, or `link` to connect your Router notebook account.'),
          );
        } catch (err) {
          console.error(`[Matrix] Welcome message failed in ${roomId}:`, err);
        }
      }, 5000);
    } catch (err) {
      console.error(`[Matrix] Failed to join room ${roomId} (${reason}):`, err);
    } finally {
      this.pendingInviteJoins.delete(roomId);
    }
  }

  private handleIncomingMessageEvent(event: MatrixEvent): void {
    if (!this.client) return;
    if (event.getType() !== EventType.RoomMessage) return;
    if (event.getSender() === this.botUserId) return;
    if (!event.getRoomId()) return;

    const eventId = event.getId();
    if (eventId && this.processedMessageEvents.has(eventId)) return;

    const content = event.getContent();
    const text = content.body || '';
    const sender = event.getSender()!;
    const roomId = event.getRoomId()!;
    const timestamp = event.getTs();

    if (this.config.ignoreMessagesBefore && timestamp < this.config.ignoreMessagesBefore) {
      if (eventId) {
        this.processedMessageEvents.add(eventId);
      }
      return;
    }

    // Resolve handle from Matrix user ID
    const handleMatch = sender.match(/^@([^:]+):/);
    const handle = handleMatch ? handleMatch[1] : null;

    const room = this.client.getRoom(roomId);
    const isDM = this.isDirectMessageRoom(sender, roomId, room);

    // Treat direct DMs and explicit mentions as agent-directed messages.
    const isMention = isMatrixMention({
      isDM,
      text,
      content,
      botUserId: this.botUserId,
      botHandle: this.config.botHandle,
    });

    if (isDM) {
      void this.markRoomAsDirect(sender, roomId).catch(error => {
        console.warn(`[Matrix] Failed to remember direct room ${roomId} for ${sender}:`, error);
      });
    }

    // Check if this is a reply to a notebook entry
    const replyToEventId = content['m.relates_to']?.['m.in_reply_to']?.event_id;
    const replyToEntryId = replyToEventId ? this.entryEventMap.get(replyToEventId) : undefined;
    const replyToPendingEntryId = replyToEventId ? this.getPendingReviewEntryId(roomId, replyToEventId) : undefined;

    // Check if the message itself contains entry data (reply to entry card)
    const isEntryMessage = content.entry_id != null;
    if (isEntryMessage && eventId) {
      this.entryEventMap.set(eventId, content.entry_id);
    }

    if (eventId) {
      this.processedMessageEvents.add(eventId);
      if (this.processedMessageEvents.size > 10000) {
        this.processedMessageEvents.clear();
      }
    }

    if (isMention && eventId) {
      void this.reactToEvent(roomId, eventId, MATRIX_AGENT_TRIGGER_REACTION_EMOJI).catch(error => {
        console.warn(`[Matrix] Failed to react to agent trigger ${eventId} in ${roomId}:`, error);
      });
    }

    const eventData: Record<string, any> = {
      platform: 'matrix',
      room_id: roomId,
      message_id: eventId,
      sender_id: sender,
      sender_handle: handle,
      text,
      timestamp,
      is_dm: isDM,
      is_encrypted: this.roomIsEncrypted(room),
    };

    if (replyToEntryId) {
      eventData.reply_to_entry_id = replyToEntryId;
    }
    if (replyToPendingEntryId) {
      eventData.pending_entry_id = replyToPendingEntryId;
    }

    pushEvent(
      isMention ? 'platform_mention' : 'platform_message',
      eventData,
    );
  }

  /**
   * Bootstrap cross-signing and secret storage if not already set up.
   * This makes the bot behave like any Element user — its device self-signs,
   * other clients can verify it, and encrypted messages flow without special
   * trust relaxation.
   */
  private async bootstrapCryptoIdentity(username: string, password: string): Promise<void> {
    if (!this.client) return;
    const crypto = this.client.getCrypto();
    if (!crypto) {
      console.warn('[Matrix] No crypto backend — skipping cross-signing bootstrap');
      return;
    }

    // Check if cross-signing is already set up
    try {
      const isReady = await crypto.isCrossSigningReady();
      if (isReady) {
        console.log('[Matrix] Cross-signing already set up');
        return;
      }
    } catch {
      // Fall through to bootstrap
    }

    // Wait for /keys/query to settle so the bot's public cross-signing identity
    // is in the local crypto store. Without this, importing private keys from
    // SSSS fails with "No public identity found while importing cross-signing keys".
    console.log('[Matrix] Waiting for /keys/query to populate local identity cache...');
    try {
      const userId = this.client.getUserId()!;
      // downloadUncached: true forces a /keys/query and waits for the response.
      await crypto.getUserDeviceInfo([userId], true);
      // Give the store a beat to finish processing
      await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.warn('[Matrix] getUserDeviceInfo failed (continuing anyway):', err.message);
    }

    console.log('[Matrix] Bootstrapping cross-signing...');

    // UIA callback — provides password for uploading device signing keys.
    // matrix-js-sdk calls this with a function; we return auth data.
    // First invocation: return null to get session; second: return password auth.
    const authUploadDeviceSigningKeys = async (makeRequest: (authData: any) => Promise<any>): Promise<void> => {
      try {
        // First attempt — let the server tell us what auth is needed
        await makeRequest(null);
      } catch (err: any) {
        // UIA: server returned 401 with session + flows
        const data = err.data || err.httpStatus === 401 ? err.data : null;
        if (data?.session) {
          await makeRequest({
            session: data.session,
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password,
          });
          return;
        }
        throw err;
      }
    };

    // Try up to 3 times — the first attempt often races with /keys/query
    // when restoring from SSSS.
    let lastErr: any = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys });
        console.log('[Matrix] Cross-signing keys uploaded');
        lastErr = null;
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(`[Matrix] Cross-signing bootstrap attempt ${attempt}/3 failed:`, err.message);
        if (attempt < 3) {
          // Force another keys/query and wait before retrying
          try {
            await crypto.getUserDeviceInfo([this.client.getUserId()!], true);
          } catch { /* ignore */ }
          await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
    }
    if (lastErr) return;

    // Bootstrap secret storage (SSSS) with a recovery key derived from the bot's secret
    try {
      const isSecretStorageReady = await crypto.isSecretStorageReady();
      if (!isSecretStorageReady) {
        await crypto.bootstrapSecretStorage({
          setupNewKeyBackup: true,
          setupNewSecretStorage: true,
          createSecretStorageKey: async () => {
            // Derive a stable recovery key from the bot secret so it survives restarts
            return await crypto.createRecoveryKeyFromPassphrase(
              `router-ssss-${this.config.cryptoSecret || this.config.botSecretKey || password}`
            );
          },
        });
        console.log('[Matrix] Secret storage + key backup set up');
      }
    } catch (err: any) {
      console.warn('[Matrix] Secret storage bootstrap failed:', err.message);
    }
  }

  private getDirectRoomMap(): Record<string, string[]> {
    if (!this.client) return {};

    const content = this.client.getAccountData(EventType.Direct)?.getContent();
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return {};
    }

    const directRoomMap: Record<string, string[]> = {};
    for (const [userId, roomIds] of Object.entries(content as Record<string, unknown>)) {
      if (!Array.isArray(roomIds)) continue;
      const validRoomIds = roomIds.filter((roomId): roomId is string => typeof roomId === 'string' && roomId.length > 0);
      if (validRoomIds.length > 0) {
        directRoomMap[userId] = validRoomIds;
      }
    }

    return directRoomMap;
  }

  private async markRoomAsDirect(userId: string, roomId: string): Promise<void> {
    if (!this.client) throw new Error('Matrix client not started');

    const directRoomMap = this.getDirectRoomMap();
    const existingRoomIds = directRoomMap[userId] || [];
    if (existingRoomIds[0] === roomId) return;

    directRoomMap[userId] = [roomId, ...existingRoomIds.filter(id => id !== roomId)];
    await this.client.setAccountData(EventType.Direct, directRoomMap);
  }

  private getRoomExplicitName(room: Room): string | null {
    const nameEvent = room.currentState?.getStateEvents(EventType.RoomName, '');
    const name = Array.isArray(nameEvent) ? null : nameEvent?.getContent()?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  }

  private isRouterChannelRoom(room: Room): boolean {
    const channelEvent = room.currentState?.getStateEvents(ROUTER_CHANNEL_STATE as any, '');
    return !Array.isArray(channelEvent) && channelEvent != null;
  }

  private isJoinedOneToOneRoomWith(room: Room, userId: string): boolean {
    if (room.getMyMembership() !== KnownMembership.Join) return false;
    if (this.isRouterChannelRoom(room)) return false;

    const joinedMembers = room.getJoinedMembers();
    if (joinedMembers.length > 0) {
      const joinedIds = new Set(joinedMembers.map(member => member.userId));
      return joinedIds.size === 2
        && joinedIds.has(userId)
        && (!this.botUserId || joinedIds.has(this.botUserId));
    }

    return room.getJoinedMemberCount() === 2
      && room.getMember(userId)?.membership === KnownMembership.Join
      && (!this.botUserId || room.getMember(this.botUserId)?.membership === KnownMembership.Join);
  }

  private findExistingDirectRoom(userId: string, directRoomIds: string[], opts?: { encryptedOnly?: boolean }): Room | null {
    if (!this.client) return null;

    const rooms = this.client.getRooms?.() || [];
    const candidates = rooms
      .filter(room => this.isJoinedOneToOneRoomWith(room, userId))
      .filter(room => !opts?.encryptedOnly || this.roomIsEncrypted(room));
    if (candidates.length === 0) return null;

    const byRecentActivity = (a: Room, b: Room) => b.getLastActiveTimestamp() - a.getLastActiveTimestamp();
    const directLikeRooms = candidates
      .filter(room => !this.getRoomExplicitName(room))
      .sort(byRecentActivity);

    return directLikeRooms.find(room => !directRoomIds.includes(room.roomId))
      || directRoomIds
        .map(roomId => directLikeRooms.find(room => room.roomId === roomId) || null)
        .find((room): room is Room => room != null)
      || null;
  }

  private async findOrCreateDM(userId: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const directRoomIds = this.getDirectRoomMap()[userId] || [];
    const existingDirectRoom = this.findExistingDirectRoom(userId, directRoomIds);
    if (existingDirectRoom) {
      await this.markRoomAsDirect(userId, existingDirectRoom.roomId);
      return existingDirectRoom.roomId;
    }

    for (const roomId of directRoomIds) {
      const room = this.client.getRoom(roomId);
      if (room?.getMyMembership() === KnownMembership.Join) {
        return room.roomId;
      }
    }

    // Create new DM
    const room = await this.createRoom('', {
      type: 'dm',
      invite: [userId],
      encrypted: true,
    });

    await this.markRoomAsDirect(userId, room.id);
    return room.id;
  }

  private async findOrCreateEncryptedDM(userId: string): Promise<string> {
    if (!this.client) throw new Error('Matrix client not started');

    const directRoomIds = this.getDirectRoomMap()[userId] || [];
    const existingDirectRoom = this.findExistingDirectRoom(userId, directRoomIds, { encryptedOnly: true });
    if (existingDirectRoom) {
      await this.markRoomAsDirect(userId, existingDirectRoom.roomId);
      return existingDirectRoom.roomId;
    }

    for (const roomId of directRoomIds) {
      const room = this.client.getRoom(roomId);
      if (room?.getMyMembership() === KnownMembership.Join && this.roomIsEncrypted(room)) {
        return room.roomId;
      }
    }

    const room = await this.createRoom('', {
      type: 'dm',
      invite: [userId],
      encrypted: true,
    });

    await this.markRoomAsDirect(userId, room.id);
    return room.id;
  }
}
