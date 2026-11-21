import { describe, it, expect } from 'vitest';
import { ChannelTopicMappingStore, type ChannelTopicMapping } from './channel-topic-mapping.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMapping(overrides: Partial<ChannelTopicMapping> = {}): ChannelTopicMapping {
  return {
    channelId: 'engineering',
    telegramChatId: '-1001234567890',
    telegramThreadId: 42,
    topicName: 'Engineering',
    createdAt: Date.now(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ChannelTopicMappingStore', () => {
  // ── Basic CRUD ──────────────────────────────────────────────────────────

  it('adds and retrieves a mapping by channelId', () => {
    const store = new ChannelTopicMappingStore();
    const m = makeMapping();
    store.add(m);
    expect(store.getByChannelId('engineering')).toEqual(m);
  });

  it('retrieves a mapping by threadId', () => {
    const store = new ChannelTopicMappingStore();
    const m = makeMapping();
    store.add(m);
    expect(store.getByThreadId(42)).toEqual(m);
  });

  it('returns null for unknown channelId', () => {
    const store = new ChannelTopicMappingStore();
    expect(store.getByChannelId('nope')).toBeNull();
  });

  it('returns null for unknown threadId', () => {
    const store = new ChannelTopicMappingStore();
    expect(store.getByThreadId(999)).toBeNull();
  });

  it('lists all mappings', () => {
    const store = new ChannelTopicMappingStore();
    const m1 = makeMapping({ channelId: 'engineering', telegramThreadId: 1 });
    const m2 = makeMapping({ channelId: 'design', telegramThreadId: 2, topicName: 'Design' });
    store.add(m1);
    store.add(m2);
    const list = store.list();
    expect(list).toHaveLength(2);
    expect(list).toContainEqual(m1);
    expect(list).toContainEqual(m2);
  });

  it('list() returns a copy, not internal state', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    const list = store.list();
    list.pop();
    expect(store.size()).toBe(1); // unchanged
  });

  // ── Remove ──────────────────────────────────────────────────────────────

  it('removes by channelId and cleans both indexes', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    expect(store.remove('engineering')).toBe(true);
    expect(store.getByChannelId('engineering')).toBeNull();
    expect(store.getByThreadId(42)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('remove returns false for nonexistent channelId', () => {
    const store = new ChannelTopicMappingStore();
    expect(store.remove('ghost')).toBe(false);
  });

  it('removeByThreadId works and cleans both indexes', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    expect(store.removeByThreadId(42)).toBe(true);
    expect(store.getByChannelId('engineering')).toBeNull();
    expect(store.getByThreadId(42)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('removeByThreadId returns false for nonexistent threadId', () => {
    const store = new ChannelTopicMappingStore();
    expect(store.removeByThreadId(9999)).toBe(false);
  });

  // ── has() ───────────────────────────────────────────────────────────────

  it('has() returns true for existing channels', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    expect(store.has('engineering')).toBe(true);
  });

  it('has() returns false for non-existing channels', () => {
    const store = new ChannelTopicMappingStore();
    expect(store.has('engineering')).toBe(false);
  });

  it('has() returns false after removal', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    store.remove('engineering');
    expect(store.has('engineering')).toBe(false);
  });

  // ── size() ──────────────────────────────────────────────────────────────

  it('size starts at 0', () => {
    expect(new ChannelTopicMappingStore().size()).toBe(0);
  });

  it('size tracks adds', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping({ channelId: 'aa', telegramThreadId: 1 }));
    store.add(makeMapping({ channelId: 'bb', telegramThreadId: 2 }));
    expect(store.size()).toBe(2);
  });

  it('size tracks removes', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping({ channelId: 'aa', telegramThreadId: 1 }));
    store.add(makeMapping({ channelId: 'bb', telegramThreadId: 2 }));
    store.remove('aa');
    expect(store.size()).toBe(1);
  });

  // ── Duplicate prevention ────────────────────────────────────────────────

  it('throws when adding a duplicate channelId', () => {
    const store = new ChannelTopicMappingStore();
    store.add(makeMapping());
    expect(() => store.add(makeMapping({ telegramThreadId: 99 }))).toThrow(
      /already mapped/,
    );
  });

  // ── channelId validation ────────────────────────────────────────────────

  it('rejects empty channelId', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: '' }))).toThrow(/Invalid channelId/);
  });

  it('rejects single-char channelId', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: 'a' }))).toThrow(/Invalid channelId/);
  });

  it('rejects channelId with uppercase', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: 'Engineering' }))).toThrow(/Invalid channelId/);
  });

  it('rejects channelId with spaces', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: 'my channel' }))).toThrow(/Invalid channelId/);
  });

  it('rejects channelId starting with hyphen', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: '-eng' }))).toThrow(/Invalid channelId/);
  });

  it('rejects channelId ending with hyphen', () => {
    const store = new ChannelTopicMappingStore();
    expect(() => store.add(makeMapping({ channelId: 'eng-' }))).toThrow(/Invalid channelId/);
  });

  it('rejects channelId over 30 chars', () => {
    const store = new ChannelTopicMappingStore();
    const long = 'a' + 'b'.repeat(30); // 31 chars
    expect(() => store.add(makeMapping({ channelId: long }))).toThrow(/Invalid channelId/);
  });

  it('accepts valid channelId formats', () => {
    const store = new ChannelTopicMappingStore();
    // 2 chars, min length
    store.add(makeMapping({ channelId: 'ab', telegramThreadId: 1 }));
    // hyphens in middle
    store.add(makeMapping({ channelId: 'my-cool-channel', telegramThreadId: 2 }));
    // numbers
    store.add(makeMapping({ channelId: 'channel-42', telegramThreadId: 3 }));
    // 30 chars, max length
    const max30 = 'a' + 'b'.repeat(28) + 'c'; // 30 chars
    store.add(makeMapping({ channelId: max30, telegramThreadId: 4 }));
    expect(store.size()).toBe(4);
  });

  // ── Serialization ──────────────────────────────────────────────────────

  it('toJSON returns array of all mappings', () => {
    const store = new ChannelTopicMappingStore();
    const m = makeMapping();
    store.add(m);
    const json = store.toJSON();
    expect(json).toEqual([m]);
  });

  it('round-trip: toJSON → fromJSON produces equivalent store', () => {
    const store = new ChannelTopicMappingStore();
    const m1 = makeMapping({ channelId: 'engineering', telegramThreadId: 1 });
    const m2 = makeMapping({ channelId: 'design', telegramThreadId: 2, topicName: 'Design', createdBy: 'alice' });
    store.add(m1);
    store.add(m2);

    const restored = ChannelTopicMappingStore.fromJSON(store.toJSON());
    expect(restored.size()).toBe(2);
    expect(restored.getByChannelId('engineering')).toEqual(m1);
    expect(restored.getByChannelId('design')).toEqual(m2);
    expect(restored.getByThreadId(1)).toEqual(m1);
    expect(restored.getByThreadId(2)).toEqual(m2);
  });

  it('fromJSON with empty array returns empty store', () => {
    const store = ChannelTopicMappingStore.fromJSON([]);
    expect(store.size()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('fromJSON skips entries with invalid channelId', () => {
    const store = ChannelTopicMappingStore.fromJSON([
      makeMapping({ channelId: 'INVALID' }),
      makeMapping({ channelId: 'valid-one', telegramThreadId: 10 }),
    ]);
    expect(store.size()).toBe(1);
    expect(store.has('valid-one')).toBe(true);
  });

  it('fromJSON skips entries with missing fields', () => {
    const store = ChannelTopicMappingStore.fromJSON([
      { channelId: 'test' } as any,
      { telegramThreadId: 5 } as any,
      null as any,
      undefined as any,
    ]);
    expect(store.size()).toBe(0);
  });

  it('fromJSON skips duplicate channelIds silently', () => {
    const m = makeMapping();
    const store = ChannelTopicMappingStore.fromJSON([m, { ...m, telegramThreadId: 99 }]);
    expect(store.size()).toBe(1);
    // First one wins
    expect(store.getByThreadId(42)).toEqual(m);
  });

  it('fromJSON handles non-array input defensively', () => {
    const store = ChannelTopicMappingStore.fromJSON('garbage' as any);
    expect(store.size()).toBe(0);
  });

  it('fromJSON handles null input defensively', () => {
    const store = ChannelTopicMappingStore.fromJSON(null as any);
    expect(store.size()).toBe(0);
  });
});
