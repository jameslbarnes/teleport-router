/** Published records in each author's own store. Pending records stay in StagedStorage.
 * The in-memory index never falls back to legacy copies for a linked author.
 * A grant check gives a short read lease; failed/expired checks evict that author.
 */
import { tokenize, encodePageCursor, generateEntryId, type Storage, type User,
  type JournalEntry, type Conversation, type Summary, type DailySummary, type OwnRecords } from './storage.js';
import type { GroupStore } from './group-store.js';
import { isPublicNotebookEntry } from './public-views.js';
import { recordCodec, canonical, RECOVERY_KEY, ownerPublicKey } from './author-records.js';
export { recordCodec } from './author-records.js';

export interface AuthorBinding {
  ownerDid: string;
  space: string;
  prefix: string;
  delegation: string;
  pseudonym: string;
  linkedAt: number;
  /** Recovered from a verified owner link signature. Never the private key. */
  ownerPublicKey?: string;
  /** Durable downgrade barrier, committed only after migration readback. */
  minRecordVersion?: 2;
}
export type AuthorStoreResolver = (binding: AuthorBinding) => Promise<GroupStore>;
type RecordValue = JournalEntry | Conversation | Summary;
type NewRecord = Omit<JournalEntry, 'id'> | Omit<Conversation, 'id'> | Omit<Summary, 'id'>;
type Kind = 'posts' | 'conversations' | 'summaries';
type BindingUser = User & { tinycloud: AuthorBinding };
type AuthorState = { user: BindingUser; expires: number; available: boolean; activationPending?: boolean; retryAt?: number; checking?: Promise<void> };
const order = (a: {timestamp: number; id: string}, b: {timestamp: number; id: string}) => b.timestamp - a.timestamp || b.id.localeCompare(a.id);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);

/** A step of linking an account to its own storage, reported so the caller can show it and time it. */
export type LinkStep = 'waiting' | 'checking' | 'encrypting' | 'finding' | 'copying' | 'reading' | 'saving' | 'cleaning';
export interface LinkOptions {
  /** Time (ms since the epoch) after which the link stops before switching anything, time spent waiting to start included. */
  deadline?: number;
  /** Longest wait for any one storage call. */
  callTimeoutMs?: number;
  onStep?: (step: LinkStep) => void;
}
/** The link ran out of time, or storage did not answer one call in time. Nothing was switched. */
export class LinkTimeoutError extends Error {}
export const LINK_CALL_TIMEOUT_MS = 60_000;
/** Longest a running link pauses grant checks on its account for reads. */
const LINK_PAUSES_CHECKS_MS = 30 * 60_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LinkTimeoutError(`Storage did not answer ${what} within ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The same store, with no single call waiting longer than `ms`. A call that lands late is harmless
 * to linking, whose every write is conditional. */
function timeLimited(store: GroupStore, ms: number): GroupStore {
  const limited: GroupStore = {
    put: (key, value, condition) => within(store.put(key, value, condition), ms, 'a write'),
    get: key => within(store.get(key), ms, 'a read'),
    list: path => within(store.list(path), ms, 'a listing'),
    delete: key => within(store.delete(key), ms, 'a deletion'),
  };
  if (store.getVersioned) limited.getVersioned = key => within(store.getVersioned!(key), ms, 'a read');
  return limited;
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
  /** Accounts with a link running, and until when reads keep serving what was loaded instead of waiting for it. */
  const linking = new Map<string, { count: number; until: number }>();
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
  async function readAuthor(state: AuthorState, opened?: GroupStore) {
    const binding = state.user.tinycloud;
    const store = opened || await resolveStore(binding);
    const loaded: { kind: Kind; value: RecordValue }[] = [];
    for (const kind of ['posts', 'conversations', 'summaries'] as Kind[]) {
      const keys = await store.list(`${kind}/`);
      await parallel(keys, async key => {
        const id = key.slice(kind.length + 1);
        if (key !== `${kind}/${id}` || !validId(id)) throw new Error('Invalid author record path');
        const raw = await store.get(key);
        if (raw === null) return;
        const value = codec.decode(raw, binding, kind, id, binding.minRecordVersion || 1);
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
    const binding = state.user.tinycloud;
    if (binding.minRecordVersion === 2) {
      const recovery = await (await resolveStore(binding)).get(RECOVERY_KEY);
      if (!recovery || !binding.ownerPublicKey) throw new Error('Owner recovery is missing');
      codec.verifyRecovery(recovery, binding, binding.ownerPublicKey);
    }
    const loaded = await readAuthor(state);
    evict(state.user);
    for (const { kind, value } of loaded) index(kind).set(value.id, value);
    state.available = true;
    state.expires = now() + leaseMs;
  }
  async function check(state: AuthorState, reload = false) {
    if (state.activationPending) return; // uncertain metadata commit: only a verified re-link can resume
    if (!reload && state.available && state.expires > now()) return;
    if (!reload && !state.available && (state.retryAt || 0) > now()) return;
    // A re-link holds this account for as long as it runs; everyone's reads would otherwise wait on it.
    // The link proves the grant itself, and the next check after it ends catches any revocation.
    if (!reload && (linking.get(state.user.handle)?.until || 0) > now()) return;
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
        if (state.activationPending) throw new Error('TinyCloud migration metadata is pending; retry linking before publishing.');
        if (state.user.tinycloud.minRecordVersion !== 2) throw new Error('Re-link TinyCloud with your owner key to enable encrypted writes. Your waiting post is retained.');
        if (!state.available) await loadAuthor(state);
        const store = await resolveStore(state.user.tinycloud);
        saved = { ...value, id: (value as RecordValue).id || generateEntryId(), keywords: tokenize(value.content) } as RecordValue;
        await store.put(`${kind}/${saved.id}`, codec.encode(state.user.tinycloud, kind, saved));
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

  /** Encrypt, read back, commit the durable v2 floor, then clean up legacy copies.
   * Existing TinyCloud records are authoritative. Never restore them from a stale
   * cache/Firestore copy, and never replace an owner edit/deletion without its ETag. */
  async function link(user: User, binding: AuthorBinding, progress: (message: string) => void = () => {},
    { deadline = Infinity, callTimeoutMs = LINK_CALL_TIMEOUT_MS, onStep = () => {} }: LinkOptions = {}) {
    const due = () => { if (now() > deadline) throw new LinkTimeoutError('The link ran out of time before switching storage.'); };
    onStep('waiting');
    const running = linking.get(user.handle);
    linking.set(user.handle, { count: (running?.count || 0) + 1,
      until: Math.max(running?.until || 0, Math.min(deadline, now() + LINK_PAUSES_CHECKS_MS)) });
    try {
      await init();
      handlesByPseudonym.set(binding.pseudonym,user.handle);
      // One link at a time per storage identity, so two accounts cannot both claim it, and per account.
      // Links for other accounts and other storage run alongside.
      return await exclusive(`did:${binding.ownerDid.toLowerCase()}`, () => linkAccount(user, binding, progress, due, callTimeoutMs, onStep));
    } finally {
      const done = linking.get(user.handle);
      if (done && --done.count === 0) linking.delete(user.handle);
    }
  }
  function linkAccount(user: User, binding: AuthorBinding, progress: (message: string) => void, due: () => void,
    callTimeoutMs: number, onStep: (step: LinkStep) => void) {
    return exclusive(user.handle, async () => {
      due();
      onStep('checking');
      const all = await base.getAllUsers();
      if (all.some(u=>u.handle!==user.handle&&u.tinycloud?.ownerDid.toLowerCase()===binding.ownerDid.toLowerCase()))
        throw new Error('This TinyCloud identity is already linked to another Router account.');
      const previous = authors.get(user.handle);
      const durableBinding = all.find(u=>u.handle===user.handle)?.tinycloud;
      const knownBinding = durableBinding || previous?.user.tinycloud;
      if (knownBinding && knownBinding.ownerDid.toLowerCase() !== binding.ownerDid.toLowerCase())
        throw new Error('Changing an existing TinyCloud identity requires an explicit migration.');
      if (knownBinding && (knownBinding.space !== binding.space || knownBinding.prefix !== binding.prefix))
        throw new Error('Changing an existing TinyCloud space requires an explicit migration.');
      if (!binding.ownerPublicKey) throw new Error('A fresh owner signature is required for encrypted storage and recovery.');
      binding = { ...binding, ownerDid: knownBinding?.ownerDid || binding.ownerDid,
        ownerPublicKey: ownerPublicKey(binding, binding.ownerPublicKey),
        minRecordVersion: durableBinding?.minRecordVersion || previous?.user.tinycloud.minRecordVersion };
      const linked = { ...user, tinycloud: binding } as BindingUser;
      const store = timeLimited(await within(resolveStore(binding), callTimeoutMs, 'opening the grant'), callTimeoutMs);
      await store.list('posts/'); // prove the actual grant works, not only its unsigned metadata
      if (!store.getVersioned) throw new Error('TinyCloud conditional writes are required for encryption migration');
      let recovery = await store.get(RECOVERY_KEY);
      if (!recovery) {
        recovery = codec.createRecovery(binding, binding.ownerPublicKey!);
        await store.put(RECOVERY_KEY, recovery, {ifNoneMatch:'*'});
      }
      codec.verifyRecovery(recovery, binding, binding.ownerPublicKey!);
      if (await store.get(RECOVERY_KEY) !== recovery) throw new Error('Owner recovery readback failed');
      let encrypted = 0;
      onStep('encrypting');
      // Migrate the current node contents first, with conditional writes. Partial
      // completion is safe to resume while the durable minimum remains v1.
      for (const kind of ['posts','conversations','summaries'] as Kind[]) {
        await parallel(await store.list(`${kind}/`), async key => {
          due();
          const id = key.slice(kind.length + 1);
          if (key !== `${kind}/${id}` || !validId(id)) throw new Error('Invalid author record path');
          const current = await store.getVersioned!(key);
          if (!current) return; // owner deleted it before we read
          const value = codec.decode(current.value, binding, kind, id, binding.minRecordVersion || 1);
          if (!belongs(value, linked) || ('handle' in value && value.handle && value.handle !== linked.handle)) throw new Error('Author identity mismatch');
          if (JSON.parse(current.value).version === 1) {
            const wire = codec.encode(binding, kind, value);
            await store.put(key, wire, {ifMatch:current.etag});
            if (await store.get(key) !== wire) throw new Error('Encrypted record readback failed');
            progress(`Encrypted and verified ${++encrypted} records`);
          }
        });
      }
      due();
      onStep('finding');
      const records: {kind:Kind;value:RecordValue}[]=[];
      if (!previous) for (const kind of ['posts','conversations','summaries'] as Kind[])
        for(const value of index(kind).values()) if(belongs(value,linked)) records.push({kind,value});
      // Include leftover legacy records on a retry, even after a previous activation
      // hid them from the live index. This makes partial cleanup recoverable.
      const addLegacy = (kind: Kind, value: RecordValue) => {
        if(belongs(value,linked) && !records.some(r=>r.kind===kind&&r.value.id===value.id)) records.push({kind,value});
      };
      if (base.getRecordsOf) {
        // Ask for this account's own records by handle and pseudonym, instead of reading everyone's.
        const own: OwnRecords = await base.getRecordsOf(user.handle,
          [...new Set([binding.pseudonym, user.legacyPseudonym].filter((p): p is string => !!p))]);
        for (const kind of ['posts','conversations','summaries'] as Kind[]) for (const v of own[kind]) addLegacy(kind, v);
      } else {
        await pageAll(base.getEntries.bind(base), v=>addLegacy('posts',v));
        await pageAll(base.getConversations.bind(base), v=>addLegacy('conversations',v));
        if(extra.getSummaries) for(const v of await extra.getSummaries(100000))addLegacy('summaries',v);
      }
      let copied=0;
      onStep('copying');
      await parallel(records, async ({kind,value})=>{
        due();
        const key=`${kind}/${value.id}`;
        const current=await store.get(key);
        if (!current && !previous) {
          const wire=codec.encode(binding,kind,value);
          await store.put(key,wire,{ifNoneMatch:'*'});
          if(await store.get(key)!==wire) throw new Error('TinyCloud readback did not match the original record.');
          encrypted++;
        } else if (current && !previous && canonical(codec.decode(current,binding,kind,value.id)) !== canonical(value)) {
          throw new Error('TinyCloud destination differs from the original record.');
        }
        progress(`Verified ${++copied}/${records.length} records`);
      });
      binding.minRecordVersion = 2; // before the readback, so it accepts only encrypted records
      onStep('reading');
      const state: AuthorState={user:linked,expires:now()+leaseMs,available:true};
      const verified = await readAuthor(state, store);
      due(); // the last point at which the link stops: after this it switches and finishes
      onStep('saving');
      try {
        if (!await base.updateUser(user.handle,{tinycloud:binding})) throw new Error('Could not commit encrypted storage state');
      } catch (err) {
        // The database may have committed despite a lost acknowledgement. Do not
        // reload using a stale v1 floor, or fall back to plaintext legacy writes.
        state.activationPending = true; state.available = false; state.expires = 0;
        authors.set(user.handle,state); evict(linked);
        throw err;
      }
      authors.set(user.handle,state);
      handlesByPseudonym.set(binding.pseudonym,user.handle);
      evict(linked);
      for (const {kind,value} of verified) index(kind).set(value.id,value);
      onStep('cleaning');
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
      return {copied,encrypted,legacyCleanupPending:failed.length};
    });
  }
  return { storage, ready, link, refresh: async (handle:string) => { await init(); const state=authors.get(handle); if(state)await check(state,true); return state?.available??false; },
    status: async (handle:string) => { await init(); const s=authors.get(handle);
      if(s&&!locks.has(handle))await check(s);
      return s ? {linked:true,available:s.available&&s.expires>now(),space:s.user.tinycloud.space,ownerDid:s.user.tinycloud.ownerDid,
        encryption:{version:s.user.tinycloud.minRecordVersion || 1,setupRequired:s.user.tinycloud.minRecordVersion !== 2 || !!s.activationPending}} : {linked:false}; } };
}
