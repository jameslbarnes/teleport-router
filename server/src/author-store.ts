/** Published records in each author's own store. Pending records stay in StagedStorage.
 * The in-memory index never falls back to legacy copies for a linked author.
 * A grant check gives a short read lease; failed/expired checks evict that author.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { tokenize, encodePageCursor, generateEntryId, type Storage, type User,
  type JournalEntry, type Conversation, type Summary, type DailySummary } from './storage.js';
import type { GroupStore } from './group-store.js';
import { isPublicNotebookEntry } from './public-views.js';

export interface AuthorBinding {
  ownerDid: string;
  space: string;
  prefix: string;
  delegation: string;
  pseudonym: string;
  linkedAt: number;
}
export type AuthorStoreResolver = (binding: AuthorBinding) => Promise<GroupStore>;
type RecordValue = JournalEntry | Conversation | Summary;
type NewRecord = Omit<JournalEntry, 'id'> | Omit<Conversation, 'id'> | Omit<Summary, 'id'>;
type Kind = 'posts' | 'conversations' | 'summaries';
type BindingUser = User & { tinycloud: AuthorBinding };
type AuthorState = { user: BindingUser; expires: number; available: boolean; retryAt?: number; checking?: Promise<void> };
const order = (a: {timestamp: number; id: string}, b: {timestamp: number; id: string}) => b.timestamp - a.timestamp || b.id.localeCompare(a.id);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))) : value);

/** Store integrity is separate from ownership. An author cannot edit JSON to impersonate
 * another author, change group addressing, or manufacture a previously moderated record. */
export function recordCodec(key: Uint8Array) {
  const mac = (owner: string, kind: Kind, value: RecordValue) => createHmac('sha256', key)
    .update(`router-record-v1\0${owner}\0${kind}\0${canonical(value)}`).digest('hex');
  return {
    encode(owner: string, kind: Kind, value: RecordValue) { return canonical({ version: 1, value, mac: mac(owner, kind, value) }); },
    decode(raw: string, owner: string, kind: Kind, id: string): RecordValue {
      const record = JSON.parse(raw);
      const value = record?.value;
      if (record.version !== 1 || !value || value.id !== id || !validId(id)
        || !Number.isFinite(value.timestamp) || typeof value.content !== 'string'
        || !/^[a-f0-9]{64}$/.test(record.mac || '')) throw new Error('Invalid author record');
      const expected = Buffer.from(mac(owner, kind, value), 'hex');
      if (!timingSafeEqual(expected, Buffer.from(record.mac, 'hex'))) throw new Error('Author record integrity check failed');
      return value;
    },
  };
}

async function parallel<T>(items: T[], fn: (item: T) => Promise<void>, concurrency = 8) {
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}

export function authorStorage(base: Storage, resolveStore: AuthorStoreResolver,
  codec: ReturnType<typeof recordCodec>, { leaseMs = 60000, now = Date.now } = {}) {
  const extra = base as Storage & Record<string, any>;
  const entries = new Map<string, JournalEntry>();
  const conversations = new Map<string, Conversation>();
  const summaries = new Map<string, Summary>();
  const daily = new Map<string, DailySummary>();
  const authors = new Map<string, AuthorState>();
  const handlesByPseudonym = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();
  let initializing: Promise<void> | undefined;
  const index = (kind: Kind): Map<string, any> => kind === 'posts' ? entries : kind === 'conversations' ? conversations : summaries;
  const ownerOf = (value: {handle?: string; pseudonym: string}) => value.handle && authors.has(value.handle)
    ? value.handle : [...authors].find(([, s]) => belongs(value, s.user))?.[0];
  const belongs = (value: {handle?: string; pseudonym: string}, user: BindingUser) =>
    value.handle === user.handle || value.pseudonym === user.tinycloud.pseudonym || value.pseudonym === user.legacyPseudonym;
  async function exclusive<T>(handle: string, action: () => Promise<T>): Promise<T> {
    const prior = locks.get(handle) || Promise.resolve();
    const task = prior.catch(() => {}).then(action);
    locks.set(handle, task);
    try { return await task; } finally { if (locks.get(handle) === task) locks.delete(handle); }
  }
  function evict(user: BindingUser) {
    for (const map of [entries, conversations, summaries]) for (const [id, value] of map) if (belongs(value, user)) map.delete(id);
    for (const [date, summary] of daily) if (summary.pseudonyms.some(p => belongs({pseudonym:p},user))) daily.delete(date);
  }
  async function readAuthor(state: AuthorState) {
    const binding = state.user.tinycloud;
    const store = await resolveStore(binding);
    const loaded: { kind: Kind; value: RecordValue }[] = [];
    for (const kind of ['posts', 'conversations', 'summaries'] as Kind[]) {
      const keys = await store.list(`${kind}/`);
      await parallel(keys, async key => {
        const id = key.slice(kind.length + 1);
        if (key !== `${kind}/${id}` || !validId(id)) throw new Error('Invalid author record path');
        const raw = await store.get(key);
        if (raw === null) return;
        const value = codec.decode(raw, binding.ownerDid, kind, id);
        if (!belongs(value, state.user) || ('handle' in value && value.handle && value.handle !== state.user.handle))
          throw new Error('Author identity mismatch');
        const existing = index(kind).get(id);
        if (existing && !belongs(existing, state.user)) throw new Error('Author record ID collision');
        loaded.push({ kind, value });
      });
    }
    return loaded;
  }
  async function loadAuthor(state: AuthorState) {
    const loaded = await readAuthor(state);
    evict(state.user);
    for (const { kind, value } of loaded) index(kind).set(value.id, value);
    state.available = true;
    state.expires = now() + leaseMs;
  }
  async function check(state: AuthorState, reload = false) {
    if (!reload && state.available && state.expires > now()) return;
    if (!reload && !state.available && (state.retryAt || 0) > now()) return;
    if (state.checking) return state.checking;
    const started = now();
    state.checking = exclusive(state.user.handle, async () => {
      try {
        if (reload || !state.available) await loadAuthor(state);
        else {
          const store = await resolveStore(state.user.tinycloud);
          // Listing verifies the current grant and lets owner-side deletions take effect.
          const keys = new Set(await store.list('posts/'));
          for (const [id, e] of entries) if (belongs(e, state.user) && !keys.has(`posts/${id}`)) entries.delete(id);
          for (const kind of ['conversations', 'summaries'] as Kind[]) {
            const kept = new Set(await store.list(`${kind}/`));
            for (const [id, value] of index(kind)) if (belongs(value, state.user) && !kept.has(`${kind}/${id}`)) index(kind).delete(id);
          }
          state.expires = started + leaseMs;
        }
      } catch {
        state.available = false;
        state.expires = 0;
        state.retryAt = now() + Math.min(10000, leaseMs);
        evict(state.user);
      }
    }).finally(() => { delete state.checking; });
    await state.checking;
  }
  async function pageAll<T>(fetch: (limit: number, offset: number, cursor?: string) => Promise<T[]>, save: (v: T) => void) {
    let cursor: string | undefined;
    for (;;) {
      const page = await fetch(500, 0, cursor);
      page.forEach(save);
      if (page.length < 500) break;
      const next = encodePageCursor(page[page.length - 1] as {timestamp: number; id: string});
      if (next === cursor) throw new Error('Published storage pagination did not advance');
      cursor = next;
    }
  }
  async function init() {
    initializing ??= (async () => {
      for (const user of await base.getAllUsers()) {
        if (user.legacyPseudonym) handlesByPseudonym.set(user.legacyPseudonym,user.handle);
        if (user.tinycloud) {
          handlesByPseudonym.set(user.tinycloud.pseudonym,user.handle);
          authors.set(user.handle,{ user: user as BindingUser, expires: 0, available: false });
        }
      }
      await pageAll(base.getEntries.bind(base), e => { if (!ownerOf(e)) entries.set(e.id, e); });
      await pageAll(base.getConversations.bind(base), c => { if (!ownerOf(c)) conversations.set(c.id, c); });
      if (extra.getSummaries) for (const s of await extra.getSummaries(100000)) if (!ownerOf(s)) summaries.set(s.id, s);
      if (extra.getDailySummaries) for (const s of await extra.getDailySummaries(100000))
        if (!s.pseudonyms.some((p: string) => ownerOf({pseudonym: p}))
          && (s.publicOnly || ![...entries.values()].some(e=>new Date(e.timestamp).toISOString().slice(0,10)===s.date&&!isPublicNotebookEntry(e)))) daily.set(s.date, s);
      await Promise.all([...authors.values()].map(s => check(s, true)));
    })().catch(err => { initializing = undefined; entries.clear(); conversations.clear(); summaries.clear(); daily.clear(); throw err; });
    await initializing;
  }
  async function ready() { await init(); await Promise.all([...authors.values()].map(s => check(s))); }
  async function list<T extends RecordValue>(kind: Kind): Promise<T[]> { await ready(); return [...index(kind).values()].sort(order); }
  const search = (query: string, value: { content: string; keywords?: string[] }) => {
    const words = value.keywords || tokenize(value.content);
    return tokenize(query).some(word => words.includes(word));
  };
  const paginate = <T extends {timestamp: number; id: string}>(values: T[], limit: number, offset: number, cursor?: string) => {
    if (cursor) {
      try { const c = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (Number.isFinite(c.t) && typeof c.id === 'string') return values.filter(v => order(v, {timestamp:c.t,id:c.id}) > 0).slice(0, limit);
      } catch { /* match legacy cursor fallback */ }
    }
    return values.slice(offset, offset + limit);
  };
  async function write(kind: Kind, value: NewRecord): Promise<any> {
    await init();
    const lockHandle = ('handle' in value && typeof value.handle === 'string' && value.handle)
      || handlesByPseudonym.get(value.pseudonym) || '__legacy';
    const save = async () => {
      const handle = ownerOf(value);
      const state = handle ? authors.get(handle) : undefined;
      let saved;
      if (state) {
        if (!state.available) await loadAuthor(state);
        const store = await resolveStore(state.user.tinycloud);
        saved = { ...value, id: (value as RecordValue).id || generateEntryId(), keywords: tokenize(value.content) } as RecordValue;
        await store.put(`${kind}/${saved.id}`, codec.encode(state.user.tinycloud.ownerDid, kind, saved));
        state.available = true;
        state.expires = now() + leaseMs;
      } else saved = await (kind === 'posts' ? base.addEntry(value as JournalEntry)
        : kind === 'conversations' ? base.addConversation(value as Conversation)
        : extra.addSummary ? extra.addSummary(value) : { ...value, id: generateEntryId() });
      index(kind).set(saved.id, saved);
      return saved;
    };
    return exclusive(lockHandle, save);
  }
  async function remove(kind: Kind, id: string) {
    await ready();
    const value = index(kind).get(id);
    if (!value) return;
    const lockHandle = value.handle || handlesByPseudonym.get(value.pseudonym) || '__legacy';
    await exclusive(lockHandle, async () => {
      const handle = ownerOf(value);
      if (handle) await (await resolveStore(authors.get(handle)!.user.tinycloud)).delete(`${kind}/${id}`);
      else await (kind === 'posts' ? base.deleteEntry(id) : kind === 'conversations' ? base.deleteConversation(id) : extra.deleteSummary?.(id));
      index(kind).delete(id);
    });
  }
  const overrides: Record<string, any> = {
    createUser: async (v: Omit<User,'createdAt'>) => { const user=await base.createUser(v);
      if(user.legacyPseudonym)handlesByPseudonym.set(user.legacyPseudonym,user.handle); return user; },
    addEntry: (v: JournalEntry) => write('posts', v), addConversation: (v: Conversation) => write('conversations', v),
    getEntry: async (id: string) => { await ready(); return entries.get(id) || null; },
    getConversation: async (id: string) => { await ready(); return conversations.get(id) || null; },
    getEntries: async (n=50,o=0,c?:string) => paginate(await list<JournalEntry>('posts'),n,o,c),
    getConversations: async (n=50,o=0,c?:string) => paginate(await list<Conversation>('conversations'),n,o,c),
    getEntriesByPseudonym: async (p:string,n=50) => (await list<JournalEntry>('posts')).filter(e=>e.pseudonym===p).slice(0,n),
    getEntriesByHandle: async (h:string,n=50,s=0) => (await list<JournalEntry>('posts')).filter(e=>e.handle===h&&e.timestamp>=s).slice(0,n),
    getConversationsByPseudonym: async (p:string,n=50) => (await list<Conversation>('conversations')).filter(e=>e.pseudonym===p).slice(0,n),
    searchEntries: async (q:string,n=50,s=0) => (await list<JournalEntry>('posts')).filter(e=>e.timestamp>=s&&search(q,e)).slice(0,n),
    searchConversations: async (q:string,n=50,s=0) => (await list<Conversation>('conversations')).filter(e=>e.timestamp>=s&&search(q,e)).slice(0,n),
    getEntriesSince: async (s:number,n=50) => (await list<JournalEntry>('posts')).filter(e=>e.timestamp>=s).slice(0,n),
    getEntryCount: async () => { await ready(); return entries.size; },
    deleteEntry: (id:string) => remove('posts',id), deleteConversation: (id:string) => remove('conversations',id),
    getEntriesAddressedTo: async (h:string,email?:string,n=50) => (await list<JournalEntry>('posts'))
      .filter(e=>e.to?.some(d=>d===`@${h}`||d===h||(email&&d.toLowerCase()===email.toLowerCase()))).slice(0,n),
    getRepliesTo: async (id:string,n=50) => (await list<JournalEntry>('posts')).filter(e=>e.inReplyTo===id).reverse().slice(0,n),
    getChannelEntries: async (id:string,n=50) => (await list<JournalEntry>('posts')).filter(e=>e.channel===id||e.to?.includes(`#${id}`)).slice(0,n),
    getEntriesInRange: async (p:string,s:number,e:number) => (await list<JournalEntry>('posts')).filter(v=>v.pseudonym===p&&v.timestamp>=s&&v.timestamp<=e).reverse(),
    getEntriesForDate: async (date:string) => { const start=Date.parse(`${date}T00:00:00Z`); return (await list<JournalEntry>('posts')).filter(e=>e.timestamp>=start&&e.timestamp<start+86400000).reverse(); },
    addSummary: (v:Summary) => write('summaries',v), deleteSummary: (id:string) => remove('summaries',id),
    getSummaries: async (n=50) => (await list<Summary>('summaries'))
      .filter(s=>s.entryIds.length>0&&s.entryIds.every(id=>{const entry=entries.get(id);return entry&&isPublicNotebookEntry(entry);})).slice(0,n),
    getLastSummaryForPseudonym: async (p:string) => (await list<Summary>('summaries')).filter(s=>s.pseudonym===p).sort((a,b)=>b.endTime-a.endTime)[0]||null,
    // Cross-author summaries are a derived in-memory view; never persist opted-in writing in Firestore.
    addDailySummary: async (v:DailySummary) => { await ready();
      if(v.pseudonyms.some(p=>{const h=ownerOf({pseudonym:p});return h&&!authors.get(h)!.available;}))
        throw new Error('A contributing author has withdrawn access; regenerate the summary.');
      const s={...v,id:`daily-${v.date}`}; daily.set(v.date,s); return s; },
    getDailySummaries: async (n=30) => { await ready(); return [...daily.values()].sort((a,b)=>b.date.localeCompare(a.date)).slice(0,n); },
    getDailySummary: async (date:string) => { await ready(); return daily.get(date)||null; },
    deleteDailySummary: async (date:string) => { await init(); daily.delete(date); },
    migrateEntriesToHandle: async (p:string,h:string) => { await init(); if (authors.has(h)) return 0;
      const count=await base.migrateEntriesToHandle(p,h); for (const e of entries.values()) if(e.pseudonym===p)e.handle=h; return count; },
    countUnmigratedEntries: async (p:string,h:string) => (await list<JournalEntry>('posts')).filter(e=>e.pseudonym===p&&e.handle!==h).length,
  };
  const storage = new Proxy(base, { get(target, prop, receiver) {
    if (typeof prop === 'string' && prop in overrides) return overrides[prop];
    const value = Reflect.get(target,prop,receiver); return typeof value === 'function' ? value.bind(target) : value;
  }});

  /** Copy, read back, activate, then remove verified legacy records. Serialized per author.
   * Safe to retry: the destination is overwritten only if different, IDs are preserved. */
  async function link(user: User, binding: AuthorBinding, progress: (message: string) => void = () => {}) {
    await init();
    handlesByPseudonym.set(binding.pseudonym,user.handle);
    return exclusive(user.handle, async () => {
      const all = await base.getAllUsers();
      if (all.some(u=>u.handle!==user.handle&&u.tinycloud?.ownerDid.toLowerCase()===binding.ownerDid.toLowerCase()))
        throw new Error('This TinyCloud identity is already linked to another Router account.');
      const previous = authors.get(user.handle);
      if (previous && previous.user.tinycloud.ownerDid.toLowerCase() !== binding.ownerDid.toLowerCase())
        throw new Error('Changing an existing TinyCloud identity requires an explicit migration.');
      const linked = { ...user, tinycloud: binding } as BindingUser;
      const store = await resolveStore(binding);
      await store.list('posts/'); // prove the actual grant works, not only its unsigned metadata
      const records: {kind:Kind;value:RecordValue}[]=[];
      for (const kind of ['posts','conversations','summaries'] as Kind[])
        for(const value of index(kind).values()) if(belongs(value,linked)) records.push({kind,value});
      // Include leftover legacy records on a retry, even after a previous activation
      // hid them from the live index. This makes partial cleanup recoverable.
      const addLegacy = (kind: Kind, value: RecordValue) => {
        if(belongs(value,linked) && !records.some(r=>r.kind===kind&&r.value.id===value.id)) records.push({kind,value});
      };
      await pageAll(base.getEntries.bind(base), v=>addLegacy('posts',v));
      await pageAll(base.getConversations.bind(base), v=>addLegacy('conversations',v));
      if(extra.getSummaries) for(const v of await extra.getSummaries(100000))addLegacy('summaries',v);
      let copied=0;
      await parallel(records, async ({kind,value})=>{
        const key=`${kind}/${value.id}`, wire=codec.encode(binding.ownerDid,kind,value);
        if(await store.get(key)!==wire) await store.put(key,wire);
        if(await store.get(key)!==wire) throw new Error('TinyCloud readback did not match the original record.');
        progress(`Verified ${++copied}/${records.length} records`);
      });
      const state={user:linked,expires:now()+leaseMs,available:true};
      const verified = await readAuthor(state);
      await base.updateUser(user.handle,{tinycloud:binding});
      authors.set(user.handle,state);
      handlesByPseudonym.set(binding.pseudonym,user.handle);
      evict(linked);
      for (const {kind,value} of verified) index(kind).set(value.id,value);
      // Existing records are already the verified originals in memory. Clear derived cross-author summaries.
      const failed:string[]=[];
      await parallel(records,async ({kind,value})=>{
        try { await (kind==='posts'?base.deleteEntry(value.id):kind==='conversations'?base.deleteConversation(value.id):extra.deleteSummary?.(value.id)); }
        catch { failed.push(`${kind}/${value.id}`); }
      });
      if(extra.getDailySummaries && extra.deleteDailySummary) {
        for(const s of await extra.getDailySummaries(100000)) if(s.pseudonyms.some((p:string)=>belongs({pseudonym:p},linked))) {
          try { await extra.deleteDailySummary(s.date); } catch { failed.push(`daily/${s.date}`); }
        }
      }
      return {copied,legacyCleanupPending:failed.length};
    });
  }
  return { storage, ready, link, refresh: async (handle:string) => { await init(); const state=authors.get(handle); if(state)await check(state,true); return state?.available??false; },
    status: async (handle:string) => { await init(); const s=authors.get(handle);
      if(s&&!locks.has(handle))await check(s);
      return s ? {linked:true,available:s.available&&s.expires>now(),space:s.user.tinycloud.space,ownerDid:s.user.tinycloud.ownerDid} : {linked:false}; } };
}
