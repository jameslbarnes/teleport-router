import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JournalEntry, Storage, User } from '../storage.js';
import type { Platform } from '../platform/types.js';
import type { MatrixHistoryMessage } from '../platform/matrix.js';

const { messagesCreate } = vi.hoisted(() => ({
  messagesCreate: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function MockAnthropic() {
    return {
    messages: {
      create: messagesCreate,
    },
    };
  }),
}));

import { resetEvents } from '../events.js';
import { registerPlatform } from '../platform/registry.js';
import { generateDailyDigest, PERSONALIZED_DIGEST_MODEL, sendPersonalizedDigests } from './cron.js';

function yesterdayAtNoon(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12);
}

function makeUser(overrides: Partial<User> = {}): User {
  return {
    handle: 'alice',
    secretKeyHash: 'hash',
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-1',
    pseudonym: 'Test User#abc123',
    client: 'desktop',
    content: 'A public notebook entry about Matrix digest delivery.',
    timestamp: yesterdayAtNoon(),
    ...overrides,
  };
}

function makeStorage(overrides: Partial<Storage> & Record<string, any> = {}): Storage {
  return {
    getAllUsers: vi.fn(async () => []),
    getUser: vi.fn(async () => null),
    getEntriesSince: vi.fn(async () => []),
    getEntriesByHandle: vi.fn(async () => []),
    getEntriesAddressedTo: vi.fn(async () => []),
    ...overrides,
  } as unknown as Storage;
}

function registerMatrixPlatform() {
  const sendMessage = vi.fn(async () => '$msg');
  const sendDM = vi.fn(async () => '$dm');
  const ensureChannelRoom = vi.fn(async () => '!digest:matrix.test');
  const queryRecentMessages = vi.fn(async (): Promise<MatrixHistoryMessage[]> => []);
  const platform: Platform = {
    name: 'matrix',
    maxMessageLength: 65536,
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    sendMessage,
    sendDM,
    createRoom: vi.fn(async () => ({ id: '!room:test', type: 'group' as const, platform: 'matrix' })),
    inviteToRoom: vi.fn(async () => {}),
    removeFromRoom: vi.fn(async () => {}),
    setRoomTopic: vi.fn(async () => {}),
    setUserRole: vi.fn(async () => {}),
    deleteMessage: vi.fn(async () => {}),
    resolveRouterHandle: vi.fn(async () => null),
    resolvePlatformId: vi.fn(async handle => `@${handle}:matrix.test`),
    formatContent: text => text,
    ensureChannelRoom,
    queryRecentMessages,
  } as Platform & { ensureChannelRoom: typeof ensureChannelRoom; queryRecentMessages: typeof queryRecentMessages };

  registerPlatform(platform);
  return { platform, sendDM, sendMessage, ensureChannelRoom, queryRecentMessages };
}

describe('generateDailyDigest', () => {
  beforeEach(() => {
    resetEvents();
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.ROUTER_DAILY_DIGEST_STATE_PATH = `/tmp/router-digest-test-${Date.now()}-${Math.random()}.json`;
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{
        type: 'text',
        text: '<subject>Digest subject</subject><digest>@alice shipped Matrix routing. [A source](https://example.com) confirms the context.</digest><news>\n[News item](https://example.com/news) - useful context.\n</news><question>What changes when delivery becomes deterministic?</question>',
      }],
    });
  });

  it('posts a server-authored digest to the Matrix #digest room', async () => {
    const { sendMessage, ensureChannelRoom } = registerMatrixPlatform();
    const addDailySummary = vi.fn(async summary => ({ id: `daily-${summary.date}`, ...summary }));
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({
          id: 'public-feed',
          handle: 'alice',
          content: 'Alice wrote about Matrix routing and digest delivery.',
          topicHints: ['matrix', 'digest'],
        }),
        makeEntry({
          id: 'public-channel',
          handle: 'bob',
          content: 'Bob posted a channel update about notebook synthesis.',
          to: ['#books'],
        }),
      ]),
      addDailySummary,
    });

    await expect(generateDailyDigest(storage)).resolves.toMatchObject({
      posted: true,
      entryCount: 2,
      includedEntryCount: 2,
      roomId: '!digest:matrix.test',
      messageId: '$msg',
    });

    expect(ensureChannelRoom).toHaveBeenCalledWith('digest', 'Daily Digest', 'Daily summary of notebook activity');
    expect(sendMessage).toHaveBeenCalledWith('!digest:matrix.test', expect.stringContaining('# Daily Digest'));
    expect(addDailySummary).not.toHaveBeenCalled();
    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(messagesCreate.mock.calls[0][0].messages[0].content).toContain('Alice wrote about Matrix routing');
  });

  it('does not regenerate or repost a digest for a date that was already posted', async () => {
    const { sendMessage } = registerMatrixPlatform();
    const date = new Date(yesterdayAtNoon()).toISOString().slice(0, 10);
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'public-feed', handle: 'alice', content: 'Alice wrote about Matrix routing.' }),
      ]),
    });

    await expect(generateDailyDigest(storage, { date })).resolves.toMatchObject({
      posted: true,
      messageId: '$msg',
    });
    await expect(generateDailyDigest(storage, { date })).resolves.toMatchObject({
      posted: false,
      skipped: 'already-posted',
      messageId: '$msg',
    });

    expect(messagesCreate).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('excludes private addressed and AI-only entries from the prompt', async () => {
    registerMatrixPlatform();
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'public', handle: 'alice', content: 'Public feed entry.' }),
        makeEntry({ id: 'private-handle', handle: 'alice', content: 'Private handle entry should not leak.', to: ['@bob'] }),
        makeEntry({ id: 'private-email', handle: 'alice', content: 'Private email entry should not leak.', to: ['person@example.com'] }),
        makeEntry({ id: 'ai-only', handle: 'alice', content: 'AI only entry should not leak.', aiOnly: true }),
      ]),
    });

    await generateDailyDigest(storage);

    const prompt = messagesCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Public feed entry.');
    expect(prompt).not.toContain('Private handle entry should not leak.');
    expect(prompt).not.toContain('Private email entry should not leak.');
    expect(prompt).not.toContain('AI only entry should not leak.');
  });

  it('can post a global digest from Matrix room activity when there are no notebook entries', async () => {
    const { sendMessage, queryRecentMessages } = registerMatrixPlatform();
    queryRecentMessages.mockResolvedValue([
      {
        roomId: '!books:matrix.test',
        roomName: 'Books',
        roomAlias: '#books:matrix.test',
        eventId: '$event',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'We discussed Matrix encryption and room discovery.',
        timestamp: yesterdayAtNoon(),
        isDM: false,
      },
    ]);
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => []),
    });

    await expect(generateDailyDigest(storage)).resolves.toMatchObject({
      posted: true,
      entryCount: 0,
      includedEntryCount: 0,
      matrixMessageCount: 1,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Matrix conversations');
    expect(prompt).toContain('Matrix encryption and room discovery');
  });

  it('does not save global digest posts into public daily summaries', async () => {
    const { queryRecentMessages } = registerMatrixPlatform();
    queryRecentMessages.mockResolvedValue([
      {
        roomId: '!books:matrix.test',
        roomName: 'Books',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'Private space context should not become a public summary.',
        timestamp: yesterdayAtNoon(),
        isDM: false,
      },
    ]);
    const addDailySummary = vi.fn(async summary => ({ id: `daily-${summary.date}`, ...summary }));
    const storage = makeStorage({
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'public', handle: 'alice', content: 'Public notebook entry.' }),
      ]),
      addDailySummary,
    });

    await generateDailyDigest(storage);

    expect(addDailySummary).not.toHaveBeenCalled();
  });
});

describe('sendPersonalizedDigests', () => {
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    messagesCreate.mockReset();
    messagesCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Personalized digest body.' }],
    });
  });

  it('sends to verified linked Matrix users even when they did not post yesterday', async () => {
    const { sendDM } = registerMatrixPlatform();
    const alice = makeUser({
      handle: 'alice',
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.test', linkedAt: Date.now(), verified: true },
      ],
    });

    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [alice]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-carol', handle: 'carol', content: 'Carol shipped a new channel workflow.' }),
      ]),
      getEntriesByHandle: vi.fn(async () => [
        makeEntry({ id: 'entry-alice-old', handle: 'alice', timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, content: 'Alice has been thinking about Matrix notifications.' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sendDM).toHaveBeenCalledWith('@alice:matrix.test', expect.stringContaining('Personalized digest body.'));
    expect(messagesCreate).toHaveBeenCalledWith(expect.objectContaining({
      model: PERSONALIZED_DIGEST_MODEL,
      messages: [expect.objectContaining({
        content: expect.stringContaining("Recipient's recent notebook corpus"),
      })],
    }));
  });

  it('does not require a profile object when the recipient has Matrix linked', async () => {
    const { sendDM } = registerMatrixPlatform();
    const alice = makeUser({
      handle: 'alice',
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.test', linkedAt: Date.now(), verified: true },
      ],
    });

    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [alice]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-bob', handle: 'bob', content: 'Bob wrote about shared notebook digests.' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sendDM).toHaveBeenCalledTimes(1);
  });

  it('can send a personalized digest from Matrix activity when there are no notebook entries', async () => {
    const { sendDM, queryRecentMessages } = registerMatrixPlatform();
    queryRecentMessages.mockResolvedValueOnce([
      {
        roomId: '!general:matrix.test',
        roomName: 'General',
        senderId: '@bob:matrix.test',
        senderHandle: 'bob',
        text: 'Bob shared context on Matrix server encryption.',
        timestamp: yesterdayAtNoon(),
        isDM: false,
      },
    ]).mockResolvedValueOnce([]);
    const alice = makeUser({
      handle: 'alice',
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.test', linkedAt: Date.now(), verified: true },
      ],
    });

    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [alice]),
      getEntriesSince: vi.fn(async () => []),
      getEntriesByHandle: vi.fn(async () => []),
      getEntriesAddressedTo: vi.fn(async () => []),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 1, failed: 0, skipped: 0 });
    expect(sendDM).toHaveBeenCalledWith('@alice:matrix.test', expect.stringContaining('Personalized digest body.'));
    const prompt = messagesCreate.mock.calls[0][0].messages[0].content;
    expect(prompt).toContain('Matrix conversations yesterday');
    expect(prompt).toContain('Bob shared context on Matrix server encryption');
  });

  it('skips users without a verified linked Matrix account', async () => {
    const { sendDM } = registerMatrixPlatform();
    const storage = makeStorage({
      getAllUsers: vi.fn(async () => [
        makeUser({ handle: 'alice' }),
      ]),
      getEntriesSince: vi.fn(async () => [
        makeEntry({ id: 'entry-bob', handle: 'bob' }),
      ]),
    });

    await expect(sendPersonalizedDigests(storage)).resolves.toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(sendDM).not.toHaveBeenCalled();
  });
});
