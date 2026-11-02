import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryStorage, generateEntryId, type Channel, type JournalEntry, type Storage } from './storage.js';
import { GroupStoreRevokedError, MemoryGroupStore, groupPrefix, groupStoreFromAccess, withGroupStore, type DelegatedKv } from './group-store.js';

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
    storage = withGroupStore(base, store.resolver(), generateEntryId);
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
    await withGroupStore(base, store.resolver(), generateEntryId).addEntry({ ...post('remember me', ['#lab']), id: 'r1' } as any);
    const fresh = withGroupStore(base, store.resolver(), generateEntryId);
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

describe('TinyCloud adapter (SDK results to a group store)', () => {
  const ok = (data: unknown) => ({ ok: true as const, data });
  const fail = (code: string, message: string) => ({ ok: false as const, error: { code, message } });

  function fakeAccess(keyPrefix = '', override: Partial<DelegatedKv['kv']> = {}): DelegatedKv {
    const kv = new Map<string, unknown>();
    return {
      kv: {
        put: async (k, v) => { kv.set(k, v); return ok(null); },
        get: async (k) => (kv.has(k) ? ok({ data: kv.get(k) }) : fail('KV_NOT_FOUND', 'Key not found')),
        list: async ({ path }) => ok({ keys: [...kv.keys()].filter(k => k.startsWith(path)).map(k => keyPrefix + k) }),
        delete: async (k) => { kv.delete(k); return ok(null); },
        ...override,
      },
    };
  }

  it('round-trips values and lists keys under a path', async () => {
    const store = groupStoreFromAccess(fakeAccess());
    await store.put('posts/a', '{"id":"a"}');
    expect(await store.get('posts/a')).toBe('{"id":"a"}');
    expect(await store.list('posts/')).toEqual(['posts/a']);
    await store.delete('posts/a');
    expect(await store.list('posts/')).toEqual([]);
  });

  it('returns null for a missing key', async () => {
    expect(await groupStoreFromAccess(fakeAccess()).get('posts/none')).toBeNull();
  });

  it('accepts list keys relative to the space root', async () => {
    const store = groupStoreFromAccess(fakeAccess('groups/lab/'));
    await store.put('posts/x', 'v');
    expect(await store.list('posts/')).toEqual(['posts/x']);
  });

  it('turns a revoked grant into GroupStoreRevokedError', async () => {
    const revoked = fail('AUTH_UNAUTHORIZED', 'delegation-ancestor-revoked: ancestor=bafkr4x invoked=bafkr4y');
    const store = groupStoreFromAccess(fakeAccess('', { get: async () => revoked, list: async () => revoked }));
    await expect(store.get('posts/a')).rejects.toBeInstanceOf(GroupStoreRevokedError);
    await expect(store.list('posts/')).rejects.toBeInstanceOf(GroupStoreRevokedError);
  });

  it('reports other failures as errors, not revocations', async () => {
    const outOfScope = fail('AUTH_UNAUTHORIZED', 'Unauthorized Action: tinycloud:pkh:eip155:1:0xabc:groups/kv/other / tinycloud.kv/get');
    const store = groupStoreFromAccess(fakeAccess('', { get: async () => outOfScope }));
    const err = await store.get('posts/a').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(GroupStoreRevokedError);
  });
});
