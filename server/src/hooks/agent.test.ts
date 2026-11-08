import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, StagedStorage, type JournalEntry } from '../storage.js';
import { MatrixPlatform, type MatrixHistoryMessage } from '../platform/matrix.js';
import type { Platform } from '../platform/types.js';
import {
  findRecentMatrixSparkConversation,
  getMatrixRoutingTargets,
  getPublishedEntryFromEvent,
  getSparkDebounceTopicTerms,
  getUnexpectedSparkHandles,
  handlePendingPublishCommand,
  hasLinkedPlatformAccount,
  notifyLinkedMatrixPendingEntry,
  triggerManualSpark,
  registerAgentHooks,
} from './agent.js';
import type { HookContext } from './types.js';
import type { HookRegistration } from './types.js';
import { HookDispatcher } from './dispatcher.js';

function makeEntry(overrides: Partial<JournalEntry> = {}): JournalEntry {
  return {
    id: 'entry-1',
    pseudonym: 'Test User#abc123',
    client: 'desktop' as const,
    content: 'This is a public notebook entry that is long enough to be eligible for Matrix posting.',
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('Matrix reply writeback with notice gating', () => {
  it.each(['public', 'private-group', 'manual', 'unverified'] as const)('%s reply preserves the audience and posting rules', async mode => {
    const published = new MemoryStorage();
    const storage = new StagedStorage(3600000, published, 'https://router.test');
    const hooks: HookRegistration[] = [];
    const dispatcher = new HookDispatcher();
    vi.spyOn(dispatcher, 'register').mockImplementation(hook => { hooks.push(hook); });
    registerAgentHooks(dispatcher);
    const handler = hooks.find(h => h.id === 'agent:platform-message')!.handler;
    try {
      await storage.createUser({ handle: 'alice', secretKeyHash: 'hash-alice',
        linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', verified: true, linkedAt: 1 }],
        ...(mode === 'manual' ? { postingRules: { schemaVersion: 1 as const, revision: 1, updatedAt: 1,
          mode: 'manual' as const, audience: 'public' as const, destinations: [], purpose: '', share: '', avoid: '', style: '', instructions: '' } } : {}),
      });
      await storage.createChannel({ id: 'lab', name: 'Private lab', visibility: 'private', joinRule: 'invite', createdBy: 'bob', createdAt: 1, skills: [],
        subscribers: [{ handle: 'bob', role: 'admin', joinedAt: 1 }, { handle: 'alice', role: 'member', joinedAt: 1 }] });
      const parent = await published.addEntry({ pseudonym: 'bob', handle: 'bob', client: 'code', content: 'Parent', timestamp: 1,
        ...(mode === 'private-group' ? { to: ['#lab'] } : {}) });
      const platform = makePlatform();
      await handler({ trigger: 'platform_message', storage, platforms: [platform], event: {
        id: 1, type: 'platform_message', timestamp: Date.now(), data: { platform: 'matrix', room_id: '!room', message_id: '$reply',
          sender_handle: 'alice', sender_id: mode === 'unverified' ? '@impostor:matrix.org' : '@alice:matrix.org', text: 'Exact reply text', reply_to_entry_id: parent.id },
      } });
      const pending = storage.getAllPendingEntries();
      if (mode === 'manual' || mode === 'unverified') {
        expect(pending).toEqual([]); expect(platform.sendMessage).not.toHaveBeenCalled(); return;
      }
      expect(pending).toHaveLength(1);
      expect(pending[0].to).toEqual(mode === 'private-group' ? ['#lab'] : []);
      expect(platform.sendMessage).toHaveBeenCalledWith('!room', expect.stringContaining('Exact reply text'), { replyTo: '$reply' });
      if (mode === 'public') expect(pending[0].sharingNotice?.evidence?.kind).toBe('agent_reported');
      else expect(pending[0].sharingNotice).toBeUndefined();
    } finally { storage.stop(); }
  });
});

class PendingMemoryStorage extends MemoryStorage {
  private pending = new Map<string, JournalEntry>();
  private nextPendingId = 1;

  async addEntry(entry: Omit<JournalEntry, 'id'>): Promise<JournalEntry> {
    const saved: JournalEntry = {
      ...entry,
      id: `pending-${this.nextPendingId++}`,
      publishAt: entry.publishAt ?? Date.now() + 60 * 60 * 1000,
    };
    this.pending.set(saved.id, saved);
    return saved;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    return this.pending.get(id) || super.getEntry(id);
  }

  getAllPendingEntries(): JournalEntry[] {
    return Array.from(this.pending.values());
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  async publishEntry(id: string): Promise<JournalEntry | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;

    this.pending.delete(id);
    const { publishAt, moderationHeld, moderationHoldReason, ...publishedEntry } = entry;
    return super.addEntry(publishedEntry);
  }

  async deleteEntry(id: string): Promise<void> {
    if (this.pending.delete(id)) return;
    await super.deleteEntry(id);
  }
}

function makePlatform(overrides: Partial<Platform> = {}): Platform {
  return {
    name: 'matrix',
    maxMessageLength: 65536,
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue('$message'),
    sendDM: vi.fn().mockResolvedValue('$dm'),
    createRoom: vi.fn(),
    inviteToRoom: vi.fn(),
    removeFromRoom: vi.fn(),
    setRoomTopic: vi.fn(),
    setUserRole: vi.fn(),
    deleteMessage: vi.fn(),
    resolveRouterHandle: vi.fn(),
    resolvePlatformId: vi.fn(),
    formatContent: (markdown: string) => markdown,
    ...overrides,
  } as Platform;
}

describe('getMatrixRoutingTargets', () => {
  it('posts normal public entries to feed', () => {
    expect(getMatrixRoutingTargets(makeEntry())).toEqual({
      postToFeed: true,
      channelDests: [],
    });
  });

  it('posts channel-addressed entries to channel rooms only', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      to: ['#books', '#feed'],
      visibility: 'private',
    }))).toEqual({
      postToFeed: false,
      channelDests: ['books', 'feed'],
    });
  });

  it('does not post direct messages to feed', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      to: ['@alice'],
      visibility: 'private',
    }))).toEqual({
      postToFeed: false,
      channelDests: [],
    });
  });

  it('does not post ai-only entries', () => {
    expect(getMatrixRoutingTargets(makeEntry({
      aiOnly: true,
      humanVisible: false,
    } as Partial<JournalEntry>))).toEqual({
      postToFeed: false,
      channelDests: [],
    });
  });
});

describe('getPublishedEntryFromEvent', () => {
  it('uses the stored entry when available', () => {
    const entry = makeEntry({ id: 'stored-entry' });
    expect(getPublishedEntryFromEvent(entry, {})).toBe(entry);
  });

  it('falls back to the event snapshot when storage misses', () => {
    const snapshot = makeEntry({ id: 'snapshot-entry', handle: 'james' });
    expect(getPublishedEntryFromEvent(null, { entry: snapshot })).toEqual(snapshot);
  });

  it('returns null when neither storage nor the event has a usable entry', () => {
    expect(getPublishedEntryFromEvent(null, {})).toBeNull();
    expect(getPublishedEntryFromEvent(null, { entry: { id: 'bad' } })).toBeNull();
  });
});

describe('hasLinkedPlatformAccount', () => {
  it('returns true for linked matrix accounts', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true },
      ],
    }, 'matrix')).toBe(true);
  });

  it('returns false when no linked matrix account exists', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'telegram', platformUserId: '1234', linkedAt: Date.now(), verified: true },
      ],
    }, 'matrix')).toBe(false);
  });

  it('returns false for explicitly unverified links', () => {
    expect(hasLinkedPlatformAccount({
      linkedAccounts: [
        { platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: false },
      ],
    }, 'matrix')).toBe(false);
  });
});

describe('pending Matrix review flow', () => {
  it('DMs the linked Matrix account when a post is pending', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Pending post content for review.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();
    const ctx = {
      trigger: 'entry_staged',
      event: { id: 1, type: 'entry_staged', timestamp: Date.now(), data: { entry_id: entry.id } },
      storage,
      platforms: [matrix],
    } as HookContext;

    await notifyLinkedMatrixPendingEntry(ctx, entry);

    expect(matrix.sendDM).toHaveBeenCalledWith(
      '@alice:matrix.org',
      expect.stringContaining('Reply to this message with `publish`'),
    );
    expect(matrix.sendDM).toHaveBeenCalledWith(
      '@alice:matrix.org',
      expect.stringContaining('`delete`'),
    );
  });

  it('publishes a pending entry from a linked Matrix DM command', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Ready to publish from Matrix.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();

    const handled = await handlePendingPublishCommand({
      storage,
      platform: matrix,
      platformName: 'matrix',
      roomId: '!dm:matrix.org',
      messageId: '$request',
      senderId: '@alice:matrix.org',
      query: `publish ${entry.id}`,
    });

    expect(handled).toBe(true);
    expect(storage.isPending(entry.id)).toBe(false);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!dm:matrix.org',
      expect.stringContaining(`Published entry ${entry.id}`),
      { replyTo: '$request' },
    );
  });

  it('deletes a pending entry from a linked Matrix DM command', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Delete this from Matrix.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();

    const handled = await handlePendingPublishCommand({
      storage,
      platform: matrix,
      platformName: 'matrix',
      roomId: '!dm:matrix.org',
      messageId: '$request',
      senderId: '@alice:matrix.org',
      query: `delete ${entry.id}`,
    });

    expect(handled).toBe(true);
    expect(storage.isPending(entry.id)).toBe(false);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!dm:matrix.org',
      `Deleted entry ${entry.id}. It will not publish.`,
      { replyTo: '$request' },
    );
  });

  it('publishes a pending entry from a linked Matrix reply command', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Approve by reply.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();

    const handled = await handlePendingPublishCommand({
      storage,
      platform: matrix,
      platformName: 'matrix',
      roomId: '!dm:matrix.org',
      messageId: '$reply',
      senderId: '@alice:matrix.org',
      query: 'publish',
      replyPendingEntryId: entry.id,
    });

    expect(handled).toBe(true);
    expect(storage.isPending(entry.id)).toBe(false);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!dm:matrix.org',
      expect.stringContaining(`Published entry ${entry.id}`),
      { replyTo: '$reply' },
    );
  });

  it('deletes a pending entry from a linked Matrix reply command', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Delete by reply.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();

    const handled = await handlePendingPublishCommand({
      storage,
      platform: matrix,
      platformName: 'matrix',
      roomId: '!dm:matrix.org',
      messageId: '$reply',
      senderId: '@alice:matrix.org',
      query: 'delete',
      replyPendingEntryId: entry.id,
    });

    expect(handled).toBe(true);
    expect(storage.isPending(entry.id)).toBe(false);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!dm:matrix.org',
      `Deleted entry ${entry.id}. It will not publish.`,
      { replyTo: '$reply' },
    );
  });

  it('rejects publish commands from Matrix accounts that are not linked to the author', async () => {
    const storage = new PendingMemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: 'hash-alice',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@alice:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    await storage.createUser({
      handle: 'bob',
      secretKeyHash: 'hash-bob',
      linkedAccounts: [{ platform: 'matrix', platformUserId: '@bob:matrix.org', linkedAt: Date.now(), verified: true }],
    });
    const entry = await storage.addEntry({
      pseudonym: 'Alice#abc',
      handle: 'alice',
      client: 'code',
      content: 'Alice owns this pending post.',
      timestamp: Date.now(),
    });
    const matrix = makePlatform();

    await handlePendingPublishCommand({
      storage,
      platform: matrix,
      platformName: 'matrix',
      roomId: '!dm:matrix.org',
      senderId: '@bob:matrix.org',
      query: `publish ${entry.id}`,
    });

    expect(storage.isPending(entry.id)).toBe(true);
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!dm:matrix.org',
      'You can only publish your own pending posts.',
      { replyTo: undefined },
    );
  });
});

describe('getUnexpectedSparkHandles', () => {
  it('allows only the two spark participants in generated spark text', () => {
    expect(
      getUnexpectedSparkHandles(
        'Hey @socrates1024 and @ggg, this is for you.',
        'socrates1024',
        'ggg',
      ),
    ).toEqual([]);
  });

  it('flags third-party handles so the room pair cannot diverge from the message', () => {
    expect(
      getUnexpectedSparkHandles(
        'Hey @socrates1024 and @sxysun, @ggg has relevant work here.',
        'socrates1024',
        'sxysun',
      ),
    ).toEqual(['ggg']);
  });
});

describe('spark Matrix debounce guard', () => {
  const matrixMessage = (overrides: Partial<MatrixHistoryMessage>): MatrixHistoryMessage => ({
    roomId: '!general:mtrx.example.test',
    roomName: 'General',
    senderId: '@unknown:mtrx.example.test',
    text: '',
    timestamp: Date.now(),
    isDM: false,
    ...overrides,
  });

  it('extracts topic terms from the spark evidence', () => {
    const terms = getSparkDebounceTopicTerms(
      { reason: 'Both are talking about provenance and authority boundaries.' },
      {
        overlapTopics: ['provenance', 'trust'],
        matchingEntries: [makeEntry({ content: 'Evidence should carry authority across contexts.' })],
      },
      makeEntry({
        content: 'Context bridges need explicit provenance.',
        topicHints: ['boundary design'],
        keywords: ['identity'],
      }),
    );

    expect(terms).toContain('provenance');
    expect(terms).toContain('trust');
    expect(terms).toContain('boundary');
  });

  it('detects when both spark participants are already discussing the topic in the same Matrix room', () => {
    const conversation = findRecentMatrixSparkConversation([
      matrixMessage({
        senderHandle: 'james',
        senderId: '@james:mtrx.example.test',
        text: 'The boundary problem is really about provenance staying attached to data.',
      }),
      matrixMessage({
        senderHandle: 'socrates1024',
        senderId: '@socrates1024:mtrx.example.test',
        text: 'Right, authority has to travel with the evidence or the trust model falls apart.',
      }),
    ], 'james', 'socrates1024', ['provenance', 'authority', 'boundary', 'trust']);

    expect(conversation).toMatchObject({
      roomId: '!general:mtrx.example.test',
      sourceCount: 1,
      targetCount: 1,
    });
    expect(conversation?.matchedTerms).toContain('provenance');
  });

  it('does not debounce when only one participant has used the spark topic terms', () => {
    const conversation = findRecentMatrixSparkConversation([
      matrixMessage({
        senderHandle: 'james',
        text: 'The boundary problem is really about provenance staying attached to data.',
      }),
      matrixMessage({
        senderHandle: 'socrates1024',
        text: 'Yeah, agreed.',
      }),
    ], 'james', 'socrates1024', ['provenance', 'authority', 'boundary', 'trust']);

    expect(conversation).toBeNull();
  });

  it('does not use DMs as broad spark debounce evidence', () => {
    const conversation = findRecentMatrixSparkConversation([
      matrixMessage({
        roomId: '!dm:mtrx.example.test',
        roomName: 'James DM',
        isDM: true,
        senderHandle: 'james',
        text: 'Provenance and boundary design.',
      }),
      matrixMessage({
        roomId: '!dm:mtrx.example.test',
        roomName: 'James DM',
        isDM: true,
        senderHandle: 'socrates1024',
        text: 'Authority and trust.',
      }),
    ], 'james', 'socrates1024', ['provenance', 'authority', 'boundary', 'trust']);

    expect(conversation).toBeNull();
  });
});

describe('triggerManualSpark', () => {
  it('forwards the source entry into #sparks and replies with the warm message', async () => {
    const storage = new MemoryStorage();
    await storage.createUser({ handle: 'socrates1024', secretKeyHash: 'hash-s' });
    await storage.createUser({ handle: 'ggg', secretKeyHash: 'hash-g' });
    const sourceEntry = await storage.addEntry({
      pseudonym: 'socrates1024',
      handle: 'socrates1024',
      client: 'code' as const,
      content: 'Hit the same wall around boundary design again — chasing what makes provenance load-bearing.',
      timestamp: Date.now(),
    });

    const platform = new MatrixPlatform({
      serverUrl: 'https://mtrx.example.test',
      serverName: 'mtrx.example.test',
      botSecretKey: 'test-secret',
      botHandle: 'router',
      resolveLinkedPlatformId: async (_platform, handle) => `@${handle}:matrix.org`,
    });

    const sparksRoomId = '!sparks:mtrx.example.test';
    (platform as any).channelRooms.set('sparks', sparksRoomId);
    (platform as any).ensureRoomEncryptionConfigured = vi.fn().mockResolvedValue(undefined);

    const createRoom = vi.fn();
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ event_id: '$forwarded-entry' })
      .mockResolvedValueOnce({ event_id: '$warm-reply' });

    (platform as any).client = {
      createRoom,
      sendMessage,
      getRoom: vi.fn(() => null),
    };

    const warmMessage = 'Hey @socrates1024 and @ggg, you both keep landing on the same wall — compare notes?';
    await triggerManualSpark(
      'socrates1024',
      'ggg',
      'Manual test for the correct pair.',
      [platform],
      storage,
      warmMessage,
    );

    expect(createRoom).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const [forwardRoomId, forwardContent] = sendMessage.mock.calls[0];
    expect(forwardRoomId).toBe(sparksRoomId);
    expect(forwardContent.entry_id).toBe(sourceEntry.id);

    const [replyRoomId, replyContent] = sendMessage.mock.calls[1];
    expect(replyRoomId).toBe(sparksRoomId);
    expect(replyContent.body).toContain('keep landing on the same wall — compare notes?');
    // @-handles get rendered as Matrix MXIDs once the linked-platform resolver runs.
    expect(replyContent.body).toContain('@socrates1024:matrix.org');
    expect(replyContent.body).toContain('@ggg:matrix.org');
    expect(replyContent['m.relates_to']?.['m.in_reply_to']?.event_id).toBe('$forwarded-entry');
  });
});
