/**
 * Telegram Bot for Router — facade re-export.
 *
 * The implementation lives in telegram/ module directory.
 * This file exists so http.ts imports don't break.
 */

export { startTelegramBot, postToTelegram, getTelegramBot, shouldPostToTelegram, formatEntryForTelegram } from './telegram/index.js';
export { shouldISpeak, isExplicitSummon, recordBotSpoke, getAdaptiveCooldown } from './telegram/index.js';
export type { TelegramConfig } from './telegram/index.js';
export type { SpeakDecision, SpeakIntent, ClassifierScores } from './telegram/index.js';
