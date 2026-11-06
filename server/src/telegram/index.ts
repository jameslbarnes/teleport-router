/**
 * Telegram Bot for Router — thin relay.
 *
 * All intelligence has been moved to the Nous Router agent.
 * This module only:
 * 1. Initializes the Telegraf bot
 * 2. Pushes incoming messages to the event queue
 * 3. Exposes the bot instance for MCP tools to send messages
 * 4. Sets up the bot's Router identity
 */

import { Telegraf } from 'telegraf';
import type { Storage, JournalEntry } from '../storage.js';
import { derivePseudonym, hashSecretKey, generateSecretKey } from '../identity.js';
import type { TelegramConfig } from './types.js';
import { pushEvent } from '../events.js';

// Re-export public types
export type { TelegramConfig } from './types.js';

// Re-export classifier for consumers
export { shouldISpeak, isExplicitSummon, recordBotSpoke, getAdaptiveCooldown } from './classifier.js';
export type { SpeakDecision, SpeakIntent, ClassifierScores } from './classifier.js';

let bot: Telegraf | null = null;

/**
 * Get the Telegraf bot instance (for MCP tools to send messages).
 */
export function getTelegramBot(): Telegraf | null {
  return bot;
}

/**
 * Post a single entry to the Telegram channel.
 * @deprecated — The agent now handles posting via router_telegram_send.
 * Kept for backward compatibility during migration.
 */
export async function postToTelegram(entry: JournalEntry): Promise<void> {
  // No-op: the agent handles posting decisions now
  console.log(`[Telegram] postToTelegram called for ${entry.id} — agent handles posting now`);
}

/**
 * Hard rules for whether an entry should be considered for posting.
 * Kept as a utility for the agent to reference.
 */
export function shouldPostToTelegram(entry: JournalEntry): boolean {
  if (entry.to && entry.to.length > 0) return false;
  if (entry.visibility === 'private') return false;
  if (entry.channel === 'ai-oly') return false;
  if (entry.aiOnly === true || entry.humanVisible === false) return false;
  return true;
}

/**
 * Format an entry for Telegram (plain text with author attribution).
 * Kept as a utility for the agent to reference.
 */
export function formatEntryForTelegram(entry: JournalEntry, baseUrl: string): string {
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const permalink = `${baseUrl}/#entry-${entry.id}`;
  const MAX_CONTENT_LENGTH = 3500;
  let content = entry.content;
  if (content.length > MAX_CONTENT_LENGTH) {
    content = content.slice(0, MAX_CONTENT_LENGTH) + '\u2026';
  }
  return `${author}\n\n${content}\n\n${permalink}`;
}

/**
 * Ensure the bot has a Router identity (user record + handle).
 */
async function ensureBotIdentity(
  storage: Storage,
  secretKey: string,
  handle: string,
): Promise<{ pseudonym: string; handle: string }> {
  const pseudonym = derivePseudonym(secretKey);
  const keyHash = hashSecretKey(secretKey);

  const existing = await storage.getUserByKeyHash(keyHash);
  if (existing) {
    return { pseudonym, handle: existing.handle };
  }

  const available = await storage.isHandleAvailable(handle);
  if (!available) {
    const fallback = `router_bot_${keyHash.slice(0, 6)}`;
    console.log(`[Telegram] Handle @${handle} taken, using @${fallback}`);
    handle = fallback;
  }

  try {
    await storage.createUser({
      handle,
      secretKeyHash: keyHash,
      displayName: 'Router',
      bio: 'The Router agent — central routing intelligence for the shared notebook.',
      legacyPseudonym: pseudonym,
    });
    console.log(`[Telegram] Created bot identity: @${handle} (${pseudonym})`);
  } catch (err: any) {
    if (!err.message?.includes('already exists')) {
      console.error('[Telegram] Failed to create bot identity:', err);
    }
  }

  return { pseudonym, handle };
}

/**
 * Start the Telegram bot as a thin relay. Returns a cleanup function.
 *
 * The bot only listens for messages and pushes them to the event queue.
 * All intelligence (responding, interjecting, posting) is handled by the
 * Nous Router agent via MCP tools.
 */
export function startTelegramBot(
  storage: Storage,
  config: TelegramConfig,
): () => void {
  bot = new Telegraf(config.botToken);

  // Set up bot identity
  const botSecretKey = config.botSecretKey || generateSecretKey();
  const botHandle = config.botHandle || 'router';

  ensureBotIdentity(storage, botSecretKey, botHandle).catch((err) => {
    console.error('[Telegram] Failed to set up bot identity:', err);
  });

  // Listen for all messages and push to event queue.
  // Explicit @mentions and direct replies ALWAYS trigger a response.
  // All other messages go through the classifier pipeline.
  bot.on('message', async (ctx) => {
    const text = 'text' in ctx.message ? ctx.message.text : null;
    if (!text) return;

    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;
    const msg = ctx.message as any;
    const senderName = msg.from?.first_name || msg.from?.username || 'Unknown';
    const senderId = msg.from?.id;

    // Check if bot is explicitly summoned (@mentioned or replied to)
    let isSummoned = false;
    try {
      const botInfo = await bot!.telegram.getMe();
      // Explicit @mention in message text
      isSummoned = text.includes(`@${botInfo.username}`);
      // Direct reply to one of the bot's messages
      if (!isSummoned && msg.reply_to_message?.from?.id === botInfo.id) {
        isSummoned = true;
      }
    } catch {
      // Ignore — just treat as regular message
    }

    const eventData = {
      platform: 'telegram',
      chat_id: String(chatId),
      chat_type: chatType,
      message_id: msg.message_id,
      sender_name: senderName,
      sender_id: String(senderId),
      text,
      reply_to_message_id: msg.reply_to_message?.message_id || null,
    };

    if (isSummoned) {
      // Always respond to explicit summons — bypass classifier entirely
      pushEvent('platform_mention', eventData);
    } else {
      // Regular message — goes through classifier pipeline downstream
      pushEvent('platform_message', eventData);
    }
  });

  // Launch the bot (long polling)
  bot.launch().catch((err) => {
    console.error('[Telegram] Bot failed to start:', err);
  });

  console.log(
    `[Telegram] Bot started as thin relay (channel: ${config.channelId}, group: ${config.groupChatId || 'none'})`,
  );

  // Return cleanup function
  return () => {
    bot?.stop('shutdown');
    bot = null;
  };
}
