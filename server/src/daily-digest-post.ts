import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { MatrixPlatform } from './platform/matrix.js';

export interface DailyDigestPostRecord {
  date: string;
  roomId: string;
  messageId: string;
  postedAt: number;
  postedBy?: string;
}

export interface DailyDigestPostState {
  posted: Record<string, DailyDigestPostRecord>;
}

export interface DailyDigestAlreadyPostedResult {
  status: 'already-posted';
  record: DailyDigestPostRecord;
}

export interface DailyDigestPostedResult {
  status: 'posted';
  record: DailyDigestPostRecord;
}

export type DailyDigestPostResult = DailyDigestAlreadyPostedResult | DailyDigestPostedResult;

export function getDailyDigestPostStatePath(): string {
  const explicitPath = process.env.ROUTER_DAILY_DIGEST_STATE_PATH || process.env.MATRIX_DIGEST_STATE_PATH;
  if (explicitPath) return explicitPath;

  try {
    accessSync('/data', constants.W_OK);
    return '/data/router-daily-digest-state.json';
  } catch {
    return join(process.env.TMPDIR || '/tmp', 'router-daily-digest-state.json');
  }
}

export function loadDailyDigestPostState(): DailyDigestPostState {
  try {
    const parsed = JSON.parse(readFileSync(getDailyDigestPostStatePath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.posted && typeof parsed.posted === 'object') {
      return { posted: parsed.posted };
    }
  } catch {}
  return { posted: {} };
}

export function saveDailyDigestPostState(state: DailyDigestPostState): void {
  const path = getDailyDigestPostStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

export function getDailyDigestPostRecord(date: string): DailyDigestPostRecord | null {
  return loadDailyDigestPostState().posted[date] || null;
}

export async function postDailyDigestToMatrix(
  matrix: MatrixPlatform & {
    ensureChannelRoom?: (channelId: string, channelName: string, description?: string) => Promise<string>;
  },
  date: string,
  text: string,
  postedBy?: string,
): Promise<DailyDigestPostResult> {
  const state = loadDailyDigestPostState();
  const existing = state.posted[date];
  if (existing) {
    return { status: 'already-posted', record: existing };
  }

  if (typeof matrix.ensureChannelRoom !== 'function') {
    throw new Error('Matrix platform does not support channel rooms.');
  }

  const roomId = await matrix.ensureChannelRoom('digest', 'Daily Digest', 'Daily summary of notebook activity');
  const digestText = text.startsWith('# Daily Digest')
    ? text
    : `# Daily Digest — ${date}\n\n${text}`;
  const messageId = await matrix.sendMessage(roomId, digestText);

  const record: DailyDigestPostRecord = {
    date,
    roomId,
    messageId,
    postedAt: Date.now(),
    postedBy,
  };
  state.posted[date] = record;
  try {
    saveDailyDigestPostState(state);
  } catch (error) {
    console.warn('[Digest] Posted daily digest but failed to persist idempotency state:', error);
  }

  return { status: 'posted', record };
}
