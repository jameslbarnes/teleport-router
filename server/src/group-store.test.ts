import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, generateEntryId, type Channel, type JournalEntry, type Storage } from './storage.js';
import { GroupStoreRevokedError, MemoryGroupStore, groupPrefix, withGroupStore } from './group-store.js';

const channel = (id: string, onTinyCloud: boolean): Channel => ({
  id,
  name: id,
  visibility: 'private',
  joinRule: 'invite',
  createdBy: 'owner',
  createdAt: Date.now(),
  skills: [],
  subscribers: [{ handle: 'owner', role: 'admin', joinedAt: Date.now() }],
  ...(onTinyCloud ? { store: { kind: 'tinycloud' as const, prefix: groupPrefix(id) } } : {}),
});

const post = (content: string, to: string[], extra: Partial<JournalEntry> = {}): Omit<JournalEntry, 'id'> => ({
  pseudonym: 'Owner#aaa',
  handle: 'owner',
  client: 'code',
  content,
  timestamp: Date.now(),
  to,
  ...extra,
});

describe('Groups stored in the owner\'s store', () => {
  let base: MemoryStorage;
  let store: MemoryGroupStore;
  let storage: Storage;

  beforeEach(async () => {
    base = new MemoryStorage();
    store = new MemoryGroupStore();
    storage = withGroupStore(base, store, generateEntryId);
    await base.createChannel(channel('lab', true));
    await base.createChannel(channel('plain', false));
  });

  it('writes a group post to the owner\'s store, not the Router database', async () => {
    const saved = await storage.addEntry({ ...post('Skill card: demo', ['#lab']), id: 'pending-id-1' } as any);

    expect(saved.id).toBe('pending-id-1'); // keeps the waiting post's id, so links stay stable
    expect(store.keys()).toEqual(['groups/lab/posts/pending-id-1']);
    expect(await base.getEntry('pending-id-1')).toBeNull();
    expect((await base.getEntries()).map(e => e.content)).not.toContain('Skill card: demo');
  });

  it('reads the group feed and single posts back from the store', async () => {
    await storage.addEntry({ ...post('first', ['#lab']), id: 'a1', timestamp: 1 } as any);
    await storage.addEntry({ ...post('second', ['#lab']), id: 'a2', timestamp: 2 } as any);

    expect((await storage.getChannelEntries('lab')).map(e => e.content)).toEqual(['second', 'first']);
    expect((await storage.getEntry('a1'))?.content).toBe('first');
  });

  it('finds a group post after a restart, when the id-to-group index is empty', async () => {
    await withGroupStore(base, store, generateEntryId).addEntry({ ...post('remember me', ['#lab']), id: 'r1' } as any);
    const fresh = withGroupStore(base, store, generateEntryId);
    expect((await fresh.getEntry('r1'))?.content).toBe('remember me');
  });

  it('leaves posts to ordinary channels and people where they were', async () => {
    const saved = await storage.addEntry(post('ordinary channel post', ['#plain']));
    expect(store.keys()).toEqual([]);
    expect((await base.getEntry(saved.id))?.content).toBe('ordinary channel post');
    expect((await storage.getChannelEntries('plain')).map(e => e.content)).toContain('ordinary channel post');
  });

  it('deletes a group post from the owner\'s store', async () => {
    await storage.addEntry({ ...post('delete me', ['#lab']), id: 'd1' } as any);
    await storage.deleteEntry('d1');
    expect(store.keys()).toEqual([]);
  });

  it('after the owner revokes the grant, the feed fails loudly and posts are gone from the Router\'s view', async () => {
    await storage.addEntry({ ...post('before revoke', ['#lab']), id: 'v1' } as any);
    store.revoke();

    await expect(storage.getChannelEntries('lab')).rejects.toBeInstanceOf(GroupStoreRevokedError);
    expect(await storage.getEntry('v1')).toBeNull();
    await expect(storage.addEntry(post('after revoke', ['#lab']))).rejects.toBeInstanceOf(GroupStoreRevokedError);
  });

  it('passes every other call straight through to the Router database', async () => {
    expect((await storage.getChannel('lab'))?.store?.kind).toBe('tinycloud');
    expect(await storage.getUserCount()).toBe(0);
  });
});
