import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MemoryStorage, StagedStorage, FirestoreStorage, isValidChannelId, encodePageCursor } from './storage.js';
import { authorStorage } from './author-store.js';
import type { Channel, ChannelInvite, JournalEntry } from './storage.js';
import { hashSecretKey } from './identity.js';

// Check if Firestore is configured
const hasFirestore = !!(
  process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ||
  process.env.FIREBASE_SERVICE_ACCOUNT ||
  process.env.GOOGLE_APPLICATION_CREDENTIALS
);

describe('MemoryStorage', () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  describe('User operations', () => {
    const testUser = {
      handle: 'testuser',
      secretKeyHash: hashSecretKey('test-secret-key-1234567890'),
      displayName: 'Test User',
      bio: 'A test user for testing',
      email: 'test@example.com',
    };

    describe('createUser', () => {
      it('should create a user and return it with createdAt', async () => {
        const user = await storage.createUser(testUser);

        expect(user.handle).toBe('testuser');
        expect(user.displayName).toBe('Test User');
        expect(user.bio).toBe('A test user for testing');
        expect(user.email).toBe('test@example.com');
        expect(user.secretKeyHash).toBe(testUser.secretKeyHash);
        expect(user.createdAt).toBeDefined();
        expect(typeof user.createdAt).toBe('number');
      });

      it('should store legacyPseudonym if provided', async () => {
        const userWithLegacy = {
          ...testUser,
          handle: 'legacyuser',
          legacyPseudonym: 'Quiet Feather#abc123',
        };
        const user = await storage.createUser(userWithLegacy);

        expect(user.legacyPseudonym).toBe('Quiet Feather#abc123');
      });
    });

    describe('getUser', () => {
      it('should retrieve a user by handle', async () => {
        await storage.createUser(testUser);
        const user = await storage.getUser('testuser');

        expect(user).toBeDefined();
        expect(user!.handle).toBe('testuser');
      });

      it('should return null for non-existent handle', async () => {
        const user = await storage.getUser('nonexistent');
        expect(user).toBeNull();
      });
    });

    describe('getUserByKeyHash', () => {
      it('should retrieve a user by their secret key hash', async () => {
        await storage.createUser(testUser);
        const user = await storage.getUserByKeyHash(testUser.secretKeyHash);

        expect(user).toBeDefined();
        expect(user!.handle).toBe('testuser');
      });

      it('should return null for non-existent key hash', async () => {
        const user = await storage.getUserByKeyHash('nonexistenthash');
        expect(user).toBeNull();
      });
    });

    describe('updateUser', () => {
      it('should update user fields', async () => {
        await storage.createUser(testUser);
        const updated = await storage.updateUser('testuser', {
          displayName: 'Updated Name',
          bio: 'Updated bio',
        });

        expect(updated).toBeDefined();
        expect(updated!.displayName).toBe('Updated Name');
        expect(updated!.bio).toBe('Updated bio');
        expect(updated!.email).toBe('test@example.com'); // unchanged
      });

      it('should return null when updating non-existent user', async () => {
        const updated = await storage.updateUser('nonexistent', { displayName: 'New' });
        expect(updated).toBeNull();
      });

      it('should have lastDailyQuestionAt undefined for new users', async () => {
        const user = await storage.createUser(testUser);
        expect(user.lastDailyQuestionAt).toBeUndefined();
      });

      it('should persist lastDailyQuestionAt via updateUser', async () => {
        await storage.createUser(testUser);
        const now = Date.now();
        const updated = await storage.updateUser('testuser', { lastDailyQuestionAt: now });

        expect(updated).toBeDefined();
        expect(updated!.lastDailyQuestionAt).toBe(now);

        // Verify it persists on re-fetch
        const fetched = await storage.getUser('testuser');
        expect(fetched!.lastDailyQuestionAt).toBe(now);
      });
    });

    describe('isHandleAvailable', () => {
      it('should return true for available handles', async () => {
        expect(await storage.isHandleAvailable('available')).toBe(true);
      });

      it('should return false for taken handles', async () => {
        await storage.createUser(testUser);
        expect(await storage.isHandleAvailable('testuser')).toBe(false);
      });
    });
  });

  describe('Entry operations with handles', () => {
    const testEntry = {
      pseudonym: 'Quiet Feather#abc123',
      client: 'desktop' as const,
      content: 'Test entry content',
      timestamp: Date.now(),
    };

    describe('addEntry with handle', () => {
      it('should store handle when provided', async () => {
        const entry = await storage.addEntry({
          ...testEntry,
          handle: 'testuser',
        });

        expect(entry.handle).toBe('testuser');
      });

      it('should work without handle (legacy behavior)', async () => {
        const entry = await storage.addEntry(testEntry);

        expect(entry.handle).toBeUndefined();
        expect(entry.pseudonym).toBe('Quiet Feather#abc123');
      });
    });

    describe('getEntriesByHandle', () => {
      it('should return entries for a specific handle', async () => {
        // Add entries with handles
        await storage.addEntry({ ...testEntry, handle: 'alice', content: 'Alice entry 1' });
        await storage.addEntry({ ...testEntry, handle: 'alice', content: 'Alice entry 2' });
        await storage.addEntry({ ...testEntry, handle: 'bob', content: 'Bob entry' });

        const aliceEntries = await storage.getEntriesByHandle('alice');

        expect(aliceEntries).toHaveLength(2);
        expect(aliceEntries.every(e => e.handle === 'alice')).toBe(true);
      });

      it('should return empty array for handle with no entries', async () => {
        const entries = await storage.getEntriesByHandle('nobody');
        expect(entries).toHaveLength(0);
      });

      it('should respect limit parameter', async () => {
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 1' });
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 2' });
        await storage.addEntry({ ...testEntry, handle: 'prolific', content: 'Entry 3' });

        const entries = await storage.getEntriesByHandle('prolific', 2);
        expect(entries).toHaveLength(2);
      });

      it('should return entries sorted by timestamp descending', async () => {
        const now = Date.now();
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now - 2000 });
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now });
        await storage.addEntry({ ...testEntry, handle: 'chronological', timestamp: now - 1000 });

        const entries = await storage.getEntriesByHandle('chronological');

        expect(entries[0].timestamp).toBe(now);
        expect(entries[1].timestamp).toBe(now - 1000);
        expect(entries[2].timestamp).toBe(now - 2000);
      });
    });

    describe('migrateEntriesToHandle', () => {
      it('should migrate entries from pseudonym to handle', async () => {
        const pseudonym = 'Migrating User#def456';

        // Add entries with just pseudonym (legacy)
        await storage.addEntry({ ...testEntry, pseudonym, content: 'Old entry 1' });
        await storage.addEntry({ ...testEntry, pseudonym, content: 'Old entry 2' });

        // Migrate to handle
        const count = await storage.migrateEntriesToHandle(pseudonym, 'newhandle');

        expect(count).toBe(2);

        // Verify entries now have the handle
        const entries = await storage.getEntriesByHandle('newhandle');
        expect(entries).toHaveLength(2);
        expect(entries.every(e => e.handle === 'newhandle')).toBe(true);
        // Pseudonym should be preserved
        expect(entries.every(e => e.pseudonym === pseudonym)).toBe(true);
      });

      it('should return 0 when no entries match the pseudonym', async () => {
        const count = await storage.migrateEntriesToHandle('Nonexistent#000000', 'handle');
        expect(count).toBe(0);
      });

      it('should not affect entries from other pseudonyms', async () => {
        await storage.addEntry({ ...testEntry, pseudonym: 'User A#111111', content: 'A entry' });
        await storage.addEntry({ ...testEntry, pseudonym: 'User B#222222', content: 'B entry' });

        await storage.migrateEntriesToHandle('User A#111111', 'usera');

        // User B's entry should be unaffected
        const allEntries = await storage.getEntries();
        const userBEntry = allEntries.find(e => e.pseudonym === 'User B#222222');
        expect(userBEntry).toBeDefined();
        expect(userBEntry!.handle).toBeUndefined();
      });
    });
  });

  describe('Basic entry operations', () => {
    it('should add and retrieve entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Hello world',
        timestamp: Date.now(),
      });

      expect(entry.id).toBeDefined();
      expect(entry.content).toBe('Hello world');

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(entry.id);
    });

    it('should delete entries', async () => {
      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'To be deleted',
        timestamp: Date.now(),
      });

      await storage.deleteEntry(entry.id);

      const entries = await storage.getEntries();
      expect(entries).toHaveLength(0);
    });

    it('should get entries by pseudonym', async () => {
      await storage.addEntry({
        pseudonym: 'User A#111',
        client: 'desktop',
        content: 'Entry from A',
        timestamp: Date.now(),
      });
      await storage.addEntry({
        pseudonym: 'User B#222',
        client: 'mobile',
        content: 'Entry from B',
        timestamp: Date.now(),
      });

      const entriesA = await storage.getEntriesByPseudonym('User A#111');
      expect(entriesA).toHaveLength(1);
      expect(entriesA[0].content).toBe('Entry from A');
    });

    it('should apply offset before limit when paginating entries', async () => {
      const now = Date.now();
      await storage.addEntry({
        pseudonym: 'User A#111',
        client: 'desktop',
        content: 'Newest',
        timestamp: now,
      });
      await storage.addEntry({
        pseudonym: 'User B#222',
        client: 'desktop',
        content: 'Middle',
        timestamp: now - 1000,
      });
      await storage.addEntry({
        pseudonym: 'User C#333',
        client: 'desktop',
        content: 'Oldest',
        timestamp: now - 2000,
      });

      const page = await storage.getEntries(1, 1);
      expect(page).toHaveLength(1);
      expect(page[0].content).toBe('Middle');
    });

    it('should paginate entries with cursor', async () => {
      const now = Date.now();
      const first = await storage.addEntry({
        pseudonym: 'User A#111',
        client: 'desktop',
        content: 'Newest',
        timestamp: now,
      });
      await storage.addEntry({
        pseudonym: 'User B#222',
        client: 'desktop',
        content: 'Middle',
        timestamp: now - 1000,
      });

      const cursor = encodePageCursor({ timestamp: first.timestamp, id: first.id });
      const page = await storage.getEntries(10, 0, cursor);
      expect(page).toHaveLength(1);
      expect(page[0].content).toBe('Middle');
    });
  });

  describe('Conversation pagination', () => {
    it('should paginate conversations with cursor', async () => {
      const now = Date.now();
      const newest = await storage.addConversation({
        pseudonym: 'User A#111',
        sourceUrl: 'https://example.com/a',
        platform: 'claude',
        title: 'Newest',
        content: 'Newest conversation',
        summary: 'Newest summary',
        timestamp: now,
        keywords: ['newest'],
      });
      await storage.addConversation({
        pseudonym: 'User B#222',
        sourceUrl: 'https://example.com/b',
        platform: 'chatgpt',
        title: 'Older',
        content: 'Older conversation',
        summary: 'Older summary',
        timestamp: now - 1000,
        keywords: ['older'],
      });

      const cursor = encodePageCursor({ timestamp: newest.timestamp, id: newest.id });
      const page = await storage.getConversations(10, 0, cursor);
      expect(page).toHaveLength(1);
      expect(page[0].title).toBe('Older');
    });
  });

  describe('Following', () => {
    const testUser = {
      handle: 'follower',
      secretKeyHash: hashSecretKey('follower-key-1234567890'),
      displayName: 'Follower',
    };

    const targetUser = {
      handle: 'target',
      secretKeyHash: hashSecretKey('target-key-1234567890'),
      displayName: 'Target User',
      bio: 'Builds things',
    };

    beforeEach(async () => {
      await storage.createUser(testUser);
      await storage.createUser(targetUser);
    });

    it('should default to undefined following', async () => {
      const user = await storage.getUser('follower');
      expect(user!.following).toBeUndefined();
    });

    it('should store following list with notes', async () => {
      const following = [
        { handle: 'target', note: 'Builds things, recent TEE work' },
      ];
      await storage.updateUser('follower', { following });

      const user = await storage.getUser('follower');
      expect(user!.following).toHaveLength(1);
      expect(user!.following![0].handle).toBe('target');
      expect(user!.following![0].note).toBe('Builds things, recent TEE work');
    });

    it('should add a follow to existing list', async () => {
      const thirdUser = {
        handle: 'alice',
        secretKeyHash: hashSecretKey('alice-key-1234567890'),
      };
      await storage.createUser(thirdUser);

      // Start with one follow
      await storage.updateUser('follower', {
        following: [{ handle: 'target', note: 'First follow' }],
      });

      // Add second follow
      const user = await storage.getUser('follower');
      const updated = [...(user!.following || []), { handle: 'alice', note: 'Second follow' }];
      await storage.updateUser('follower', { following: updated });

      const result = await storage.getUser('follower');
      expect(result!.following).toHaveLength(2);
      expect(result!.following![0].handle).toBe('target');
      expect(result!.following![1].handle).toBe('alice');
    });

    it('should remove a follow from the list', async () => {
      await storage.updateUser('follower', {
        following: [
          { handle: 'target', note: 'First' },
          { handle: 'other', note: 'Second' },
        ],
      });

      const user = await storage.getUser('follower');
      const filtered = user!.following!.filter(f => f.handle !== 'target');
      await storage.updateUser('follower', { following: filtered });

      const result = await storage.getUser('follower');
      expect(result!.following).toHaveLength(1);
      expect(result!.following![0].handle).toBe('other');
    });

    it('should update note for existing follow', async () => {
      await storage.updateUser('follower', {
        following: [{ handle: 'target', note: 'Original note' }],
      });

      const user = await storage.getUser('follower');
      const updated = user!.following!.map(f =>
        f.handle === 'target' ? { ...f, note: 'Updated note' } : f
      );
      await storage.updateUser('follower', { following: updated });

      const result = await storage.getUser('follower');
      expect(result!.following![0].note).toBe('Updated note');
    });

    it('should handle empty following list', async () => {
      await storage.updateUser('follower', { following: [] });

      const user = await storage.getUser('follower');
      expect(user!.following).toEqual([]);
    });
  });
});

describe('isValidChannelId', () => {
  it('should accept valid channel IDs', () => {
    expect(isValidChannelId('flashbots')).toBe(true);
    expect(isValidChannelId('my-channel')).toBe(true);
    expect(isValidChannelId('ab')).toBe(true);
    expect(isValidChannelId('a1')).toBe(true);
    expect(isValidChannelId('test-channel-123')).toBe(true);
  });

  it('should reject invalid channel IDs', () => {
    expect(isValidChannelId('')).toBe(false);
    expect(isValidChannelId('a')).toBe(false); // too short
    expect(isValidChannelId('-abc')).toBe(false); // leading hyphen
    expect(isValidChannelId('abc-')).toBe(false); // trailing hyphen
    expect(isValidChannelId('ABC')).toBe(false); // uppercase
    expect(isValidChannelId('has_underscore')).toBe(false); // underscore
    expect(isValidChannelId('has spaces')).toBe(false);
    expect(isValidChannelId('a'.repeat(32))).toBe(false); // too long
  });
});

describe('MemoryStorage Channels', () => {
  let storage: MemoryStorage;

  const testUser = {
    handle: 'alice',
    secretKeyHash: hashSecretKey('alice-secret-key-1234567890'),
    displayName: 'Alice',
  };

  const testUser2 = {
    handle: 'bob',
    secretKeyHash: hashSecretKey('bob-secret-key-1234567890'),
    displayName: 'Bob',
  };

  beforeEach(async () => {
    storage = new MemoryStorage();
    await storage.createUser(testUser);
    await storage.createUser(testUser2);
  });

  function makeChannel(overrides: Partial<Channel> = {}): Channel {
    return {
      id: 'test-channel',
      name: 'Test Channel',
      description: 'A test channel',
      visibility: 'public',
      joinRule: 'open',
      createdBy: 'alice',
      createdAt: Date.now(),
      skills: [],
      subscribers: [{ handle: 'alice', role: 'admin', joinedAt: Date.now() }],
      ...overrides,
    };
  }

  describe('Channel CRUD', () => {
    it('should create and retrieve a channel', async () => {
      const channel = makeChannel();
      await storage.createChannel(channel);

      const retrieved = await storage.getChannel('test-channel');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('test-channel');
      expect(retrieved!.name).toBe('Test Channel');
      expect(retrieved!.createdBy).toBe('alice');
    });

    it('should reject duplicate channel IDs', async () => {
      await storage.createChannel(makeChannel());
      await expect(storage.createChannel(makeChannel())).rejects.toThrow('already exists');
    });

    it('should update a channel', async () => {
      await storage.createChannel(makeChannel());
      const updated = await storage.updateChannel('test-channel', {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(updated!.name).toBe('Updated Name');
      expect(updated!.description).toBe('Updated description');
      expect(updated!.id).toBe('test-channel'); // unchanged
    });

    it('should return null when updating non-existent channel', async () => {
      const result = await storage.updateChannel('nonexistent', { name: 'X' });
      expect(result).toBeNull();
    });

    it('should delete a channel', async () => {
      await storage.createChannel(makeChannel());
      await storage.deleteChannel('test-channel');

      const retrieved = await storage.getChannel('test-channel');
      expect(retrieved).toBeNull();
    });

    it('should return null for non-existent channel', async () => {
      const result = await storage.getChannel('nonexistent');
      expect(result).toBeNull();
    });
  });

  describe('Channel listing', () => {
    beforeEach(async () => {
      await storage.createChannel(makeChannel({ id: 'public-1', name: 'Public 1', visibility: 'public', joinRule: 'open' }));
      await storage.createChannel(makeChannel({ id: 'public-2', name: 'Public 2', visibility: 'public', joinRule: 'open' }));
      await storage.createChannel(makeChannel({
        id: 'private-1',
        name: 'Private 1',
        visibility: 'private',
        joinRule: 'invite',
        subscribers: [
          { handle: 'alice', role: 'admin', joinedAt: Date.now() },
          { handle: 'bob', role: 'member', joinedAt: Date.now() },
        ],
      }));
    });

    it('should list all channels', async () => {
      const channels = await storage.listChannels();
      expect(channels).toHaveLength(3);
    });

    it('should filter by visibility (legacy)', async () => {
      const publicChannels = await storage.listChannels({ visibility: 'public' });
      expect(publicChannels).toHaveLength(2);

      const privateChannels = await storage.listChannels({ visibility: 'private' });
      expect(privateChannels).toHaveLength(1);
    });

    it('should filter by joinRule', async () => {
      const openChannels = await storage.listChannels({ joinRule: 'open' });
      expect(openChannels).toHaveLength(2);

      const inviteChannels = await storage.listChannels({ joinRule: 'invite' });
      expect(inviteChannels).toHaveLength(1);
    });

    it('should map legacy visibility to joinRule when filtering', async () => {
      // Create a channel with only legacy visibility (no joinRule)
      await storage.createChannel(makeChannel({
        id: 'legacy-private',
        name: 'Legacy Private',
        visibility: 'private',
        joinRule: undefined, // simulate legacy channel without joinRule
      }));

      // Should be found when filtering by joinRule 'invite' (mapped from visibility 'private')
      const inviteChannels = await storage.listChannels({ joinRule: 'invite' });
      expect(inviteChannels).toHaveLength(2); // private-1 + legacy-private
    });

    it('should filter by subscriber handle', async () => {
      const aliceChannels = await storage.listChannels({ handle: 'alice' });
      expect(aliceChannels).toHaveLength(3); // alice is in all channels

      const bobChannels = await storage.listChannels({ handle: 'bob' });
      expect(bobChannels).toHaveLength(1); // bob only in private-1
    });
  });

  describe('Membership', () => {
    beforeEach(async () => {
      await storage.createChannel(makeChannel());
    });

    it('should add a subscriber', async () => {
      await storage.addSubscriber('test-channel', 'bob', 'member');

      const channel = await storage.getChannel('test-channel');
      expect(channel!.subscribers).toHaveLength(2);
      expect(channel!.subscribers.find(s => s.handle === 'bob')).toBeDefined();
    });

    it('should be a no-op when adding duplicate subscriber', async () => {
      await storage.addSubscriber('test-channel', 'alice', 'member');
      const channel = await storage.getChannel('test-channel');
      expect(channel!.subscribers).toHaveLength(1); // Still just alice
    });

    it('should remove a subscriber', async () => {
      await storage.addSubscriber('test-channel', 'bob', 'member');
      await storage.removeSubscriber('test-channel', 'bob');

      const channel = await storage.getChannel('test-channel');
      expect(channel!.subscribers).toHaveLength(1);
      expect(channel!.subscribers.find(s => s.handle === 'bob')).toBeUndefined();
    });

    it('should throw when adding to non-existent channel', async () => {
      await expect(storage.addSubscriber('nonexistent', 'bob', 'member')).rejects.toThrow('not found');
    });

    it('should get subscribed channels for a user', async () => {
      await storage.createChannel(makeChannel({
        id: 'other-channel',
        name: 'Other',
        subscribers: [{ handle: 'bob', role: 'admin', joinedAt: Date.now() }],
      }));

      const aliceChannels = await storage.getSubscribedChannels('alice');
      expect(aliceChannels).toHaveLength(1);
      expect(aliceChannels[0].id).toBe('test-channel');

      const bobChannels = await storage.getSubscribedChannels('bob');
      expect(bobChannels).toHaveLength(1);
      expect(bobChannels[0].id).toBe('other-channel');
    });
  });

  describe('Invites', () => {
    beforeEach(async () => {
      await storage.createChannel(makeChannel({ id: 'private-ch', visibility: 'private' }));
    });

    it('should create and retrieve an invite', async () => {
      const invite: ChannelInvite = {
        token: 'abc123',
        channelId: 'private-ch',
        createdBy: 'alice',
        createdAt: Date.now(),
        uses: 0,
      };
      await storage.createInvite(invite);

      const retrieved = await storage.getInvite('abc123');
      expect(retrieved).toBeDefined();
      expect(retrieved!.channelId).toBe('private-ch');
    });

    it('should use an invite and increment uses', async () => {
      const invite: ChannelInvite = {
        token: 'use-me',
        channelId: 'private-ch',
        createdBy: 'alice',
        createdAt: Date.now(),
        uses: 0,
      };
      await storage.createInvite(invite);

      const channel = await storage.useInvite('use-me', { channelId: 'private-ch', handle: 'bob' });
      expect(channel.id).toBe('private-ch');

      const updated = await storage.getInvite('use-me');
      expect(updated!.uses).toBe(1);
    });

    it('should reject expired invite', async () => {
      const invite: ChannelInvite = {
        token: 'expired',
        channelId: 'private-ch',
        createdBy: 'alice',
        createdAt: Date.now() - 100000,
        expiresAt: Date.now() - 1000, // Already expired
        uses: 0,
      };
      await storage.createInvite(invite);
      await expect(storage.useInvite('expired', { channelId: 'private-ch', handle: 'bob' })).rejects.toThrow('expired');
    });

    it('should reject invite at max uses', async () => {
      const invite: ChannelInvite = {
        token: 'maxed',
        channelId: 'private-ch',
        createdBy: 'alice',
        createdAt: Date.now(),
        maxUses: 1,
        uses: 1,
      };
      await storage.createInvite(invite);
      await expect(storage.useInvite('maxed', { channelId: 'private-ch', handle: 'bob' })).rejects.toThrow('maximum uses');
    });

    it('should refuse an invite for a different channel, without using it up', async () => {
      await storage.createChannel(makeChannel({ id: 'other-ch', visibility: 'private' }));
      await storage.createInvite({ token: 'for-private', channelId: 'private-ch', createdBy: 'alice', createdAt: Date.now(), maxUses: 1, uses: 0 });

      await expect(storage.useInvite('for-private', { channelId: 'other-ch', handle: 'bob' })).rejects.toThrow('not valid for this channel');
      expect((await storage.getInvite('for-private'))!.uses).toBe(0);

      const channel = await storage.useInvite('for-private', { channelId: 'private-ch', handle: 'bob' });
      expect(channel.id).toBe('private-ch');
    });

    it('should let only its recipient use a personal invite', async () => {
      await storage.createInvite({ token: 'for-carol', channelId: 'private-ch', createdBy: 'alice', createdAt: Date.now(), maxUses: 1, uses: 0, forHandle: 'carol' });

      await expect(storage.useInvite('for-carol', { channelId: 'private-ch', handle: 'bob' })).rejects.toThrow('not valid for this account');
      expect((await storage.getInvite('for-carol'))!.uses).toBe(0);
      await expect(storage.useInvite('for-carol', { channelId: 'private-ch', handle: 'Carol' })).resolves.toMatchObject({ id: 'private-ch' });
    });

    it('should return null for non-existent invite', async () => {
      const result = await storage.getInvite('nonexistent');
      expect(result).toBeNull();
    });

    it('should clean up invites when channel is deleted', async () => {
      const invite: ChannelInvite = {
        token: 'will-delete',
        channelId: 'private-ch',
        createdBy: 'alice',
        createdAt: Date.now(),
        uses: 0,
      };
      await storage.createInvite(invite);

      await storage.deleteChannel('private-ch');

      const result = await storage.getInvite('will-delete');
      expect(result).toBeNull();
    });
  });

  describe('Channel entries', () => {
    beforeEach(async () => {
      await storage.createChannel(makeChannel());
    });

    it('should return entries for a channel', async () => {
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'Channel entry 1',
        timestamp: Date.now(),
        channel: 'test-channel',
      });
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'Non-channel entry',
        timestamp: Date.now(),
      });

      const entries = await storage.getChannelEntries('test-channel');
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Channel entry 1');
    });

    it('should return entries sorted by timestamp desc', async () => {
      const now = Date.now();
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'Old',
        timestamp: now - 2000,
        channel: 'test-channel',
      });
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'New',
        timestamp: now,
        channel: 'test-channel',
      });

      const entries = await storage.getChannelEntries('test-channel');
      expect(entries[0].content).toBe('New');
      expect(entries[1].content).toBe('Old');
    });

    it('should return empty array for channel with no entries', async () => {
      const entries = await storage.getChannelEntries('test-channel');
      expect(entries).toHaveLength(0);
    });

    it('should match entries with #channel in to array (new format)', async () => {
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'New format entry',
        timestamp: Date.now(),
        to: ['#test-channel'],
      });

      const entries = await storage.getChannelEntries('test-channel');
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('New format entry');
    });

    it('should match both legacy channel field and new #channel in to', async () => {
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'Legacy entry',
        timestamp: Date.now(),
        channel: 'test-channel',
      });
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'New entry',
        timestamp: Date.now(),
        to: ['#test-channel'],
      });

      const entries = await storage.getChannelEntries('test-channel');
      expect(entries).toHaveLength(2);
    });

    it('should not duplicate entries with both channel field and #channel in to', async () => {
      await storage.addEntry({
        pseudonym: 'Test#123',
        handle: 'alice',
        client: 'code',
        content: 'Both formats',
        timestamp: Date.now(),
        channel: 'test-channel',
        to: ['#test-channel'],
      });

      const entries = await storage.getChannelEntries('test-channel');
      expect(entries).toHaveLength(1);
      expect(entries[0].content).toBe('Both formats');
    });
  });

  describe('Channel skills', () => {
    it('should store skills on a channel', async () => {
      const channel = makeChannel({
        skills: [{
          id: 'skill-1',
          name: 'random',
          description: 'Post random thoughts',
          instructions: 'Write something random',
          createdAt: Date.now(),
        }],
      });
      await storage.createChannel(channel);

      const retrieved = await storage.getChannel('test-channel');
      expect(retrieved!.skills).toHaveLength(1);
      expect(retrieved!.skills[0].name).toBe('random');
    });

    it('should update channel skills', async () => {
      await storage.createChannel(makeChannel());
      await storage.updateChannel('test-channel', {
        skills: [{
          id: 'new-skill',
          name: 'discussion',
          description: 'Start a discussion',
          instructions: 'Write a thought-provoking question',
          createdAt: Date.now(),
        }],
      });

      const channel = await storage.getChannel('test-channel');
      expect(channel!.skills).toHaveLength(1);
      expect(channel!.skills[0].name).toBe('discussion');
    });
  });
});

// StagedStorage tests - require Firestore
  describe.skipIf(!hasFirestore)('StagedStorage', () => {
  describe('Dynamic buffer time', () => {
    it('should use custom stagingDelayMs when provided', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour default
      const storage = new StagedStorage(defaultDelay);

      const customDelay = 2 * 60 * 60 * 1000; // 2 hours
      const before = Date.now();

      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Test with custom delay',
        timestamp: before,
        handle: 'testuser',
      }, customDelay);

      const after = Date.now();

      // publishAt should be approximately now + customDelay
      expect(entry.publishAt).toBeDefined();
      expect(entry.publishAt).toBeGreaterThanOrEqual(before + customDelay);
      expect(entry.publishAt).toBeLessThanOrEqual(after + customDelay);
    });

    it('should use default delay when stagingDelayMs not provided', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour default
      const storage = new StagedStorage(defaultDelay);

      const before = Date.now();

      const entry = await storage.addEntry({
        pseudonym: 'Test User#abc123',
        client: 'desktop',
        content: 'Test with default delay',
        timestamp: before,
        handle: 'testuser',
      });

      const after = Date.now();

      // publishAt should be approximately now + defaultDelay
      expect(entry.publishAt).toBeDefined();
      expect(entry.publishAt).toBeGreaterThanOrEqual(before + defaultDelay);
      expect(entry.publishAt).toBeLessThanOrEqual(after + defaultDelay);
    });

    it('should respect user-configured buffer times', async () => {
      const defaultDelay = 60 * 60 * 1000; // 1 hour
      const storage = new StagedStorage(defaultDelay);

      // Simulate different users with different buffer settings
      const shortBuffer = 2 * 60 * 60 * 1000;  // 2 hours
      const longBuffer = 24 * 60 * 60 * 1000;  // 24 hours

      const before = Date.now();

      const entry1 = await storage.addEntry({
        pseudonym: 'Short Buffer User#111',
        client: 'desktop',
        content: 'Quick publish',
        timestamp: before,
        handle: 'shortuser',
      }, shortBuffer);

      const entry2 = await storage.addEntry({
        pseudonym: 'Long Buffer User#222',
        client: 'desktop',
        content: 'Slow publish',
        timestamp: before,
        handle: 'longuser',
      }, longBuffer);

      // Verify different publishAt times
      expect(entry2.publishAt! - entry1.publishAt!).toBeGreaterThanOrEqual(longBuffer - shortBuffer - 100);
      expect(entry2.publishAt! - entry1.publishAt!).toBeLessThanOrEqual(longBuffer - shortBuffer + 100);
    });
  });

  describe('Content moderation methods', () => {
    it('getAllPendingEntries should return all staged entries sorted by publishAt', async () => {
      const storage = new StagedStorage(60 * 60 * 1000);

      await storage.addEntry({
        pseudonym: 'User A#aaa',
        handle: 'alice',
        client: 'desktop',
        content: 'First entry',
        timestamp: Date.now(),
      });

      await storage.addEntry({
        pseudonym: 'User B#bbb',
        handle: 'bob',
        client: 'desktop',
        content: 'Second entry',
        timestamp: Date.now(),
      });

      const pending = storage.getAllPendingEntries();
      expect(pending.length).toBe(2);
      // Sorted by publishAt ascending
      expect(pending[0].publishAt).toBeLessThanOrEqual(pending[1].publishAt!);
    });

    it('getAllPendingEntries should return empty array when nothing is pending', async () => {
      const storage = new StagedStorage(60 * 60 * 1000);
      const pending = storage.getAllPendingEntries();
      expect(pending.length).toBe(0);
    });

    it('updateEntryPublishAt should modify the publishAt of a pending entry', async () => {
      const storage = new StagedStorage(60 * 60 * 1000);

      const entry = await storage.addEntry({
        pseudonym: 'User#aaa',
        handle: 'alice',
        client: 'desktop',
        content: 'Test entry',
        timestamp: Date.now(),
      });

      const originalPublishAt = entry.publishAt!;
      const FOREVER = Date.now() + (999999 * 365.25 * 24 * 60 * 60 * 1000);

      const result = storage.updateEntryPublishAt(entry.id, FOREVER);
      expect(result).toBe(true);

      // Verify the entry's publishAt was updated
      const updated = await storage.getEntry(entry.id);
      expect(updated).toBeDefined();
      expect(updated!.publishAt).toBe(FOREVER);
      expect(updated!.publishAt).toBeGreaterThan(originalPublishAt);
    });

    it('updateEntryPublishAt should return false for non-existent entry', async () => {
      const storage = new StagedStorage(60 * 60 * 1000);
      const result = storage.updateEntryPublishAt('nonexistent-id', Date.now());
      expect(result).toBe(false);
    });

    it('held entries should not auto-publish', async () => {
      const storage = new StagedStorage(1); // 1ms delay — publishes almost instantly

      const entry = await storage.addEntry({
        pseudonym: 'User#aaa',
        handle: 'alice',
        client: 'desktop',
        content: 'Sensitive content',
        timestamp: Date.now(),
      });

      // Hold the entry
      const FOREVER = Date.now() + (999999 * 365.25 * 24 * 60 * 60 * 1000);
      storage.holdEntry(entry.id, 'sensitive content', FOREVER);

      // Wait a bit for the publish loop to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Entry should still be pending
      expect(storage.isPending(entry.id)).toBe(true);
      const held = await storage.getEntry(entry.id);
      expect(held?.moderationHeld).toBe(true);
      expect(held?.moderationHoldReason).toBe('sensitive content');

      // Clean up
      storage.stop();
    });

    it('released entries should publish immediately via publishEntry', async () => {
      const storage = new StagedStorage(60 * 60 * 1000);

      const entry = await storage.addEntry({
        pseudonym: 'User#aaa',
        handle: 'alice',
        client: 'desktop',
        content: 'Safe content',
        timestamp: Date.now(),
      });

      expect(storage.isPending(entry.id)).toBe(true);

      // Publish immediately
      const published = await storage.publishEntry(entry.id);
      expect(published).toBeDefined();
      expect(storage.isPending(entry.id)).toBe(false);

      // Clean up
      storage.stop();
    });
  });
});

// Memory-backed, so these run without Firestore (the StagedStorage block above needs it).
describe('StagedStorage holds and releases', () => {
  const FOREVER = () => Date.now() + (999999 * 365.25 * 24 * 60 * 60 * 1000);
  const waiting = (content: string) => ({
    pseudonym: 'User#aaa',
    handle: 'alice',
    client: 'desktop' as const,
    content,
    timestamp: Date.now(),
  });

  it('a released hold goes back to its original publish time', async () => {
    const storage = new StagedStorage(60 * 60 * 1000, new MemoryStorage());
    const entry = await storage.addEntry(waiting('Held, then released'));
    const originalPublishAt = entry.publishAt!;

    storage.holdEntry(entry.id, 'review', FOREVER(), 'automated');
    expect((await storage.getEntry(entry.id))?.scheduledPublishAt).toBe(originalPublishAt);

    expect(storage.releaseHold(entry.id)).toBe(originalPublishAt);
    const released = await storage.getEntry(entry.id);
    expect(released?.publishAt).toBe(originalPublishAt);
    expect(released?.moderationHeld).toBeUndefined();
    expect(released?.moderationHeldBy).toBeUndefined();
    expect(released?.scheduledPublishAt).toBeUndefined();
    expect(storage.isPending(entry.id)).toBe(true);

    storage.stop();
  });

  it('after a release the entry publishes when its original window ends, not before', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-02T00:00:00Z'));
      const storage = new StagedStorage(60 * 60 * 1000, new MemoryStorage());
      const entry = await storage.addEntry(waiting('Released ten minutes in'));
      storage.holdEntry(entry.id, 'review', FOREVER(), 'automated');

      vi.setSystemTime(new Date('2026-11-02T00:10:00Z'));
      storage.releaseHold(entry.id);
      await (storage as any).publishReadyEntries();
      expect(storage.isPending(entry.id)).toBe(true);

      vi.setSystemTime(new Date('2026-11-02T01:00:01Z'));
      await (storage as any).publishReadyEntries();
      expect(storage.isPending(entry.id)).toBe(false);

      storage.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a hold with no recorded schedule cannot be released (holds restored from before the change)', async () => {
    const storage = new StagedStorage(60 * 60 * 1000, new MemoryStorage());
    const heldUntil = FOREVER();
    storage.restorePendingState({
      entries: [{ id: 'legacy-held', ...waiting('Held before schedules were recorded'), publishAt: heldUntil }],
      conversations: [],
    });

    expect(storage.releaseHold('legacy-held')).toBeNull();
    expect((await storage.getEntry('legacy-held'))?.publishAt).toBe(heldUntil);

    storage.stop();
  });

  it('publishing strips the staging-only hold fields', async () => {
    const storage = new StagedStorage(60 * 60 * 1000, new MemoryStorage());
    const entry = await storage.addEntry(waiting('Held by a moderator, then published by its author'));
    storage.holdEntry(entry.id, 'review', FOREVER(), 'mod');

    const published = await storage.publishEntry(entry.id);
    for (const field of ['publishAt', 'moderationHeld', 'moderationHoldReason', 'moderationHeldBy', 'scheduledPublishAt']) {
      expect(published).not.toHaveProperty(field);
    }

    storage.stop();
  });
});

describe('MemoryStorage getRecordsOf', () => {
  it('returns notes with the account\'s handle, and notes with no handle written under its key\'s name', async () => {
    const storage = new MemoryStorage();
    const name = 'Quiet Feather#79c30b';
    const base = { client: 'code' as const, content: 'x', timestamp: 1 };
    const own = await storage.addEntry({ ...base, pseudonym: name, handle: 'alice' });
    const older = await storage.addEntry({ ...base, pseudonym: name });
    const theirs = await storage.addEntry({ ...base, pseudonym: name, handle: 'bob' });
    const ids = (await storage.getRecordsOf('alice', [name])).posts.map(p => p.id);
    expect(ids).toContain(own.id);
    expect(ids).toContain(older.id);
    expect(ids).not.toContain(theirs.id);
  });
});

describe('moving notes to a handle when its owner claims it', () => {
  const name = 'Quiet Feather#79c30b';
  const base = { client: 'code' as const, content: 'x', timestamp: 1 };

  it('moves only notes with no handle, in memory, and a second run changes nothing', async () => {
    const storage = new MemoryStorage();
    const theirs = await storage.addEntry({ ...base, pseudonym: name, handle: 'bob' });
    const older = await storage.addEntry({ ...base, pseudonym: name });
    expect(await storage.countUnmigratedEntries(name, 'alice')).toBe(1);
    expect(await storage.migrateEntriesToHandle(name, 'alice')).toBe(1);
    expect((await storage.getEntry(theirs.id))?.handle).toBe('bob');
    expect((await storage.getEntry(older.id))?.handle).toBe('alice');
    expect(await storage.countUnmigratedEntries(name, 'alice')).toBe(0);
    expect(await storage.migrateEntriesToHandle(name, 'alice')).toBe(0);
    expect((await storage.getEntry(theirs.id))?.handle).toBe('bob');
  });

  it('moves only notes with no handle through the author store, cache and base alike', async () => {
    const backing = new MemoryStorage();
    const theirs = await backing.addEntry({ ...base, pseudonym: name, handle: 'bob' });
    const older = await backing.addEntry({ ...base, pseudonym: name });
    const layer = authorStorage(backing, null, null).storage;
    expect(await layer.migrateEntriesToHandle(name, 'alice')).toBe(1);
    for (const s of [layer, backing]) {
      expect((await s.getEntry(theirs.id))?.handle).toBe('bob');
      expect((await s.getEntry(older.id))?.handle).toBe('alice');
    }
    expect(await layer.migrateEntriesToHandle(name, 'alice')).toBe(0);
    expect(await layer.countUnmigratedEntries(name, 'alice')).toBe(0);
  });

  /** A stand-in for the parts of Firestore the move uses: an equality query, single reads and one transaction per note.
   *  `meanwhile` runs after the query and before the writes, as another move would. */
  function firestoreStandIn(meanwhile: (docs: Map<string, Record<string, unknown>>) => void,
    beforeCommit?: (id: string) => Promise<void>) {
    const docs = new Map<string, Record<string, unknown>>([
      ['theirs', { ...base, pseudonym: name, handle: 'bob' }],
      ['older', { ...base, pseudonym: name }],
      ['claimed-meanwhile', { ...base, pseudonym: name }],
    ]);
    const read = (id: string) => ({ id, exists: docs.has(id), data: () => docs.has(id) ? { ...docs.get(id)! } : undefined });
    const db = {
      collection: () => ({
        where: (_f: string, _op: string, value: string) => ({ get: async () => {
          const found = [...docs].filter(([, d]) => d.pseudonym === value).map(([id, d]) => ({ id, ref: { id }, data: () => ({ ...d }) }));
          meanwhile(docs);
          return { size: found.length, docs: found };
        } }),
        doc: (id: string) => ({ get: async () => read(id) }),
      }),
      runTransaction: async (fn: (tx: any) => Promise<unknown>) => {
        let write: { id: string; patch: Record<string, unknown> } | undefined;
        const result = await fn({
          get: async (r: { id: string }) => read(r.id),
          update: (r: { id: string }, patch: Record<string, unknown>) => { write = { id: r.id, patch }; },
        });
        if (write) {
          await beforeCommit?.(write.id);
          docs.set(write.id, { ...docs.get(write.id)!, ...write.patch });
        }
        return result;
      },
    };
    const storage = Object.assign(Object.create(FirestoreStorage.prototype), { db, collection: 'entries',
      // What the author store reads when it starts: every note, and nothing else.
      getAllUsers: async () => [], getConversations: async () => [], getSummaries: async () => [], getDailySummaries: async () => [],
      getEntries: async (_n: number, offset = 0) => offset ? [] : [...docs].map(([id, d]) => ({ id, ...d }) as JournalEntry),
    }) as FirestoreStorage;
    return { docs, storage };
  }
  const anotherMove = (docs: Map<string, Record<string, unknown>>) => {
    docs.set('claimed-meanwhile', { ...docs.get('claimed-meanwhile')!, handle: 'carol' });
  };

  it('moves only notes with no handle in Firestore, re-reading each note as it writes', async () => {
    const { docs, storage } = firestoreStandIn(anotherMove);
    expect(await storage.migrateEntriesToHandle(name, 'alice')).toBe(1);
    expect(docs.get('theirs')!.handle).toBe('bob');
    expect(docs.get('older')!.handle).toBe('alice');
    expect(docs.get('claimed-meanwhile')!.handle).toBe('carol');
    expect(await storage.migrateEntriesToHandle(name, 'alice')).toBe(0);
    expect(await storage.countUnmigratedEntries(name, 'alice')).toBe(0);
  });

  it("keeps the author store's notes the same as Firestore's when another move runs at the same time", async () => {
    const { docs, storage } = firestoreStandIn(anotherMove);
    const layer = authorStorage(storage, null, null).storage;
    expect((await layer.getEntry('claimed-meanwhile'))?.handle).toBeUndefined();
    expect(await layer.migrateEntriesToHandle(name, 'alice')).toBe(1);
    for (const id of docs.keys()) expect((await layer.getEntry(id))?.handle).toBe(docs.get(id)!.handle);
    expect((await layer.getEntry('claimed-meanwhile'))?.handle).toBe('carol');
    expect((await layer.getEntry('older'))?.handle).toBe('alice');
    expect((await layer.getEntry('theirs'))?.handle).toBe('bob');
  });

  it('changes no note in the author store when storage moved none', async () => {
    const { docs, storage } = firestoreStandIn(d => { for (const [id, v] of d) if (!v.handle) d.set(id, { ...v, handle: 'carol' }); });
    const layer = authorStorage(storage, null, null).storage;
    await layer.getEntry('older');
    expect(await layer.migrateEntriesToHandle(name, 'alice')).toBe(0);
    for (const id of docs.keys()) expect((await layer.getEntry(id))?.handle).toBe(docs.get(id)!.handle);
    expect((await layer.getEntry('older'))?.handle).toBe('carol');
  });

  it('shows each note again only after storage confirms it, including on a retry that moves none', async () => {
    const { docs, storage } = firestoreStandIn(d => { d.delete('claimed-meanwhile'); });
    for (let i = 0; i < 20; i++) docs.set(`note-${i}`, { ...base, pseudonym: name });
    const layer = authorStorage(storage, null, null).storage;
    expect(await layer.getEntry('claimed-meanwhile')).toBeTruthy();
    const read = storage.getEntry.bind(storage);
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    const resume = new Promise<void>(resolve => { release = resolve; });
    let active = 0, peak = 0;
    const reads = vi.spyOn(storage, 'getEntry').mockImplementation(async id => {
      peak = Math.max(peak, ++active);
      try {
        if (id === 'older') {
          started();
          await resume;
          throw new Error('read interrupted');
        }
        await new Promise<void>(resolve => setImmediate(resolve));
        return await read(id);
      } finally { active--; }
    });
    const finished = expect(layer.migrateEntriesToHandle(name, 'alice')).rejects.toThrow('read interrupted');
    try {
      await reading;
      expect(docs.get('older')?.handle).toBe('alice');
      expect(await layer.getEntry('older')).toBeNull();
      expect((await layer.getEntry('theirs'))?.handle).toBe('bob');
    } finally { release(); }
    await finished;
    reads.mockRestore();

    expect(peak).toBeLessThanOrEqual(8);
    expect(await layer.getEntry('older')).toBeNull();
    expect(await layer.getEntry('claimed-meanwhile')).toBeNull();
    const visible = await layer.getEntries(100);
    expect(visible.map(note => note.id)).not.toContain('older');
    expect(visible).toHaveLength(21);
    expect(await layer.migrateEntriesToHandle(name, 'alice')).toBe(0);
    expect((await layer.getEntry('older'))?.handle).toBe('alice');
    expect(await layer.getEntry('claimed-meanwhile')).toBeNull();
  });

  it('reads back a partially committed batch after all its writes have settled', async () => {
    const { storage } = firestoreStandIn(() => {}, async id => {
      if (id === 'older') throw new Error('write interrupted');
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    const layer = authorStorage(storage, null, null).storage;
    await expect(layer.migrateEntriesToHandle(name, 'alice')).rejects.toThrow('write interrupted');
    expect((await storage.getEntry('claimed-meanwhile'))?.handle).toBe('alice');
    expect((await layer.getEntry('claimed-meanwhile'))?.handle).toBe('alice');
    expect((await layer.getEntry('older'))?.handle).toBeUndefined();
  });
});
