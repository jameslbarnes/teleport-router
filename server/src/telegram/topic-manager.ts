/**
 * TopicManager — clean abstraction over Telegram's forum topic operations.
 *
 * Wraps Telegraf's Telegram API client for creating, managing, and messaging
 * within forum topics. This is a pure Telegram abstraction with no dependencies
 * on Hermes-specific types (no storage, no channels, no classifier).
 *
 * All methods accept an optional chatId override; if not provided, they fall
 * back to the default chatId supplied at construction time.
 */

// We only need the Telegram API client type from Telegraf.
// Using a structural interface so we don't tightly couple to Telegraf's exact type.
export interface TelegramApi {
  createForumTopic(
    chatId: number | string,
    name: string,
  ): Promise<{ message_thread_id: number; name: string }>;

  closeForumTopic(
    chatId: number | string,
    messageThreadId: number,
  ): Promise<boolean>;

  reopenForumTopic(
    chatId: number | string,
    messageThreadId: number,
  ): Promise<boolean>;

  deleteForumTopic(
    chatId: number | string,
    messageThreadId: number,
  ): Promise<boolean>;

  sendMessage(
    chatId: number | string,
    text: string,
    extra?: Record<string, unknown>,
  ): Promise<{ message_id: number }>;

  pinChatMessage(
    chatId: number | string,
    messageId: number,
    extra?: Record<string, unknown>,
  ): Promise<boolean>;

  unpinChatMessage(
    chatId: number | string,
    extra?: Record<string, unknown>,
  ): Promise<boolean>;

  editForumTopic(
    chatId: number | string,
    messageThreadId: number,
    extra: { name?: string; icon_custom_emoji_id?: string },
  ): Promise<boolean>;
}

// ─── TopicManager ──────────────────────────────────────────────────────────

const TAG = '[Telegram/Topics]';

export class TopicManager {
  private api: TelegramApi;
  private defaultChatId: string;

  constructor(api: TelegramApi, defaultChatId: string) {
    this.api = api;
    this.defaultChatId = defaultChatId;
  }

  /**
   * Resolve the chat ID: use the override if provided, otherwise the default.
   */
  private resolveChatId(chatId?: string): string {
    return chatId ?? this.defaultChatId;
  }

  /**
   * Create a new forum topic.
   * Returns the thread ID and name of the newly created topic.
   */
  async createTopic(
    name: string,
    chatId?: string,
  ): Promise<{ threadId: number; name: string }> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Creating topic "${name}" in chat ${cid}`);
    try {
      const result = await this.api.createForumTopic(cid, name);
      console.log(`${TAG} Created topic "${result.name}" → thread ${result.message_thread_id}`);
      return { threadId: result.message_thread_id, name: result.name };
    } catch (err) {
      const message = `Failed to create topic "${name}" in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Close (archive) a forum topic.
   */
  async closeTopic(threadId: number, chatId?: string): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Closing topic ${threadId} in chat ${cid}`);
    try {
      await this.api.closeForumTopic(cid, threadId);
    } catch (err) {
      const message = `Failed to close topic ${threadId} in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Reopen a previously closed forum topic.
   */
  async reopenTopic(threadId: number, chatId?: string): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Reopening topic ${threadId} in chat ${cid}`);
    try {
      await this.api.reopenForumTopic(cid, threadId);
    } catch (err) {
      const message = `Failed to reopen topic ${threadId} in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Delete a forum topic entirely.
   */
  async deleteTopic(threadId: number, chatId?: string): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Deleting topic ${threadId} in chat ${cid}`);
    try {
      await this.api.deleteForumTopic(cid, threadId);
    } catch (err) {
      const message = `Failed to delete topic ${threadId} in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Send a message to a specific topic. Returns the message_id of the sent message.
   */
  async sendToTopic(
    threadId: number,
    text: string,
    opts?: { parseMode?: string; replyToMessageId?: number },
    chatId?: string,
  ): Promise<number> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Sending message to topic ${threadId} in chat ${cid} (${text.length} chars)`);
    try {
      const extra: Record<string, unknown> = { message_thread_id: threadId };
      if (opts?.parseMode) {
        extra.parse_mode = opts.parseMode;
      }
      if (opts?.replyToMessageId) {
        extra.reply_to_message_id = opts.replyToMessageId;
      }
      const result = await this.api.sendMessage(cid, text, extra);
      return result.message_id;
    } catch (err) {
      const message = `Failed to send message to topic ${threadId} in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Pin a message within a topic.
   */
  async pinInTopic(
    threadId: number,
    messageId: number,
    chatId?: string,
  ): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Pinning message ${messageId} in topic ${threadId}, chat ${cid}`);
    try {
      await this.api.pinChatMessage(cid, messageId, {
        message_thread_id: threadId,
      });
    } catch (err) {
      const message = `Failed to pin message ${messageId} in topic ${threadId}, chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Unpin a message within a topic.
   */
  async unpinInTopic(
    threadId: number,
    messageId: number,
    chatId?: string,
  ): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Unpinning message ${messageId} in topic ${threadId}, chat ${cid}`);
    try {
      await this.api.unpinChatMessage(cid, {
        message_thread_id: threadId,
        message_id: messageId,
      });
    } catch (err) {
      const message = `Failed to unpin message ${messageId} in topic ${threadId}, chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }

  /**
   * Rename a forum topic.
   */
  async editTopicName(
    threadId: number,
    name: string,
    chatId?: string,
  ): Promise<void> {
    const cid = this.resolveChatId(chatId);
    console.log(`${TAG} Renaming topic ${threadId} to "${name}" in chat ${cid}`);
    try {
      await this.api.editForumTopic(cid, threadId, { name });
    } catch (err) {
      const message = `Failed to rename topic ${threadId} in chat ${cid}`;
      console.error(`${TAG} ${message}:`, err);
      throw new Error(`${TAG} ${message}: ${(err as Error).message}`);
    }
  }
}
