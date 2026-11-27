import { describe, it, expect } from 'vitest';
import { MemoryStorage, StagedStorage, FirestoreStorage, compareByPersonOrder, decodePersonCursor, encodePageCursor, isOlderThan,
  type JournalEntry, type EntryBound, type Storage } from './storage.js';
import { authorStorage, recordCodec, type AuthorBinding } from './author-store.js';
import { testWallet, versionedMemoryStore } from './author-test-fixtures.js';
import { personPage, personPageAnswer, mergePersonNotes, personNotesSource, PERSON_SCAN_ALL } from './person-paging.js';

// One person's notes, with many equal timestamps.
const notes = (handle: string, count: number, pseudonym = `${handle}#1`): JournalEntry[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${handle}-${String(i).padStart(3, '0')}`, handle, pseudonym, content: `note ${i}`,
    timestamp: 1000 + Math.floor(i / 4) * 10, client: 'code',
  }) as JournalEntry);

// Ids that differ only in case or punctuation, all at one timestamp: localeCompare orders these differently from bytes.
const awkwardIds = ['a', 'A', 'b', 'B', 'a-1', 'a_1', 'a.1', 'a~1', 'Z', 'z', '_x', '-x', '0', '9', 'aB', 'Ab', 'ab', 'AB', 'a1', 'a!'];
const awkward = (handle: string, pseudonym = `${handle}#1`): JournalEntry[] => [
  ...awkwardIds.map(id => ({ id: `${handle}${id}`, handle, pseudonym, content: id, timestamp: 5000, client: 'code' }) as JournalEntry),
  ...awkwardIds.slice(0, 6).map(id => ({ id: `${handle}${id}~old`, handle, pseudonym, content: id, timestamp: 4000, client: 'code' }) as JournalEntry),
];

/** Firestore's order, written independently: timestamp descending, then document id bytes descending. */
const firestoreOrder = (a: JournalEntry, b: JournalEntry) => b.timestamp - a.timestamp || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));
const expectedOrder = (list: JournalEntry[]) => [...list].sort(firestoreOrder).map(e => e.id);

/** Every page after the previous page's last note, until the notes run out. */
async function walk(read: (before: EntryBound | undefined) => Promise<JournalEntry[]>): Promise<string[]> {
  const seen: string[] = [];
  let before: EntryBound | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await read(before);
    if (!page.length) return seen;
    seen.push(...page.map(e => e.id));
    const last = page[page.length - 1];
    before = { timestamp: last.timestamp, id: last.id };
  }
  throw new Error('paging did not end');
}

/** Every page through personPage, as the routes read them, with a small batch so batches break inside equal timestamps. */
async function walkPages(fetch: (before: EntryBound | undefined, n: number) => Promise<JournalEntry[]>, limit: number, batch: number,
  visible: (e: JournalEntry) => boolean = () => true): Promise<string[]> {
  const seen: string[] = [];
  let start: EntryBound | undefined;
  for (let guard = 0; guard < 1000; guard++) {
    const page = await personPage({ fetch, visible: async e => visible(e), limit, start, batch });
    seen.push(...page.entries.map(e => e.id));
    if (!page.nextCursor) return seen;
    start = decodePersonCursor(page.nextCursor)!;
    expect(start).not.toBeNull();
  }
  throw new Error('paging did not end');
}

describe('person cursor', () => {
  it('round-trips a place and rejects malformed cursors and ids that are not one document id', () => {
    for (const id of ['a-b', 'Mixed.Case_id~1', 'é-ü']) expect(decodePersonCursor(encodePageCursor({ timestamp: 5, id }))).toEqual({ timestamp: 5, id });
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    for (const bad of ['', 'not base64 at all!', enc({ t: '5', id: 'x' }), enc({ t: 5, id: '' }), enc([1, 2]), enc({ t: 5 }),
      enc({ t: 5, id: 'a/b' }), enc({ t: 5, id: '.' }), enc({ t: 5, id: '..' }), enc({ t: 5, id: '__name__' }), enc({ t: 5, id: '__x__' }),
      enc({ t: 5, id: 'x'.repeat(513) }), enc({ t: 5, id: 'é'.repeat(300) }), enc({ t: 5, id: 7 }), 'x'.repeat(2000)]) {
      expect(decodePersonCursor(bad)).toBeNull();
    }
    expect(decodePersonCursor(enc({ t: 5, id: '_x_' }))).toEqual({ timestamp: 5, id: '_x_' });
    expect(decodePersonCursor(null)).toBeNull();
  });

  it('orders by timestamp, then id bytes, exactly as Firestore does', () => {
    const list = awkward('p');
    expect([...list].sort(compareByPersonOrder).map(e => e.id)).toEqual(expectedOrder(list));
    // Non-ASCII ids compare by UTF-8 bytes, not by UTF-16 code units.
    const wide = ['￿', '\u{1F600}', 'z', 'é'].map(id => ({ id, timestamp: 1 }) as JournalEntry);
    expect([...wide].sort(compareByPersonOrder).map(e => e.id)).toEqual(expectedOrder(wide));
    expect(isOlderThan({ timestamp: 10, id: 'B' }, { timestamp: 10, id: 'a' })).toBe(true);
    expect(isOlderThan({ timestamp: 10, id: 'a' }, { timestamp: 10, id: 'a' })).toBe(false);
    expect(isOlderThan({ timestamp: 11, id: 'a' }, { timestamp: 10, id: 'c' })).toBe(false);
  });
});

describe('MemoryStorage pages one person in Firestore order', () => {
  it('returns each note once, in order, by handle and by pseudonym, across batch boundaries', async () => {
    const storage = new MemoryStorage();
    const mine = [...notes('ann', 37), ...awkward('ann')];
    for (const e of [...mine, ...notes('bob', 9)].sort(() => 0.5 - Math.random())) await storage.addEntry(e);
    expect(await walk(before => storage.getEntriesByHandle('ann', 5, undefined, before))).toEqual(expectedOrder(mine));
    expect(await walk(before => storage.getEntriesByPseudonym('ann#1', 5, { before }))).toEqual(expectedOrder(mine));
    for (const [limit, batch] of [[1, 3], [4, 3], [7, 2], [50, 5]]) {
      expect(await walkPages((before, n) => storage.getEntriesByHandle('ann', n, undefined, before), limit, batch)).toEqual(expectedOrder(mine));
    }
    // `since` still applies together with the place.
    const since = await storage.getEntriesByHandle('ann', 100, 1050, { timestamp: 1070, id: 'ann-029' });
    expect(since.length).toBeGreaterThan(0);
    expect(since.every(e => e.timestamp >= 1050 && isOlderThan(e, { timestamp: 1070, id: 'ann-029' }))).toBe(true);
  });
});

describe('StagedStorage pages one person in Firestore order', () => {
  it('passes the place to published storage and applies it to waiting notes', async () => {
    const published = new MemoryStorage();
    const staged = new StagedStorage(3600000, published);
    staged.stop();
    const mine = [...notes('ann', 23), ...awkward('ann')];
    for (const e of mine) await published.addEntry(e);
    expect(await walk(before => staged.getEntriesByHandle('ann', 4, undefined, before))).toEqual(expectedOrder(mine));

    const waiting = await staged.addEntry({ handle: 'ann', pseudonym: 'ann#1', content: 'waiting', timestamp: 1025, client: 'code' } as JournalEntry);
    const all = [...mine, waiting];
    expect(await walk(before => staged.getEntriesByPseudonym('ann#1', 4, { includePending: true, before }))).toEqual(expectedOrder(all));
    expect(await walk(before => staged.getEntriesByPseudonym('ann#1', 4, { before }))).toEqual(expectedOrder(mine));
    expect((await staged.getEntriesByPseudonym('ann#1', 100, true)).map(e => e.id)).toEqual(expectedOrder(all));
    expect(await walk(before => staged.getEntriesByHandle('ann', 4, undefined, before))).not.toContain(waiting.id);
  });
});

describe('author storage pages one person in Firestore order', () => {
  it('pages a linked author and an unlinked one, mixed-case and punctuation ids included', async () => {
    const codec = recordCodec(Buffer.alloc(32, 7), Buffer.alloc(32, 8));
    const base = new MemoryStorage();
    const data = new Map<string, Map<string, string>>([['space:alice', new Map()]]);
    const alice = await base.createUser({ handle: 'alice', secretKeyHash: 'alice', legacyPseudonym: 'alice#1' });
    await base.createUser({ handle: 'bob', secretKeyHash: 'bob', legacyPseudonym: 'bob#1' });
    // Unlinked notes already in the database are served from it.
    const bobNotes = [...notes('bob', 13), ...awkward('bob')];
    for (const e of bobNotes) await base.addEntry(e);
    const layer = authorStorage(base, async b => versionedMemoryStore(data.get(b.space)!, () => {}), codec);
    const binding: AuthorBinding = { ownerDid: `did:pkh:eip155:1:${testWallet('alice').address}`, space: 'space:alice',
      ownerPublicKey: testWallet('alice').signingKey.publicKey, prefix: 'router/', delegation: 'grant:alice', pseudonym: 'alice#1', linkedAt: 1000 };
    await layer.link(alice, binding);
    // Records in an author's own storage take ids of letters, digits, '_' and '-' only; case and punctuation still differ.
    const aliceNotes = [...notes('alice', 19), ...awkward('alice').filter(e => /^[\w-]+$/.test(e.id))];
    expect(aliceNotes.length).toBeGreaterThan(30);
    for (const e of aliceNotes) await layer.storage.addEntry(e);
    expect([...data.get('space:alice')!.keys()].filter(k => k.startsWith('posts/')).length).toBe(aliceNotes.length);
    const fresh = authorStorage(base, async b => versionedMemoryStore(data.get(b.space)!, () => {}), codec).storage;
    for (const storage of [layer.storage, fresh] as Storage[]) {
      expect(await walk(before => storage.getEntriesByHandle('alice', 3, undefined, before))).toEqual(expectedOrder(aliceNotes));
      expect(await walk(before => storage.getEntriesByPseudonym('alice#1', 3, { before }))).toEqual(expectedOrder(aliceNotes));
      expect(await walk(before => storage.getEntriesByHandle('bob', 3, undefined, before))).toEqual(expectedOrder(bobNotes));
      expect(await walkPages((before, n) => storage.getEntriesByHandle('alice', n, undefined, before), 4, 3)).toEqual(expectedOrder(aliceNotes));
    }
  });
});

/** A stand-in for the Firestore query API: equality filters, ranges, both orderings, startAfter and limit, in byte order. */
function fakeFirestore(docs: JournalEntry[]) {
  const calls: string[][] = [];
  const query = (steps: string[], filters: ((e: JournalEntry) => boolean)[], after?: [number, string], n = Infinity): any => ({
    where: (field: keyof JournalEntry, op: string, value: any) => {
      if (op === '==') return query([...steps, `where ${String(field)} ==`], [...filters, e => e[field] === value], after, n);
      if (op === '>=') return query([...steps, `where ${String(field)} >=`], [...filters, e => (e[field] as number) >= value], after, n);
      throw new Error(`unsupported ${op}`);
    },
    orderBy: (field: string, dir: string) => query([...steps, `orderBy ${field} ${dir}`], filters, after, n),
    startAfter: (t: number, id: string) => query([...steps, 'startAfter'], filters, [t, id], n),
    limit: (k: number) => query([...steps, `limit`], filters, after, k),
    get: async () => {
      calls.push(steps);
      expect(steps).toContain('orderBy timestamp desc');
      expect(steps).toContain('orderBy __name__ desc');
      let list = docs.filter(e => filters.every(f => f(e))).sort(firestoreOrder);
      if (after) list = list.filter(e => firestoreOrder(e, { timestamp: after[0], id: after[1] } as JournalEntry) > 0);
      return { docs: list.slice(0, n).map(e => { const { id, ...rest } = e; return { id, data: () => rest }; }) };
    },
  });
  return { db: { collection: () => query([], []) }, calls };
}

describe('FirestoreStorage pages one person by (timestamp, document id)', () => {
  it('orders by timestamp then document id and starts after the place, across batch boundaries', async () => {
    const mine = [...notes('ann', 29), ...awkward('ann')];
    const fake = fakeFirestore([...mine, ...notes('bob', 7)]);
    const storage = Object.assign(Object.create(FirestoreStorage.prototype), { db: fake.db, collection: 'entries' }) as FirestoreStorage;
    expect(await walk(before => storage.getEntriesByHandle('ann', 4, undefined, before))).toEqual(expectedOrder(mine));
    expect(await walk(before => storage.getEntriesByPseudonym('ann#1', 4, { before }))).toEqual(expectedOrder(mine));
    for (const [limit, batch] of [[1, 3], [5, 4], [6, 200]]) {
      expect(await walkPages((before, n) => storage.getEntriesByHandle('ann', n, undefined, before), limit, batch)).toEqual(expectedOrder(mine));
      // Hidden notes between visible ones change nothing about which visible notes come back.
      expect(await walkPages((before, n) => storage.getEntriesByHandle('ann', n, undefined, before), limit, batch, e => /[A-Z]/.test(e.id)))
        .toEqual(expectedOrder(mine).filter(id => /[A-Z]/.test(id)));
    }
    expect(fake.calls.some(steps => steps.includes('startAfter'))).toBe(true);
    expect(fake.calls[0]).toEqual(['where handle ==', 'orderBy timestamp desc', 'orderBy __name__ desc', 'limit']);
    await storage.getEntriesByHandle('ann', 4, 1020);
    expect(fake.calls[fake.calls.length - 1]).toEqual(['where handle ==', 'where timestamp >=', 'orderBy timestamp desc', 'orderBy __name__ desc', 'limit']);
  });
});

describe('personPage', () => {
  const ordered = [...notes('ann', 40), ...awkward('ann')].sort(compareByPersonOrder);
  const source = (list: JournalEntry[], counter?: { reads: number; notes: number }) => async (before: EntryBound | undefined, n: number) => {
    const out = list.filter(e => isOlderThan(e, before)).slice(0, n);
    if (counter) { counter.reads++; counter.notes += out.length; }
    return out;
  };

  it('takes storage order as given and never shows a note twice', async () => {
    // A storage that repeats a note at a batch edge: the repeat is skipped, not shown again.
    const repeating = async (before: EntryBound | undefined, n: number) => {
      const out = ordered.filter(e => isOlderThan(e, before)).slice(0, n);
      const i = before ? ordered.findIndex(e => e.id === before.id) : -1;
      return i >= 0 ? [ordered[i], ...out].slice(0, n) : out;
    };
    expect(await walkPages(repeating, 4, 3)).toEqual(ordered.map(e => e.id));
  });

  it('reads once per request from storage held in memory', async () => {
    const counter = { reads: 0, notes: 0 };
    await personPage({ fetch: source(ordered, counter), visible: async () => false, limit: 1, batch: PERSON_SCAN_ALL });
    expect(counter).toEqual({ reads: 1, notes: ordered.length });
  });

  it('finds a visible note after very many hidden ones, with no early end of the list', async () => {
    const hidden = notes('hid', 25000).map(e => ({ ...e, timestamp: e.timestamp + 100000 }));
    const last = { id: 'vis-1', handle: 'hid', pseudonym: 'hid#1', content: 'visible', timestamp: 1, client: 'code' } as JournalEntry;
    const list = [...hidden, last].sort(compareByPersonOrder);
    for (const batch of [200, PERSON_SCAN_ALL]) {
      const page = await personPage({ fetch: source(list), visible: async e => e.id === last.id, limit: 5, batch });
      expect(page).toEqual({ entries: [last], nextCursor: null });
      // And when it sits between pages: a page of one, a cursor, then the visible note.
      const first = await personPage({ fetch: source(list), visible: async e => e.id === last.id || e.id === list[0].id, limit: 1, batch });
      expect(first.entries.map(e => e.id)).toEqual([list[0].id]);
      const second = await personPage({ fetch: source(list), visible: async e => e.id === last.id || e.id === list[0].id, limit: 1, batch,
        start: decodePersonCursor(first.nextCursor)! });
      expect(second).toEqual({ entries: [last], nextCursor: null });
    }
  });

  it('merges a handle list and a legacy pseudonym list in order without repeats', () => {
    const a = ordered.filter((_, i) => i % 2 === 0);
    const b = ordered.filter((_, i) => i % 3 === 0);
    expect(mergePersonNotes(a, b, 1000).map(e => e.id)).toEqual(ordered.filter((_, i) => i % 2 === 0 || i % 3 === 0).map(e => e.id));
    expect(mergePersonNotes(a, b, 5)).toHaveLength(5);
  });

  it('answers 503, not a short page, when storage cannot be read', async () => {
    const failing = await personPageAnswer(() => personPage({
      fetch: async () => { throw new Error('index unavailable'); }, visible: async () => true, limit: 5, batch: 200,
    }));
    expect(failing).toEqual({ status: 503, body: { error: 'Notes could not be read just now. Try again.' } });
    expect(await personPageAnswer(async () => ({ ok: 1 }))).toEqual({ status: 200, body: { ok: 1 } });
  });

  it('measures one request for a 5,000-note author with limit=1 and every note hidden', async () => {
    const many = notes('big', 5000);
    const memory = new MemoryStorage();
    for (const e of many) await memory.addEntry(e);
    const codec = recordCodec(Buffer.alloc(32, 7), Buffer.alloc(32, 8));
    const base = new MemoryStorage();
    await base.createUser({ handle: 'big', secretKeyHash: 'big', legacyPseudonym: 'big#1' });
    for (const e of many) await base.addEntry(e);
    for (const e of notes('other', 5000)) await base.addEntry(e);
    const layer = authorStorage(base, null, codec).storage;
    await layer.getEntriesByHandle('big', 1); // load the index once, as a running server has
    const fake = fakeFirestore(many);
    const firestore = Object.assign(Object.create(FirestoreStorage.prototype), { db: fake.db, collection: 'entries' }) as FirestoreStorage;
    const timings: Record<string, number> = {};
    for (const [name, storage, batch] of [['memory', memory, 20000], ['author store', layer, 20000], ['firestore stand-in', firestore, 200]] as const) {
      const runs: number[] = [];
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now();
        const page = await personPage({ fetch: (before, n) => storage.getEntriesByHandle('big', n, undefined, before),
          visible: async () => false, limit: 1, batch });
        runs.push(performance.now() - t0);
        expect(page).toEqual({ entries: [], nextCursor: null });
      }
      timings[name] = runs.sort((x, y) => x - y)[2];
    }
    console.log(`5,000 hidden notes, limit=1, median of 5 requests (ms): ${JSON.stringify(Object.fromEntries(
      Object.entries(timings).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`);
    for (const ms of Object.values(timings)) expect(ms).toBeLessThan(2000);
  }, 60000);
});

describe('choosing handle or pseudonym for /api/entries/:identifier', () => {
  /** Master's first page: the handle's notes, or, when there are none, the pseudonym's. */
  async function masterFirstPage(storage: MemoryStorage, identifier: string, limit: number) {
    let entries = await storage.getEntriesByHandle(identifier, limit);
    if (entries.length === 0) entries = await storage.getEntriesByPseudonym(identifier, limit);
    return entries.map(e => e.id);
  }
  const page = async (storage: MemoryStorage, identifier: string, limit: number, start?: EntryBound) =>
    personPage({ fetch: await personNotesSource(storage, identifier, false), visible: async () => true, limit, start, batch: PERSON_SCAN_ALL });
  const entry = (id: string, timestamp: number, fields: Partial<JournalEntry>) =>
    ({ id, timestamp, content: id, client: 'code', pseudonym: 'x#1', ...fields }) as JournalEntry;

  async function fixture() {
    const storage = new MemoryStorage();
    // A registered handle with no notes under it, whose text is also the pseudonym on some notes.
    await storage.createUser({ handle: 'zed', secretKeyHash: 'zed' });
    for (let i = 0; i < 7; i++) await storage.addEntry(entry(`zp${i}`, 100 + i, { pseudonym: 'zed' }));
    // Notes under a handle that has no user record now.
    for (let i = 0; i < 7; i++) await storage.addEntry(entry(`gh${i}`, 200 + i, { handle: 'ghost', pseudonym: 'Old Ghost#aaa111' }));
    // An ordinary author with handle notes and older pseudonym-only notes.
    await storage.createUser({ handle: 'ann', secretKeyHash: 'ann' });
    for (let i = 0; i < 7; i++) await storage.addEntry(entry(`an${i}`, 300 + i, { handle: 'ann', pseudonym: 'Calm Ann#bbb222' }));
    for (let i = 0; i < 4; i++) await storage.addEntry(entry(`ap${i}`, 50 + i, { pseudonym: 'Calm Ann#bbb222' }));
    return storage;
  }

  it('reads pseudonym notes for a registered handle that has no handle notes, on page one and after a cursor', async () => {
    const storage = await fixture();
    const one = await page(storage, 'zed', 3);
    expect(one.entries.map(e => e.id)).toEqual(['zp6', 'zp5', 'zp4']);
    const two = await page(storage, 'zed', 3, decodePersonCursor(one.nextCursor)!);
    expect(two.entries.map(e => e.id)).toEqual(['zp3', 'zp2', 'zp1']);
  });

  it('reads handle notes that have no current user record, on page one and after a cursor', async () => {
    const storage = await fixture();
    const one = await page(storage, 'ghost', 3);
    expect(one.entries.map(e => e.id)).toEqual(['gh6', 'gh5', 'gh4']);
    const two = await page(storage, 'ghost', 3, decodePersonCursor(one.nextCursor)!);
    expect(two.entries.map(e => e.id)).toEqual(['gh3', 'gh2', 'gh1']);
    // After the last handle note, a later page stays on the handle path instead of switching to a pseudonym.
    const last = await page(storage, 'ghost', 3, { timestamp: 200, id: 'gh0' });
    expect(last).toEqual({ entries: [], nextCursor: null });
  });

  it('gives the same first page as master for a handle and for a pseudonym', async () => {
    const storage = await fixture();
    for (const identifier of ['ann', 'Calm Ann#bbb222', 'zed', 'ghost', 'Old Ghost#aaa111', 'nobody']) {
      for (const limit of [3, 50]) {
        expect((await page(storage, identifier, limit)).entries.map(e => e.id)).toEqual(await masterFirstPage(storage, identifier, limit));
      }
    }
  });
});
