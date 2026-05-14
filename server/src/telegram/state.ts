/**
 * Persist bot state across restarts.
 * Stores surfaced entry IDs, recent hooks, and rate limiter timestamps
 * to a JSON file on disk. Reads on startup, writes periodically.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, accessSync, constants } from 'fs';
import { dirname } from 'path';
import type { PostedEntry } from './types.js';

/** Pick a writable path for state persistence. */
function resolveStatePath(): string {
  if (process.env.TELEGRAM_STATE_FILE) return process.env.TELEGRAM_STATE_FILE;
  // Prefer /data/ (Docker volume), fall back to /tmp/
  try {
    const dir = '/data';
    if (existsSync(dir)) {
      accessSync(dir, constants.W_OK);
      return '/data/telegram-bot-state.json';
    }
  } catch { /* not writable */ }
  return '/tmp/telegram-bot-state.json';
}

const STATE_FILE = resolveStatePath();
if (!STATE_FILE.startsWith('/data')) {
  console.warn(`[Telegram/State] WARNING: using ${STATE_FILE} — state will be LOST on restart`);
}
const SAVE_INTERVAL_MS = 5 * 60 * 1000; // Save every 5 minutes

export interface BotState {
  /** Entry IDs the interjector has already surfaced. */
  surfacedEntryIds: string[];
  /** Brief descriptions of previously surfaced connections. */
  surfacedSummaries: string[];
  /** Recently posted entries for dedup + curation context. */
  recentlyPosted: PostedEntry[];
  /** Channel post rate limiter timestamps. */
  channelPostTimestamps: number[];
  /** Proactive message rate limiter timestamps. */
  proactivePostTimestamps: number[];
  /** Last write-back timestamp. */
  lastWritebackTime: number;
  /** Adaptive cooldown timestamps for the classifier. */
  classifierSpeakTimestamps: number[];
}

const EMPTY_STATE: BotState = {
  surfacedEntryIds: [],
  surfacedSummaries: [],
  recentlyPosted: [],
  channelPostTimestamps: [],
  proactivePostTimestamps: [],
  lastWritebackTime: 0,
  classifierSpeakTimestamps: [],
};

/** Load persisted state from disk, or return empty state. */
export function loadState(): BotState {
  try {
    if (!existsSync(STATE_FILE)) {
      console.log('[Telegram/State] No state file found, starting fresh');
      return { ...EMPTY_STATE };
    }
    const raw = readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    console.log(
      `[Telegram/State] Loaded: ${parsed.surfacedEntryIds?.length || 0} surfaced IDs, ${parsed.recentlyPosted?.length || 0} recent posts`,
    );
    return { ...EMPTY_STATE, ...parsed };
  } catch (err) {
    console.error('[Telegram/State] Failed to load state:', err);
    return { ...EMPTY_STATE };
  }
}

/** Save state to disk. */
export function saveState(state: BotState): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    // Don't crash if /data/ doesn't exist (local dev)
    console.error('[Telegram/State] Failed to save state:', err);
  }
}

/**
 * Start periodic state saving. Returns a cleanup function.
 */
export function startStateSaver(getState: () => BotState): () => void {
  const timer = setInterval(() => {
    saveState(getState());
  }, SAVE_INTERVAL_MS);

  return () => {
    clearInterval(timer);
    // Final save on shutdown
    saveState(getState());
  };
}
