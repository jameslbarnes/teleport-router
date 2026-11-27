import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage } from './storage.js';
import { hashSecretKey } from './identity.js';
import {
  parseDestination,
  parseDestinations,
  resolveDestinations,
  isInternalUrl,
  getDefaultVisibility,
  canViewEntry,
  canView,
  normalizeEntry,
  isDefaultAiOnly,
  isEntryAiOnly,
  deliverEntry,
  type DeliveryConfig,
} from './delivery.js';
import type { JournalEntry, User } from './storage.js';
import type { EmailClient, NotificationService } from './notifications.js';

describe('Delivery module', () => {
  describe('parseDestination', () => {
    it('should parse @handle destinations', () => {
      const dest = parseDestination('@alice');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });

    it('should parse @handle with uppercase', () => {
      const dest = parseDestination('@Alice');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });

    it('should parse email destinations', () => {
      const dest = parseDestination('bob@example.com');
      expect(dest.type).toBe('email');
      expect((dest as any).email).toBe('bob@example.com');
    });

    it('should parse webhook URL destinations', () => {
      const dest = parseDestination('https://webhook.example.com/hook');
      expect(dest.type).toBe('webhook');
      expect((dest as any).url).toBe('https://webhook.example.com/hook');
    });

    it('should parse http webhook URLs', () => {
      const dest = parseDestination('http://localhost:3000/hook');
      expect(dest.type).toBe('webhook');
      expect((dest as any).url).toBe('http://localhost:3000/hook');
    });

    it('should parse #channel destinations', () => {
      const dest = parseDestination('#flashbots');
      expect(dest.type).toBe('channel');
      expect((dest as any).channelId).toBe('flashbots');
    });

    it('should parse #channel with uppercase', () => {
      const dest = parseDestination('#FlashBots');
      expect(dest.type).toBe('channel');
      expect((dest as any).channelId).toBe('flashbots');
    });

    it('should treat bare handles as handles', () => {
      const dest = parseDestination('charlie');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('charlie');
    });

    it('should trim whitespace', () => {
      const dest = parseDestination('  @alice  ');
      expect(dest.type).toBe('handle');
      expect((dest as any).handle).toBe('alice');
    });
  });

  describe('parseDestinations', () => {
    it('should parse multiple destinations', () => {
      const dests = parseDestinations([
        '@alice',
        'bob@example.com',
        'https://webhook.example.com/hook',
      ]);

      expect(dests).toHaveLength(3);
      expect(dests[0].type).toBe('handle');
      expect(dests[1].type).toBe('email');
      expect(dests[2].type).toBe('webhook');
    });
  });

  describe('resolveDestinations', () => {
    let storage: MemoryStorage;

    beforeEach(async () => {
      storage = new MemoryStorage();
      // Create test users
      await storage.createUser({
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
        email: 'alice@example.com',
      });
      await storage.createUser({
        handle: 'bob',
        secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
        email: 'bob@example.com',
      });
    });

    it('should resolve @handle to user', async () => {
      const dests = await resolveDestinations(['@alice'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('handle');
      expect((dests[0] as any).user).toBeDefined();
      expect((dests[0] as any).user.handle).toBe('alice');
    });

    it('should resolve email to user when email matches', async () => {
      const dests = await resolveDestinations(['alice@example.com'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('email');
      expect((dests[0] as any).user).toBeDefined();
      expect((dests[0] as any).user.handle).toBe('alice');
    });

    it('should not attach user to unknown handle', async () => {
      const dests = await resolveDestinations(['@unknown'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('handle');
      expect((dests[0] as any).user).toBeUndefined();
    });

    it('should not attach user to unknown email', async () => {
      const dests = await resolveDestinations(['unknown@example.com'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('email');
      expect((dests[0] as any).user).toBeUndefined();
    });

    it('should pass through webhook URLs unchanged', async () => {
      const dests = await resolveDestinations(['https://webhook.example.com/hook'], storage);

      expect(dests).toHaveLength(1);
      expect(dests[0].type).toBe('webhook');
      expect((dests[0] as any).url).toBe('https://webhook.example.com/hook');
    });
  });

  describe('isInternalUrl', () => {
    it('should block localhost', () => {
      expect(isInternalUrl('http://localhost:3000/hook')).toBe(true);
      expect(isInternalUrl('https://localhost/hook')).toBe(true);
    });

    it('should block 127.0.0.1', () => {
      expect(isInternalUrl('http://127.0.0.1:3000/hook')).toBe(true);
    });

    it('should block private IP ranges', () => {
      expect(isInternalUrl('http://10.0.0.1/hook')).toBe(true);
      expect(isInternalUrl('http://172.16.0.1/hook')).toBe(true);
      expect(isInternalUrl('http://192.168.1.1/hook')).toBe(true);
    });

    it('should block link-local addresses', () => {
      expect(isInternalUrl('http://169.254.1.1/hook')).toBe(true);
    });

    it('should allow public URLs', () => {
      expect(isInternalUrl('https://webhook.example.com/hook')).toBe(false);
      expect(isInternalUrl('https://api.github.com/webhooks')).toBe(false);
    });

    it('should block invalid URLs', () => {
      expect(isInternalUrl('not-a-url')).toBe(true);
    });
  });

  describe('getDefaultVisibility', () => {
    it('should return private when to is set but no inReplyTo', () => {
      expect(getDefaultVisibility(['@alice'], undefined)).toBe('private');
      expect(getDefaultVisibility(['@alice', '@bob'], undefined)).toBe('private');
    });

    it('should return public when inReplyTo is set (reply)', () => {
      expect(getDefaultVisibility(['@alice'], 'entry123')).toBe('public');
    });

    it('should return public when neither to nor inReplyTo is set', () => {
      expect(getDefaultVisibility(undefined, undefined)).toBe('public');
      expect(getDefaultVisibility([], undefined)).toBe('public');
    });
  });

  describe('canViewEntry', () => {
    it('should allow authors to see their own entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'author',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['@recipient'],
      };

      expect(canViewEntry(entry, 'author', undefined, true)).toBe(true);
    });

    it('should allow everyone to see public entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'Public post',
        timestamp: Date.now(),
        visibility: 'public' as const,
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
      expect(canViewEntry(entry, 'randomuser', undefined, false)).toBe(true);
    });

    it('should allow everyone to see ai-only entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'AI only post',
        timestamp: Date.now(),
        visibility: 'ai-only' as const,
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
    });

    it('should only allow recipients to see private entries', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        handle: 'sender',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['@alice', 'bob@example.com'],
      };

      // Recipients can see
      expect(canViewEntry(entry, 'alice', undefined, false)).toBe(true);
      expect(canViewEntry(entry, undefined, 'bob@example.com', false)).toBe(true);

      // Non-recipients cannot see
      expect(canViewEntry(entry, 'charlie', undefined, false)).toBe(false);
      expect(canViewEntry(entry, undefined, 'charlie@example.com', false)).toBe(false);
      expect(canViewEntry(entry, undefined, undefined, false)).toBe(false);
    });

    it('should handle case-insensitive email matching', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'Private message',
        timestamp: Date.now(),
        visibility: 'private' as const,
        to: ['Bob@Example.Com'],
      };

      expect(canViewEntry(entry, undefined, 'bob@example.com', false)).toBe(true);
      expect(canViewEntry(entry, undefined, 'BOB@EXAMPLE.COM', false)).toBe(true);
    });

    it('should default to public visibility when not specified', () => {
      const entry = {
        id: 'entry1',
        pseudonym: 'Test#123',
        client: 'desktop' as const,
        content: 'No visibility set',
        timestamp: Date.now(),
      };

      expect(canViewEntry(entry, undefined, undefined, false)).toBe(true);
    });
  });
});

describe('MemoryStorage getUserByEmail', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
      email: 'alice@example.com',
    });
    await storage.createUser({
      handle: 'bob',
      secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
      email: 'Bob@Example.Com', // Mixed case
    });
    await storage.createUser({
      handle: 'noemail',
      secretKeyHash: hashSecretKey('noemail-secret-key-1234567890'),
    });
  });

  it('should find user by exact email', async () => {
    const user = await storage.getUserByEmail('alice@example.com');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('alice');
  });

  it('should find user by email case-insensitively', async () => {
    const user = await storage.getUserByEmail('ALICE@EXAMPLE.COM');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('alice');
  });

  it('should find user with mixed case stored email', async () => {
    const user = await storage.getUserByEmail('bob@example.com');
    expect(user).toBeDefined();
    expect(user!.handle).toBe('bob');
  });

  it('should return null for unknown email', async () => {
    const user = await storage.getUserByEmail('unknown@example.com');
    expect(user).toBeNull();
  });
});

describe('MemoryStorage getEntriesAddressedTo', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
  });

  it('should find entries addressed to @handle', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to alice',
      timestamp: Date.now(),
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Message to alice');
  });

  it('should find entries addressed to email', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message by email',
      timestamp: Date.now(),
      to: ['alice@example.com'],
    });

    const entries = await storage.getEntriesAddressedTo('alice', 'alice@example.com');
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe('Message by email');
  });

  it('should find entries addressed to either handle or email', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'By handle',
      timestamp: Date.now() - 1000,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'By email',
      timestamp: Date.now(),
      to: ['alice@example.com'],
    });

    const entries = await storage.getEntriesAddressedTo('alice', 'alice@example.com');
    expect(entries).toHaveLength(2);
  });

  it('should return empty array when no entries addressed to user', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Message to bob',
      timestamp: Date.now(),
      to: ['@bob'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(0);
  });

  it('should return entries sorted by timestamp descending', async () => {
    const now = Date.now();
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Oldest',
      timestamp: now - 2000,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Newest',
      timestamp: now,
      to: ['@alice'],
    });
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Middle',
      timestamp: now - 1000,
      to: ['@alice'],
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries[0].content).toBe('Newest');
    expect(entries[1].content).toBe('Middle');
    expect(entries[2].content).toBe('Oldest');
  });

  it('should respect limit parameter', async () => {
    for (let i = 0; i < 10; i++) {
      await storage.addEntry({
        pseudonym: 'Sender#123',
        client: 'desktop',
        content: `Message ${i}`,
        timestamp: Date.now() + i,
        to: ['@alice'],
      });
    }

    const entries = await storage.getEntriesAddressedTo('alice', undefined, 5);
    expect(entries).toHaveLength(5);
  });

  it('should not return entries without to field', async () => {
    await storage.addEntry({
      pseudonym: 'Sender#123',
      client: 'desktop',
      content: 'Public post (no to)',
      timestamp: Date.now(),
    });

    const entries = await storage.getEntriesAddressedTo('alice');
    expect(entries).toHaveLength(0);
  });
});

describe('MemoryStorage getRepliesTo', () => {
  let storage: MemoryStorage;

  beforeEach(async () => {
    storage = new MemoryStorage();
  });

  it('should find replies to an entry', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original post',
      timestamp: Date.now(),
    });

    await storage.addEntry({
      pseudonym: 'Replier#456',
      client: 'desktop',
      content: 'This is a reply',
      timestamp: Date.now() + 1000,
      inReplyTo: parent.id,
    });

    const replies = await storage.getRepliesTo(parent.id);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toBe('This is a reply');
    expect(replies[0].inReplyTo).toBe(parent.id);
  });

  it('should return empty array for entry with no replies', async () => {
    const entry = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'No replies here',
      timestamp: Date.now(),
    });

    const replies = await storage.getRepliesTo(entry.id);
    expect(replies).toHaveLength(0);
  });

  it('should return replies sorted by timestamp ascending (oldest first)', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    const now = Date.now();
    await storage.addEntry({
      pseudonym: 'Replier#1',
      client: 'desktop',
      content: 'Third reply',
      timestamp: now + 3000,
      inReplyTo: parent.id,
    });
    await storage.addEntry({
      pseudonym: 'Replier#2',
      client: 'desktop',
      content: 'First reply',
      timestamp: now + 1000,
      inReplyTo: parent.id,
    });
    await storage.addEntry({
      pseudonym: 'Replier#3',
      client: 'desktop',
      content: 'Second reply',
      timestamp: now + 2000,
      inReplyTo: parent.id,
    });

    const replies = await storage.getRepliesTo(parent.id);
    expect(replies).toHaveLength(3);
    expect(replies[0].content).toBe('First reply');
    expect(replies[1].content).toBe('Second reply');
    expect(replies[2].content).toBe('Third reply');
  });

  it('should only return direct replies, not replies to replies', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    const reply = await storage.addEntry({
      pseudonym: 'Replier#1',
      client: 'desktop',
      content: 'Direct reply',
      timestamp: Date.now() + 1000,
      inReplyTo: parent.id,
    });

    await storage.addEntry({
      pseudonym: 'Replier#2',
      client: 'desktop',
      content: 'Reply to reply',
      timestamp: Date.now() + 2000,
      inReplyTo: reply.id,
    });

    const parentReplies = await storage.getRepliesTo(parent.id);
    expect(parentReplies).toHaveLength(1);
    expect(parentReplies[0].content).toBe('Direct reply');

    const nestedReplies = await storage.getRepliesTo(reply.id);
    expect(nestedReplies).toHaveLength(1);
    expect(nestedReplies[0].content).toBe('Reply to reply');
  });

  it('should respect limit parameter', async () => {
    const parent = await storage.addEntry({
      pseudonym: 'Author#123',
      client: 'desktop',
      content: 'Original',
      timestamp: Date.now(),
    });

    for (let i = 0; i < 10; i++) {
      await storage.addEntry({
        pseudonym: 'Replier#' + i,
        client: 'desktop',
        content: `Reply ${i}`,
        timestamp: Date.now() + i * 1000,
        inReplyTo: parent.id,
      });
    }

    const replies = await storage.getRepliesTo(parent.id, 5);
    expect(replies).toHaveLength(5);
  });
});

// ═══════════════════════════════════════════════════════════════
// NEW: Unified Privacy Model tests
// ═══════════════════════════════════════════════════════════════

describe('normalizeEntry', () => {
  const baseEntry: JournalEntry = {
    id: '1',
    pseudonym: 'Test#123',
    client: 'code',
    content: 'test',
    timestamp: Date.now(),
  };

  it('should migrate channel field to #channel in to', () => {
    const entry = { ...baseEntry, channel: 'flashbots' };
    const normalized = normalizeEntry(entry);
    expect(normalized.to).toContain('#flashbots');
  });

  it('should not duplicate #channel if already in to', () => {
    const entry = { ...baseEntry, channel: 'flashbots', to: ['#flashbots', '@alice'] };
    const normalized = normalizeEntry(entry);
    expect(normalized.to!.filter(d => d === '#flashbots')).toHaveLength(1);
    expect(normalized.to).toHaveLength(2);
  });

  it('should set aiOnly from visibility: ai-only', () => {
    const entry = { ...baseEntry, visibility: 'ai-only' as const };
    const normalized = normalizeEntry(entry);
    expect(normalized.aiOnly).toBe(true);
  });

  it('should set aiOnly from humanVisible: false', () => {
    const entry = { ...baseEntry, humanVisible: false };
    const normalized = normalizeEntry(entry);
    expect(normalized.aiOnly).toBe(true);
  });

  it('should not set aiOnly for public entries', () => {
    const normalized = normalizeEntry(baseEntry);
    expect(normalized.aiOnly).toBeUndefined();
  });

  it('should not override explicit aiOnly', () => {
    const entry = { ...baseEntry, aiOnly: false, humanVisible: false };
    const normalized = normalizeEntry(entry);
    expect(normalized.aiOnly).toBe(false);
  });

  it('should not mutate the original entry', () => {
    const entry = { ...baseEntry, channel: 'flashbots' };
    normalizeEntry(entry);
    expect(entry.to).toBeUndefined();
  });

  it('should merge channel into existing to array', () => {
    const entry = { ...baseEntry, channel: 'flashbots', to: ['@alice'] };
    const normalized = normalizeEntry(entry);
    expect(normalized.to).toEqual(['@alice', '#flashbots']);
  });
});

describe('isDefaultAiOnly', () => {
  it('should return false by default', () => {
    const user = { handle: 'test', secretKeyHash: 'x', createdAt: 0 } as User;
    expect(isDefaultAiOnly(user)).toBe(false);
  });

  it('should read defaultAiOnly when set', () => {
    const user = { handle: 'test', secretKeyHash: 'x', createdAt: 0, defaultAiOnly: true } as any;
    expect(isDefaultAiOnly(user)).toBe(true);
  });

  it('should fall back to !defaultHumanVisible', () => {
    const user = { handle: 'test', secretKeyHash: 'x', createdAt: 0, defaultHumanVisible: false } as User;
    expect(isDefaultAiOnly(user)).toBe(true);
  });

  it('should prefer defaultAiOnly over defaultHumanVisible', () => {
    const user = { handle: 'test', secretKeyHash: 'x', createdAt: 0, defaultAiOnly: false, defaultHumanVisible: false } as any;
    expect(isDefaultAiOnly(user)).toBe(false);
  });
});

describe('isEntryAiOnly', () => {
  const base: JournalEntry = { id: '1', pseudonym: 'T#1', client: 'code', content: 'x', timestamp: 0 };

  it('should return false by default', () => {
    expect(isEntryAiOnly(base)).toBe(false);
  });

  it('should read aiOnly when set', () => {
    expect(isEntryAiOnly({ ...base, aiOnly: true })).toBe(true);
  });

  it('should fall back to !humanVisible', () => {
    expect(isEntryAiOnly({ ...base, humanVisible: false })).toBe(true);
    expect(isEntryAiOnly({ ...base, humanVisible: true })).toBe(false);
  });

  it('should prefer aiOnly over humanVisible', () => {
    expect(isEntryAiOnly({ ...base, aiOnly: false, humanVisible: false })).toBe(false);
  });
});

describe('canView (async, unified model)', () => {
  let storage: MemoryStorage;

  const baseEntry: JournalEntry = {
    id: '1',
    pseudonym: 'Test#123',
    client: 'code',
    content: 'test',
    timestamp: Date.now(),
  };

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.createUser({ handle: 'alice', secretKeyHash: hashSecretKey('alice-key-12345') });
    await storage.createUser({ handle: 'bob', secretKeyHash: hashSecretKey('bob-key-123456') });
  });

  it('should allow author to view their own entry', async () => {
    const entry = { ...baseEntry, to: ['@alice'] };
    expect(await canView(entry, 'bob', undefined, true, storage)).toBe(true);
  });

  it('should allow everyone to view public entries (no to)', async () => {
    expect(await canView(baseEntry, undefined, undefined, false, storage)).toBe(true);
    expect(await canView(baseEntry, 'alice', undefined, false, storage)).toBe(true);
  });

  it('should allow everyone to view entries with empty to', async () => {
    const entry = { ...baseEntry, to: [] };
    expect(await canView(entry, undefined, undefined, false, storage)).toBe(true);
  });

  it('should restrict DMs to recipients', async () => {
    const entry = { ...baseEntry, to: ['@alice'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(true);
    expect(await canView(entry, 'bob', undefined, false, storage)).toBe(false);
    expect(await canView(entry, undefined, undefined, false, storage)).toBe(false);
  });

  it('should allow email recipients', async () => {
    const entry = { ...baseEntry, to: ['alice@example.com'] };
    expect(await canView(entry, undefined, 'alice@example.com', false, storage)).toBe(true);
    expect(await canView(entry, undefined, 'bob@example.com', false, storage)).toBe(false);
  });

  it('should allow channel subscribers (live lookup)', async () => {
    await storage.createChannel({
      id: 'test-ch',
      name: 'Test',
      visibility: 'public',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [{ handle: 'alice', role: 'admin', joinedAt: Date.now() }],
    });

    const entry = { ...baseEntry, to: ['#test-ch'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(true);
    expect(await canView(entry, 'bob', undefined, false, storage)).toBe(false);

    // Now bob joins — should see old entries (live resolution)
    await storage.addSubscriber('test-ch', 'bob', 'member');
    expect(await canView(entry, 'bob', undefined, false, storage)).toBe(true);
  });

  it('should allow access if ANY destination matches', async () => {
    const entry = { ...baseEntry, to: ['@alice', '@charlie'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(true);
  });

  it('should handle mixed destinations (@handle + #channel)', async () => {
    await storage.createChannel({
      id: 'mixed-ch',
      name: 'Mixed',
      visibility: 'public',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [
        { handle: 'alice', role: 'admin', joinedAt: Date.now() },
        { handle: 'bob', role: 'member', joinedAt: Date.now() },
      ],
    });

    const entry = { ...baseEntry, to: ['@alice', '#mixed-ch'] };
    // bob is channel member, should have access
    expect(await canView(entry, 'bob', undefined, false, storage)).toBe(true);
  });

  it('should reuse channel membership cache across checks', async () => {
    await storage.createChannel({
      id: 'cached-ch',
      name: 'Cached',
      visibility: 'public',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [{ handle: 'alice', role: 'admin', joinedAt: Date.now() }],
    });

    const entry = { ...baseEntry, to: ['#cached-ch'] };
    const channelAccessCache = new Map<string, boolean>();
    let channelLookupCount = 0;

    const spyStorage = {
      getChannel: async (channelId: string) => {
        channelLookupCount += 1;
        return storage.getChannel(channelId);
      },
    } as unknown as MemoryStorage;

    expect(await canView(entry, 'alice', undefined, false, spyStorage, channelAccessCache)).toBe(true);
    expect(await canView(entry, 'alice', undefined, false, spyStorage, channelAccessCache)).toBe(true);
    expect(channelLookupCount).toBe(1);
  });

  it('should deny webhook-only entries to non-authors', async () => {
    const entry = { ...baseEntry, to: ['https://webhook.example.com'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(false);
  });

  it('should handle non-existent channel gracefully', async () => {
    const entry = { ...baseEntry, to: ['#nonexistent'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(false);
  });

  it('should be case-insensitive for handles', async () => {
    const entry = { ...baseEntry, to: ['@Alice'] };
    expect(await canView(entry, 'alice', undefined, false, storage)).toBe(true);
  });

  it('should be case-insensitive for emails', async () => {
    const entry = { ...baseEntry, to: ['Alice@Example.com'] };
    expect(await canView(entry, undefined, 'alice@example.com', false, storage)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
// Group Email Batching tests
// ═══════════════════════════════════════════════════════════════

function createMockEmailClient(): EmailClient & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    async send(params) {
      calls.push(params);
    },
  };
}

function createMockNotificationService(): NotificationService {
  return {
    async sendDailyDigests() { return { sent: 0, failed: 0 }; },
    async sendTestDigest() { return null; },
    async sendVerificationEmail() { return false; },
  };
}

describe('deliverEntry group email batching', () => {
  let storage: MemoryStorage;
  let emailClient: ReturnType<typeof createMockEmailClient>;
  let notificationService: NotificationService;

  beforeEach(async () => {
    storage = new MemoryStorage();
    emailClient = createMockEmailClient();
    notificationService = createMockNotificationService();

    // Create test users
    await storage.createUser({
      handle: 'author',
      secretKeyHash: hashSecretKey('author-key-1234567890123'),
      email: 'author@example.com',
      emailVerified: true,
    });
    await storage.createUser({
      handle: 'alice',
      secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
      email: 'alice@example.com',
      emailVerified: true,
    });
    await storage.createUser({
      handle: 'bob',
      secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
      email: 'bob@example.com',
      emailVerified: true,
    });
  });

  function makeConfig(): DeliveryConfig {
    return {
      storage,
      notificationService,
      emailClient,
      fromEmail: 'notify@router.test',
      baseUrl: 'https://router.test',
    };
  }

  it('should send one group email for multiple @handle recipients', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Hello everyone',
      timestamp: Date.now(),
      to: ['@alice', '@bob'],
    };

    const results = await deliverEntry(entry, makeConfig());

    // Both destinations should succeed
    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);

    // Only ONE email should be sent (group email)
    expect(emailClient.calls).toHaveLength(1);

    // The email should have both recipients in `to`
    const call = emailClient.calls[0];
    expect(call.to).toEqual(['alice@example.com', 'bob@example.com']);

    // Author should be CC'd (since they're not a recipient)
    expect(call.cc).toBe('author@example.com');
    expect(call.replyTo).toBe('author@example.com');
  });

  it('should send one email for single @handle recipient', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Just for alice',
      timestamp: Date.now(),
      to: ['@alice'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    expect(emailClient.calls).toHaveLength(1);
    expect(emailClient.calls[0].to).toEqual(['alice@example.com']);
    expect(emailClient.calls[0].cc).toBe('author@example.com');
  });

  it('should batch @handles and bare emails into one group email', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Mixed recipients',
      timestamp: Date.now(),
      to: ['@alice', 'external@example.com'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(2);
    expect(results.every(r => r.success)).toBe(true);

    // One group email with both
    expect(emailClient.calls).toHaveLength(1);
    expect(emailClient.calls[0].to).toEqual(['alice@example.com', 'external@example.com']);
  });

  it('should skip #channels and deliver webhooks separately', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Mixed everything',
      timestamp: Date.now(),
      to: ['@alice', '#flashbots'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(2);
    // Channel should succeed (no active delivery needed)
    expect(results.find(r => r.type === 'channel')?.success).toBe(true);

    // Only one email to alice
    expect(emailClient.calls).toHaveLength(1);
    expect(emailClient.calls[0].to).toEqual(['alice@example.com']);
  });

  it('should not put author in both to and cc', async () => {
    // Author is also a recipient
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Including myself',
      timestamp: Date.now(),
      to: ['@alice', '@author'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(2);

    expect(emailClient.calls).toHaveLength(1);
    const call = emailClient.calls[0];
    // Author is in to, so should NOT be in cc
    expect(call.to).toContain('author@example.com');
    expect(call.cc).toBeUndefined();
    // But replyTo should still be set
    expect(call.replyTo).toBe('author@example.com');
  });

  it('should send no email when all handles lack verified email', async () => {
    await storage.createUser({
      handle: 'noemail',
      secretKeyHash: hashSecretKey('noemail-key-12345678901234'),
      // No email at all
    });

    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Nobody to email',
      timestamp: Date.now(),
      to: ['@noemail'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true); // Handle resolved OK

    // No email should be sent
    expect(emailClient.calls).toHaveLength(0);
  });

  it('should skip recipients who disabled notifications', async () => {
    await storage.createUser({
      handle: 'muted',
      secretKeyHash: hashSecretKey('muted-key-12345678901234'),
      email: 'muted@example.com',
      emailVerified: true,
      emailPrefs: { comments: false, digest: true },
    });

    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Muted user',
      timestamp: Date.now(),
      to: ['@alice', '@muted'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(2);

    // Only alice should get the email, muted should be excluded
    expect(emailClient.calls).toHaveLength(1);
    expect(emailClient.calls[0].to).toEqual(['alice@example.com']);
  });

  it('should report unknown handle as failure', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Unknown user',
      timestamp: Date.now(),
      to: ['@nonexistent'],
    };

    const results = await deliverEntry(entry, makeConfig());

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('User not found');

    // No email sent
    expect(emailClient.calls).toHaveLength(0);
  });

  it('should return empty results for entries with no to field', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      client: 'desktop',
      content: 'Public post',
      timestamp: Date.now(),
    };

    const results = await deliverEntry(entry, makeConfig());
    expect(results).toHaveLength(0);
    expect(emailClient.calls).toHaveLength(0);
  });

  it('should not send email when no email client configured', async () => {
    const configNoEmail = {
      ...makeConfig(),
      emailClient: undefined,
    };

    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'No email client',
      timestamp: Date.now(),
      to: ['external@example.com'],
    };

    const results = await deliverEntry(entry, configNoEmail);

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe('Email not configured');
  });

  it('should include manage notifications link in email footer', async () => {
    const entry: JournalEntry = {
      id: 'entry1',
      pseudonym: 'Test#123',
      handle: 'author',
      client: 'desktop',
      content: 'Check the footer',
      timestamp: Date.now(),
      to: ['@alice'],
    };

    await deliverEntry(entry, makeConfig());

    expect(emailClient.calls).toHaveLength(1);
    expect(emailClient.calls[0].html).toContain('manage notifications');
    expect(emailClient.calls[0].html).toContain('https://router.test/settings');
  });
});

describe('canView for an older note marked private with no destination', () => {
  const storage = new MemoryStorage();
  const shapes: [string, Partial<JournalEntry>][] = [
    ['no to', {}], ['an empty to', { to: [] }], ['private and AI-only stub', { aiOnly: true }],
  ];
  for (const [label, extra] of shapes) {
    it(`shows it to its author only (${label})`, async () => {
      const entry = normalizeEntry({ id: 'p1', pseudonym: 'Test#123', handle: 'author', client: 'code', content: 'Mine',
        timestamp: 1, visibility: 'private', ...extra } as JournalEntry);
      expect(await canView(entry, 'author', undefined, true, storage)).toBe(true);
      expect(await canView(entry, 'someone', 'someone@example.com', false, storage)).toBe(false);
      expect(await canView(entry, undefined, undefined, false, storage)).toBe(false);
    });
  }
  it('still shows public and AI-only notes with no destination to everyone', async () => {
    for (const visibility of [undefined, 'public', 'ai-only'] as const) {
      const entry = normalizeEntry({ id: 'p2', pseudonym: 'Test#123', client: 'code', content: 'Open', timestamp: 1, visibility } as JournalEntry);
      expect(await canView(entry, undefined, undefined, false, storage)).toBe(true);
    }
  });
});
