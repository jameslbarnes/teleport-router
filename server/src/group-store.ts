/**
 * Groups whose posts live in the group owner's store (TinyCloud), not in the
 * Router's database.
 *
 * A group is an invite-only channel with `store: { kind: 'tinycloud', prefix }`.
 * Once a post addressed to it publishes, it is written to the owner's space under
 * `<prefix>posts/<entryId>` through a scoped, revocable grant the owner gave the
 * Router. Nothing is written to the Router's own database, so group posts never
 * appear in public feeds or search. If the owner revokes the grant, reads fail
 * and the Router reports that instead of serving anything it kept.
 */
import type { Channel, JournalEntry, Storage } from './storage.js';

/** The few operations a group needs from its owner's store. */
export interface GroupStore {
  put(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
  list(prefix: string): Promise<string[]>;
  delete(key: string): Promise<void>;
}

/** The owner revoked the Router's grant (or it expired): the group's posts are no longer readable here. */
export class GroupStoreRevokedError extends Error {
  constructor(message = 'The group owner has revoked the Router\'s access to this group\'s posts.') {
    super(message);
    this.name = 'GroupStoreRevokedError';
  }
}

/** In-memory store for tests and local runs. `revoke()` simulates the owner withdrawing the grant. */
export class MemoryGroupStore implements GroupStore {
  private data = new Map<string, string>();
  private revoked = false;

  revoke(): void { this.revoked = true; }
  restore(): void { this.revoked = false; }

  private check(): void {
    if (this.revoked) throw new GroupStoreRevokedError();
  }
  async put(key: string, value: string): Promise<void> { this.check(); this.data.set(key, value); }
  async get(key: string): Promise<string | null> { this.check(); return this.data.get(key) ?? null; }
  async list(prefix: string): Promise<string[]> { this.check(); return [...this.data.keys()].filter(k => k.startsWith(prefix)); }
  async delete(key: string): Promise<void> { this.check(); this.data.delete(key); }
  /** Test helper: everything stored, regardless of grants. */
  keys(): string[] { return [...this.data.keys()]; }
}

export function groupPrefix(channelId: string): string {
  return `groups/${channelId}/`;
}

function postKey(channel: Channel, entryId: string): string {
  return `${channel.store!.prefix}posts/${entryId}`;
}

function isGroupChannel(channel: Channel | null): channel is Channel & { store: NonNullable<Channel['store']> } {
  return !!channel?.store && channel.store.kind === 'tinycloud';
}

/**
 * Wrap the Router's published storage so posts addressed to a group go to the
 * group's store. Every other call passes through unchanged.
 */
export function withGroupStore(base: Storage, store: GroupStore, newId: () => string): Storage {
  const entryChannel = new Map<string, string>(); // entry id -> group channel id, filled on write and list

  async function groupFor(entry: Pick<JournalEntry, 'to' | 'channel'>): Promise<Channel | null> {
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

  async function readPost(channel: Channel, entryId: string): Promise<JournalEntry | null> {
    const raw = await store.get(postKey(channel, entryId));
    return raw ? (JSON.parse(raw) as JournalEntry) : null;
  }

  const overrides: Partial<Storage> = {
    async addEntry(entry, stagingDelayMs) {
      const group = await groupFor(entry);
      if (!group) return base.addEntry(entry, stagingDelayMs);
      const id = (entry as Partial<JournalEntry>).id || newId();
      const saved = { ...entry, id } as JournalEntry;
      await store.put(postKey(group, id), JSON.stringify(saved));
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
      const keys = await store.list(`${channel.store.prefix}posts/`);
      const posts: JournalEntry[] = [];
      for (const key of keys) {
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
        await store.delete(postKey(channel, id));
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
