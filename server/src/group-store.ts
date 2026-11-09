/**
 * Groups whose posts live in the group owner's store (TinyCloud), not in the
 * Router's database.
 *
 * A group is an invite-only channel with `store: { kind: 'tinycloud', ... }`.
 * Once a post addressed to it publishes, it is written to the owner's space under
 * `<prefix>posts/<entryId>` through a scoped, revocable grant the owner gave the
 * Router (one grant per group). Nothing is written to the Router's own database,
 * so group posts never appear in public feeds or search. If the owner revokes
 * the grant, reads fail and the Router reports that instead of serving anything
 * it kept. It keeps nothing: every view reads through the grant.
 */
import type { Channel, JournalEntry, Storage } from './storage.js';
import { createHash } from 'node:crypto';

export interface ConditionalPut { ifMatch?: string; ifNoneMatch?: '*' }
export interface VersionedValue { value: string; etag: string }
export class GroupStoreConflictError extends Error {
  constructor() { super('TinyCloud record changed during migration; retry after refreshing.'); }
}

/** One group's slice of its owner's store. Keys are relative to the group's prefix. */
export interface GroupStore {
  put(key: string, value: string, condition?: ConditionalPut): Promise<void>;
  get(key: string): Promise<string | null>;
  getVersioned?(key: string): Promise<VersionedValue | null>;
  list(path: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** Finds the store for a group channel (e.g. by using the grant its owner gave the Router). */
export type GroupStoreResolver = (channel: GroupChannel) => Promise<GroupStore>;

export type GroupChannel = Channel & { store: NonNullable<Channel['store']> };

/** The owner revoked the Router's grant (or it expired): the group's posts are no longer readable here. */
export class GroupStoreRevokedError extends Error {
  constructor(message = 'The group owner has revoked the Router\'s access to this group\'s posts.') {
    super(message);
    this.name = 'GroupStoreRevokedError';
  }
}

/**
 * In-memory stand-in for tests and local runs: one map, scoped per group by its
 * prefix. `revoke()` simulates every owner withdrawing their grant.
 */
export class MemoryGroupStore {
  private data = new Map<string, string>();
  private revoked = false;

  revoke(): void { this.revoked = true; }
  restore(): void { this.revoked = false; }
  /** Test helper: every stored key, regardless of grants. */
  keys(): string[] { return [...this.data.keys()]; }

  resolver(): GroupStoreResolver {
    return async (channel) => this.scoped(channel.store.prefix);
  }

  private scoped(prefix: string): GroupStore {
    const check = () => { if (this.revoked) throw new GroupStoreRevokedError(); };
    const etag = (value: string) => '"' + createHash('sha256').update(value).digest('hex') + '"';
    return {
      put: async (key, value, condition) => { check(); const old = this.data.get(prefix + key);
        if ((condition?.ifNoneMatch === '*' && old !== undefined) || (condition?.ifMatch && (old === undefined || etag(old) !== condition.ifMatch)))
          throw new GroupStoreConflictError();
        this.data.set(prefix + key, value); },
      get: async (key) => { check(); return this.data.get(prefix + key) ?? null; },
      getVersioned: async (key) => { check(); const value = this.data.get(prefix + key); return value === undefined ? null : { value, etag: etag(value) }; },
      list: async (path) => { check(); return [...this.data.keys()].filter(k => k.startsWith(prefix + path)).map(k => k.slice(prefix.length)); },
      delete: async (key) => { check(); this.data.delete(prefix + key); },
    };
  }
}

/**
 * The slice of the TinyCloud SDK's delegated access we use (verified against
 * @tinycloud/node-sdk 3.9.1 on the hosted node, Nov 2 2026). Calls resolve to
 * `{ ok, data }` or `{ ok: false, error }` rather than throwing, and keys are
 * relative to the delegated path.
 */
type SdkResult<T> = { ok: true; data: T } | { ok: false; error?: { code?: string; message?: string } };
export interface DelegatedKv {
  kv: {
    put(key: string, value: unknown, options?: ConditionalPut): Promise<SdkResult<unknown>>;
    get(key: string, options?: { source: 'network' }): Promise<SdkResult<unknown>>;
    list(options: { path: string }): Promise<SdkResult<{ keys?: string[] } | unknown>>;
    delete(key: string): Promise<SdkResult<unknown>>;
  };
}

/** The node reports revoked or expired grants only in the message (e.g. "delegation-ancestor-revoked: …"). */
export function isRevokedGrant(message: string | undefined, code?: string): boolean {
  return /revoked|expired/i.test(message ?? '') || /DELEGATION_\w*REVOKED/.test(code ?? '');
}

function unwrap<T>(result: SdkResult<T>, what: string): T {
  if (result.ok) return result.data;
  const { code, message } = result.error ?? {};
  if (isRevokedGrant(message, code)) throw new GroupStoreRevokedError();
  if (/precondition|if.?match|412|KV_CONFLICT/i.test(`${code} ${message}`)) throw new GroupStoreConflictError();
  throw new Error(`TinyCloud ${what} failed: ${code ?? 'error'} ${message ?? ''}`.trim());
}

/** Adapt delegated TinyCloud access (one group's grant) to a GroupStore. */
export function groupStoreFromAccess(access: DelegatedKv): GroupStore {
  async function read(key: string) {
    const result = await access.kv.get(key, { source: 'network' });
    if (!result.ok && /not.?found|404/i.test(`${result.error?.code} ${result.error?.message}`)) return null;
    const data = unwrap(result, 'get') as { data?: unknown; headers?: { etag?: string } } | unknown;
    const value = data && typeof data === 'object' && 'data' in data ? (data as { data?: unknown }).data : data;
    if (value === null || value === undefined) return null;
    return { value: typeof value === 'string' ? value : JSON.stringify(value),
      etag: data && typeof data === 'object' && 'headers' in data ? (data as { headers?: { etag?: string } }).headers?.etag : undefined };
  }
  return {
    async put(key, value, condition) {
      unwrap(await access.kv.put(key, value, condition), 'put');
    },
    async get(key) {
      return (await read(key))?.value ?? null;
    },
    async getVersioned(key) {
      const value = await read(key);
      if (!value) return null;
      if (!value.etag || !/^"[^"\r\n]+"$/.test(value.etag)) throw new Error('TinyCloud strong ETag required for safe migration');
      return { value: value.value, etag: value.etag };
    },
    async list(path) {
      const data = unwrap(await access.kv.list({ path }), 'list') as { keys?: unknown };
      const keys = Array.isArray(data?.keys) ? (data.keys as string[]) : [];
      // Accept keys relative to the grant, to the path, or to the space root
      return keys.map(k => { const at = k.lastIndexOf(path); return at >= 0 ? k.slice(at) : path + k; });
    },
    async delete(key) {
      unwrap(await access.kv.delete(key), 'delete');
    },
  };
}

/** What the Router needs on a group's folder: read, write, list and delete posts. */
export const GROUP_GRANT_ACTIONS = ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'];

export function groupPrefix(channelId: string): string {
  return `groups/${channelId}/`;
}

export function isGroupChannel(channel: Channel | null | undefined): channel is GroupChannel {
  return !!channel?.store && channel.store.kind === 'tinycloud';
}

const postKey = (entryId: string) => `posts/${entryId}`;

/**
 * Wrap the Router's published storage so posts addressed to a group go to that
 * group's store. Every other call passes through unchanged.
 */
export function withGroupStore(base: Storage, storeFor: GroupStoreResolver, newId: () => string): Storage {
  const entryChannel = new Map<string, string>(); // entry id -> group channel id, filled on write and list

  async function groupFor(entry: Pick<JournalEntry, 'to' | 'channel'>): Promise<GroupChannel | null> {
    const ids = [
      ...(entry.to || []).filter(d => d.startsWith('#')).map(d => d.slice(1)),
      ...(entry.channel ? [entry.channel] : []),
    ];
    for (const id of ids) {
      const channel = await base.getChannel(id);
      if (isGroupChannel(channel)) return channel;
    }
    return null;
  }

  async function readPost(channel: GroupChannel, entryId: string): Promise<JournalEntry | null> {
    const raw = await (await storeFor(channel)).get(postKey(entryId));
    return raw ? (JSON.parse(raw) as JournalEntry) : null;
  }

  const overrides: Partial<Storage> = {
    async addEntry(entry, stagingDelayMs) {
      const group = await groupFor(entry);
      if (!group) return base.addEntry(entry, stagingDelayMs);
      const id = (entry as Partial<JournalEntry>).id || newId();
      const saved = { ...entry, id } as JournalEntry;
      await (await storeFor(group)).put(postKey(id), JSON.stringify(saved));
      entryChannel.set(id, group.id);
      return saved;
    },

    async getEntry(id) {
      const fromBase = await base.getEntry(id);
      if (fromBase) return fromBase;
      const known = entryChannel.get(id);
      const candidates = known
        ? [await base.getChannel(known)]
        : (await base.listChannels()).filter(isGroupChannel);
      for (const channel of candidates) {
        if (!isGroupChannel(channel)) continue;
        try {
          const post = await readPost(channel, id);
          if (post) { entryChannel.set(id, channel.id); return post; }
        } catch (err) {
          // A revoked group's posts are simply gone from the Router's view
          if (!(err instanceof GroupStoreRevokedError)) throw err;
        }
      }
      return null;
    },

    async getChannelEntries(channelId, limit = 50) {
      const channel = await base.getChannel(channelId);
      if (!isGroupChannel(channel)) return base.getChannelEntries(channelId, limit);
      const store = await storeFor(channel);
      const posts: JournalEntry[] = [];
      for (const key of await store.list('posts/')) {
        const raw = await store.get(key);
        if (!raw) continue;
        const post = JSON.parse(raw) as JournalEntry;
        entryChannel.set(post.id, channel.id);
        posts.push(post);
      }
      return posts.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
    },

    async deleteEntry(id) {
      const channelId = entryChannel.get(id);
      const channel = channelId ? await base.getChannel(channelId) : null;
      if (isGroupChannel(channel)) {
        await (await storeFor(channel)).delete(postKey(id));
        entryChannel.delete(id);
        return;
      }
      return base.deleteEntry(id);
    },
  };

  return new Proxy(base, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && prop in overrides) return (overrides as Record<string, unknown>)[prop];
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
