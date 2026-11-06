import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TopicManager, type TelegramApi } from './topic-manager.js';

// ─── Mock Telegram API ──────────────────────────────────────────────────────

function createMockApi(): TelegramApi & {
  calls: Array<{ method: string; args: unknown[] }>;
} {
  const calls: Array<{ method: string; args: unknown[] }> = [];

  return {
    calls,

    createForumTopic: vi.fn(async (chatId: number | string, name: string) => {
      calls.push({ method: 'createForumTopic', args: [chatId, name] });
      return { message_thread_id: 42, name };
    }),

    closeForumTopic: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'closeForumTopic', args });
      return true;
    }),

    reopenForumTopic: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'reopenForumTopic', args });
      return true;
    }),

    deleteForumTopic: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'deleteForumTopic', args });
      return true;
    }),

    sendMessage: vi.fn(async (chatId: number | string, text: string, extra?: Record<string, unknown>) => {
      calls.push({ method: 'sendMessage', args: [chatId, text, extra] });
      return { message_id: 100 };
    }),

    pinChatMessage: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'pinChatMessage', args });
      return true;
    }),

    unpinChatMessage: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'unpinChatMessage', args });
      return true;
    }),

    editForumTopic: vi.fn(async (...args: unknown[]) => {
      calls.push({ method: 'editForumTopic', args });
      return true;
    }),
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

const DEFAULT_CHAT_ID = '-1001234567890';

describe('TopicManager', () => {
  let api: ReturnType<typeof createMockApi>;
  let tm: TopicManager;

  beforeEach(() => {
    api = createMockApi();
    tm = new TopicManager(api, DEFAULT_CHAT_ID);
  });

  // ── createTopic ──────────────────────────────────────────────────────────

  describe('createTopic', () => {
    it('calls createForumTopic with default chatId and returns threadId + name', async () => {
      const result = await tm.createTopic('General');

      expect(result).toEqual({ threadId: 42, name: 'General' });
      expect(api.createForumTopic).toHaveBeenCalledWith(DEFAULT_CHAT_ID, 'General');
    });

    it('uses override chatId when provided', async () => {
      await tm.createTopic('Off-topic', '-100999');

      expect(api.createForumTopic).toHaveBeenCalledWith('-100999', 'Off-topic');
    });
  });

  // ── closeTopic ───────────────────────────────────────────────────────────

  describe('closeTopic', () => {
    it('calls closeForumTopic with correct params', async () => {
      await tm.closeTopic(42);

      expect(api.closeForumTopic).toHaveBeenCalledWith(DEFAULT_CHAT_ID, 42);
    });
  });

  // ── reopenTopic ──────────────────────────────────────────────────────────

  describe('reopenTopic', () => {
    it('calls reopenForumTopic with correct params', async () => {
      await tm.reopenTopic(42);

      expect(api.reopenForumTopic).toHaveBeenCalledWith(DEFAULT_CHAT_ID, 42);
    });
  });

  // ── deleteTopic ──────────────────────────────────────────────────────────

  describe('deleteTopic', () => {
    it('calls deleteForumTopic with correct params', async () => {
      await tm.deleteTopic(42);

      expect(api.deleteForumTopic).toHaveBeenCalledWith(DEFAULT_CHAT_ID, 42);
    });
  });

  // ── sendToTopic ──────────────────────────────────────────────────────────

  describe('sendToTopic', () => {
    it('passes message_thread_id in the extras', async () => {
      const msgId = await tm.sendToTopic(42, 'Hello, topic!');

      expect(msgId).toBe(100);
      expect(api.sendMessage).toHaveBeenCalledWith(
        DEFAULT_CHAT_ID,
        'Hello, topic!',
        { message_thread_id: 42 },
      );
    });

    it('passes parse_mode and reply_to_message_id when provided', async () => {
      await tm.sendToTopic(7, 'Bold text', {
        parseMode: 'MarkdownV2',
        replyToMessageId: 55,
      });

      expect(api.sendMessage).toHaveBeenCalledWith(
        DEFAULT_CHAT_ID,
        'Bold text',
        {
          message_thread_id: 7,
          parse_mode: 'MarkdownV2',
          reply_to_message_id: 55,
        },
      );
    });

    it('uses override chatId when provided', async () => {
      await tm.sendToTopic(42, 'test', undefined, '-100888');

      expect(api.sendMessage).toHaveBeenCalledWith(
        '-100888',
        'test',
        { message_thread_id: 42 },
      );
    });
  });

  // ── pinInTopic / unpinInTopic ────────────────────────────────────────────

  describe('pinInTopic', () => {
    it('calls pinChatMessage with message_thread_id', async () => {
      await tm.pinInTopic(42, 100);

      expect(api.pinChatMessage).toHaveBeenCalledWith(
        DEFAULT_CHAT_ID,
        100,
        { message_thread_id: 42 },
      );
    });

    it('uses override chatId when provided', async () => {
      await tm.pinInTopic(42, 100, '-100777');

      expect(api.pinChatMessage).toHaveBeenCalledWith(
        '-100777',
        100,
        { message_thread_id: 42 },
      );
    });
  });

  describe('unpinInTopic', () => {
    it('calls unpinChatMessage with message_id and message_thread_id', async () => {
      await tm.unpinInTopic(42, 100);

      expect(api.unpinChatMessage).toHaveBeenCalledWith(
        DEFAULT_CHAT_ID,
        { message_thread_id: 42, message_id: 100 },
      );
    });
  });

  // ── editTopicName ────────────────────────────────────────────────────────

  describe('editTopicName', () => {
    it('calls editForumTopic with new name', async () => {
      await tm.editTopicName(42, 'Renamed Topic');

      expect(api.editForumTopic).toHaveBeenCalledWith(
        DEFAULT_CHAT_ID,
        42,
        { name: 'Renamed Topic' },
      );
    });

    it('uses override chatId when provided', async () => {
      await tm.editTopicName(42, 'New Name', '-100666');

      expect(api.editForumTopic).toHaveBeenCalledWith(
        '-100666',
        42,
        { name: 'New Name' },
      );
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────

  describe('error handling', () => {
    it('catches API errors, logs them, and re-throws with a clean message', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      api.createForumTopic.mockRejectedValueOnce(new Error('Bad Request: chat not found'));

      await expect(tm.createTopic('Fail')).rejects.toThrow(
        '[Telegram/Topics] Failed to create topic "Fail"',
      );

      expect(consoleSpy).toHaveBeenCalled();
      const loggedMessage = consoleSpy.mock.calls[0]?.[0] as string;
      expect(loggedMessage).toContain('[Telegram/Topics]');
      expect(loggedMessage).toContain('Failed to create topic');

      consoleSpy.mockRestore();
    });

    it('re-throws errors from sendToTopic with context', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      api.sendMessage.mockRejectedValueOnce(new Error('Forbidden: bot was kicked'));

      await expect(tm.sendToTopic(42, 'Hi')).rejects.toThrow(
        '[Telegram/Topics] Failed to send message to topic 42',
      );

      consoleSpy.mockRestore();
    });

    it('re-throws errors from closeTopic with context', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      api.closeForumTopic.mockRejectedValueOnce(new Error('topic already closed'));

      await expect(tm.closeTopic(99)).rejects.toThrow(
        '[Telegram/Topics] Failed to close topic 99',
      );

      consoleSpy.mockRestore();
    });

    it('re-throws errors from deleteTopic with context', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      api.deleteForumTopic.mockRejectedValueOnce(new Error('not enough rights'));

      await expect(tm.deleteTopic(77)).rejects.toThrow(
        '[Telegram/Topics] Failed to delete topic 77',
      );

      consoleSpy.mockRestore();
    });
  });

  // ── Default chatId fallback ──────────────────────────────────────────────

  describe('default chatId', () => {
    it('uses default chatId for all methods when no override is provided', async () => {
      await tm.createTopic('A');
      await tm.closeTopic(1);
      await tm.reopenTopic(2);
      await tm.deleteTopic(3);
      await tm.sendToTopic(4, 'msg');
      await tm.pinInTopic(5, 10);
      await tm.unpinInTopic(6, 11);
      await tm.editTopicName(7, 'X');

      // Every recorded call should use the default chat ID
      for (const call of api.calls) {
        expect(call.args[0]).toBe(DEFAULT_CHAT_ID);
      }
    });
  });
});
