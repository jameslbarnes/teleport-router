/** Published records in each author's own store. Pending records stay in StagedStorage.
 * The in-memory index never falls back to legacy copies for a linked author.
 * A grant check gives a short read lease; failed/expired checks evict that author.
 */
import { tokenize, encodePageCursor, generateEntryId, type Storage, type User,
  type JournalEntry, type Conversation, type Summary, type DailySummary, type OwnRecords } from './storage.js';
import { moveAuthorFolder } from './author-move.js';
import { GroupStoreRevokedError, type GroupStore } from './group-store.js';
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
  networkRecovery?: import('./openkey-recovery.js').NetworkRecovery;
  /** Durable downgrade barrier, committed only after migration readback. */
  minRecordVersion?: 2;
}
export type AuthorStoreResolver = (binding: AuthorBinding) => Promise<GroupStore>;
type RecordValue = JournalEntry | Conversation | Summary;
type NewRecord = Omit<JournalEntry, 'id'> | Omit<Conversation, 'id'> | Omit<Summary, 'id'>;
type Kind = 'posts' | 'conversations' | 'summaries';
type BindingUser = User & { tinycloud: AuthorBinding };
type AuthorState = { user: BindingUser; expires: number; available: boolean; activationPending?: boolean; retryAt?: number; checking?: Promise<void>;
  /** Records were evicted without the account's lock: only a full reload may make it available again. */
  hidden?: boolean;
  /** When the check now running began, so a read knows how long it has already been waited for; and whether
   * that check reads every record or only lists them. */
  checkingSince?: number; reloading?: boolean;
  /** Failed checks and loads in a row, and why the last one failed. Cleared by a load that succeeds. */
  failures?: number; lastError?: string; lastErrorAt?: number;
  /** No check ahead of time before this, after one failed while the lease still stood; how many have failed in a
   * row, and why the last did. */
  renewRetryAt?: number; renewFailures?: number; lastRenewError?: string;
  /** When this account's records were last listed in its storage, and how long that listing check took. */
  listedAt?: number; listMs?: number;
  loadedAt?: number; loadMs?: number };
/** What a moderator sees about one account's storage: whether it is served, and why not. Never record contents. */
export interface AuthorStorageHealth { handle: string; available: boolean; loading: boolean; records: number;
  failures: number; lastError?: string; lastErrorAt?: number; retryAt?: number; loadedAt?: number; loadMs?: number;
  listedAt?: number; listMs?: number; renewFailures: number; lastRenewError?: string }
const order = (a: {timestamp: number; id: string}, b: {timestamp: number; id: string}) => b.timestamp - a.timestamp || b.id.localeCompare(a.id);
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);

/** A step of linking an account to its own storage, reported so the caller can show it and time it. */
export type LinkStep = 'waiting' | 'checking' | 'encrypting' | 'finding' | 'copying' | 'reading' | 'saving' | 'cleaning';
export interface LinkOptions {
  /** Time (ms since the epoch) after which the link stops before switching anything, time spent waiting to start included. */
  deadline?: number;
  /** Validated signatures from the current and incoming owners. */
  migrateFrom?: string;
  /** Longest wait for any one storage read or listing. Writes are never cut short. */
  callTimeoutMs?: number;
  onStep?: (step: LinkStep) => void;
}
/** The link ran out of time, or storage did not answer a read in time. Nothing was switched. */
export class LinkTimeoutError extends Error {}
export const LINK_CALL_TIMEOUT_MS = 60_000;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LinkTimeoutError(`Storage did not answer ${what} within ${Math.round(ms / 1000)} s.`)), ms);
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/** The same store, with no read or listing waiting longer than `ms`. Writes are left to finish: a write
 * given up on while still in flight could land after a retry and after the owner deleted that record,
 * which a conditional write does not prevent. */
function readsWithin(store: GroupStore, ms: number): GroupStore {
  const limited: GroupStore = {
    put: (key, value, condition) => store.put(key, value, condition),
    get: key => within(store.get(key), ms, 'a read'),
    list: path => within(store.list(path), ms, 'a listing'),
    delete: key => store.delete(key),
  };
  if (store.getVersioned) limited.getVersioned = key => within(store.getVersioned!(key), ms, 'a read');
  return limited;
}

const pause = (ms: number) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.(); });

/** The step a check or load failed in, kept beside the error and not in it, so errors reach their callers unchanged. */
const failedDuring = new WeakMap<object, string>();
function during(step: string, err: unknown) {
  if (err && typeof err === 'object' && !failedDuring.has(err)) failedDuring.set(err, step);
  return err;
}
/** What this file and the record codec say themselves when they refuse a record. */
const OWN_REASONS = new Set(['Invalid author record path', 'Author identity mismatch', 'Author record ID collision',
  'Owner recovery is missing', 'Author storage keys are unavailable', 'Author record integrity check failed',
  'Invalid encrypted record encoding', 'Invalid encrypted record size', 'Invalid author record',
  'Recovery public key does not match the TinyCloud owner', 'Owner recovery self-check failed',
  'Owner recovery context mismatch', 'Expected an encrypted author record',
  'Unsupported state or unable to authenticate data']);
/** Why a check or load failed, for the log and for moderators. An error from storage or from parsing a record can
 * quote what it was reading, so its text is never repeated: only the step, this code's own fixed messages, the kind
 * of error, and a status or error code. */
function reason(err: unknown): string {
  const step = (err && typeof err === 'object' && failedDuring.get(err)) || 'the check';
  if (err instanceof LinkTimeoutError) return `storage did not answer ${step} in time`;
  if (err instanceof GroupStoreRevokedError) return `${step}: the grant was revoked or has expired`;
  const message = err instanceof Error ? err.message : '';
  if (OWN_REASONS.has(message)) return `${step}: ${message}`;
  // Every part below comes from a fixed list. An error's own name, code and text are compared, never copied.
  const parts = [err instanceof SyntaxError ? 'SyntaxError' : err instanceof TypeError ? 'TypeError'
    : err instanceof RangeError ? 'RangeError' : err instanceof Error ? 'Error' : 'not an Error'];
  if (step !== 'checking a record' && step !== 'checking owner recovery') {
    const codes = [(err as { code?: unknown } | null)?.code, (err as { cause?: { code?: unknown } } | null)?.cause?.code,
      message.match(/^TinyCloud \w+ failed: (\w+)/)?.[1]].filter((c): c is string => typeof c === 'string' && c !== 'error');
    const code = codes.find(c => KNOWN_CODES.has(c));
    if (code) parts.push(code); else if (codes.length) parts.push('another code');
    const status = message.match(/\b[45]\d\d\b/)?.[0];
    if (status && KNOWN_STATUSES.has(status)) parts.push(`status ${status}`);
  }
  return `${step} failed (${parts.join(', ')})`;
}
const KNOWN_STATUSES = new Set(['400', '401', '403', '404', '408', '409', '412', '413', '429', '500', '502', '503', '504']);
/** Network error codes from Node, and the storage library's own. */
const KNOWN_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'ABORT_ERR',
  'INVALID_INPUT', 'STORAGE_ERROR', 'RESPONSE_BINDING_MISMATCH', 'VAULT_LOCKED', 'REPLICA_GATED', 'VALIDATION_ERROR',
  'INVALID_NETWORK_ID', 'INVALID_ENVELOPE', 'KEY_NOT_FOUND', 'INVALID_RESPONSE', 'TRANSPORT_ERROR', 'DECRYPTION_FAILED',
  'OUTCOME_UNKNOWN', 'NETWORK_NOT_FOUND', 'INVALID_ETAG', 'PUBLIC_KEY_NOT_FOUND', 'RESPONSE_SIGNATURE_INVALID', 'ABORTED',
  'CONSENT_EXPIRED', 'SESSION_SCOPE_MISMATCH', 'NETWORK_NOT_ACTIVE', 'TIMEOUT', 'STATUS_TIMEOUT', 'DECRYPT_DENIED',
  'REPLICA_CLOSED', 'KV_CONFLICT']);

/** Stops handing out items once one has failed: the caller fails either way, and the rest would be wasted reads. */
async function parallel<T>(items: T[], fn: (item: T) => Promise<void>, concurrency = 8) {
  let next = 0, stopped = false;
  const results = await Promise.allSettled(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !stopped) {
      try { await fn(items[next++]); } catch (err) { stopped = true; throw err; }
    }
  }));
  const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (failure) throw failure.reason;
}

export interface AuthorStorageOptions {
  /** How long an account's records are served after its grant was last checked. */
  leaseMs?: number;
  now?: () => number;
  /** Longest a read waits for an account that is being loaded. Nothing of that account is served meanwhile. */
  readerWaitMs?: number;
  /** Longest a read waits for an account whose lease ran out to be checked again, before it stops serving that account. */
  leaseWaitMs?: number;
  /** Longest wait for one storage read or listing during a check or a load. */
  readTimeoutMs?: number;
  /** Tries for one storage read or listing during a check or a load, and the pause before the second. */
  readAttempts?: number; readRetryMs?: number;
  /** Wait after a first failed check or load. It doubles with each further failure, up to `maxRetryMs`. */
  retryMs?: number; maxRetryMs?: number;
  log?: (message: string) => void;
}

export function authorStorage(base: Storage, resolveStore: AuthorStoreResolver | null,
  codec: ReturnType<typeof recordCodec> | null, { leaseMs = 60000, now = Date.now, readerWaitMs = 2000, leaseWaitMs = 15000,
    readTimeoutMs = 30000, readAttempts = 3, readRetryMs = 250, retryMs = 10000, maxRetryMs = 300000,
    log = (message: string) => console.error(message) }: AuthorStorageOptions = {}) {
  const extra = base as Storage & Record<string, any>;
  const entries = new Map<string, JournalEntry>();
  const conversations = new Map<string, Conversation>();
  const summaries = new Map<string, Summary>();
  const daily = new Map<string, DailySummary>();
  const authors = new Map<string, AuthorState>();
  const handlesByPseudonym = new Map<string, string>();
  const locks = new Map<string, Promise<unknown>>();
  /** Accounts with a link running, which holds the account for as long as it runs. */
  const linking = new Map<string, number>();
  let initializing: Promise<void> | undefined;
  const index = (kind: Kind): Map<string, any> => kind === 'posts' ? entries : kind === 'conversations' ? conversations : summaries;
  const ownerOf = (value: {handle?: string; pseudonym: string}) => value.handle && authors.has(value.handle)
    ? value.handle : [...authors].find(([, s]) => belongs(value, s.user))?.[0];
  const belongs = (value: {handle?: string; pseudonym: string}, user: BindingUser) =>
    value.handle === user.handle || value.pseudonym === user.tinycloud.pseudonym
    || (!!user.legacyPseudonym && value.pseudonym === user.legacyPseudonym);
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
  /** One storage read or listing for a check or a load: it never waits longer than `readTimeoutMs`, and a failure is
   * tried again before the account is given up on. Loading an account takes one read per record, so a load that
   * failed whenever any single read did would stop succeeding once the account grew large enough. */
  async function attempt<T>(what: string, read: () => Promise<T>): Promise<T> {
    for (let tries = 1; ; tries++) {
      try { return await within(read(), readTimeoutMs, what); }
      // Storage saying the grant is revoked is an answer, not a failed read: it is not asked again.
      catch (err) { if (tries >= readAttempts || err instanceof GroupStoreRevokedError) throw during(what, err); await pause(readRetryMs * tries); }
    }
  }
  /** After a failed check or load: stop serving the account, say why, and wait longer before each further try.
   * Without the wait, every read and every waiting post would start another full load of an account that cannot load. */
  function failed(state: AuthorState, err: unknown) {
    state.available = false;
    state.expires = 0;
    state.failures = (state.failures || 0) + 1;
    const wait = Math.min(maxRetryMs, Math.min(retryMs, leaseMs) * 2 ** Math.min(state.failures - 1, 10));
    state.retryAt = now() + wait;
    state.lastError = reason(err);
    state.lastErrorAt = now();
    evict(state.user);
    log(`[AuthorStore] @${state.user.handle} is not being served: try ${state.failures} failed (${state.lastError}); next try in ${Math.round(wait / 1000)} s`);
  }
  /** What a waiting post is told. The storage error itself is not passed on: it can quote what it was reading. */
  const unreadable = (state: AuthorState) =>
    new Error(`@${state.user.handle}'s storage could not be read (${state.lastError || 'unknown'}). The post stays waiting and is tried again.`);
  /** Stop serving an account without its lock, as a failed check would. Only a full reload makes it available again. */
  function hide(state: AuthorState) { state.available = false; state.expires = 0; state.hidden = true; evict(state.user); }
  async function readAuthor(state: AuthorState, opened?: GroupStore) {
    if (!codec || !resolveStore) throw new Error('Author storage keys are unavailable');
    const binding = state.user.tinycloud;
    const store = opened || await attempt('opening the grant', () => resolveStore(binding));
    const loaded: { kind: Kind; value: RecordValue }[] = [];
    for (const kind of ['posts', 'conversations', 'summaries'] as Kind[]) {
      const keys = await attempt('a listing', () => store.list(`${kind}/`));
      await parallel(keys, async key => {
        const id = key.slice(kind.length + 1);
        if (key !== `${kind}/${id}` || !validId(id)) throw new Error('Invalid author record path');
        const raw = await attempt('a read', () => store.get(key));
        if (raw === null) return;
        try {
          const value = codec.decode(raw, binding, kind, id, binding.minRecordVersion || 1);
          if (!belongs(value, state.user) || ('handle' in value && value.handle && value.handle !== state.user.handle))
            throw new Error('Author identity mismatch');
          const existing = index(kind).get(id);
          if (existing && !belongs(existing, state.user)) throw new Error('Author record ID collision');
          loaded.push({ kind, value });
        } catch (err) { throw during('checking a record', err); }
      });
    }
    return loaded;
  }
  async function loadAuthor(state: AuthorState) {
    if (!codec || !resolveStore) throw new Error('Author storage keys are unavailable');
    const binding = state.user.tinycloud;
    const began = Date.now(), listed = now();
    if (binding.minRecordVersion === 2) {
      const recovery = await attempt('a read', async () => (await resolveStore(binding)).get(RECOVERY_KEY));
      try {
        if (!recovery || !binding.ownerPublicKey) throw new Error('Owner recovery is missing');
        codec.verifyRecovery(recovery, binding, binding.ownerPublicKey);
      } catch (err) { throw during('checking owner recovery', err); }
    }
    const loaded = await readAuthor(state);
    evict(state.user);
    for (const { kind, value } of loaded) index(kind).set(value.id, value);
    state.available = true;
    state.hidden = false;
    state.expires = now() + leaseMs;
    state.failures = 0;
    delete state.lastError; delete state.lastErrorAt; delete state.retryAt; delete state.renewRetryAt;
    state.renewFailures = 0; delete state.lastRenewError;
    // The listings were taken as the load began. A long load is followed by a fresh listing check ahead of time.
    state.listedAt = listed;
    state.loadedAt = now();
    state.loadMs = Date.now() - began;
  }
  /** `early` checks an account that is still inside its lease, once half a lease has passed since its records were
   * last listed. Reads then rarely find the lease run out, and what the owner deleted in their own storage stops
   * being served even while new posts keep the lease going. */
  async function check(state: AuthorState, reload = false, early = false) {
    if (!resolveStore || !codec) return; // Locked authors stay out of every published index.
    if (state.activationPending) return; // uncertain metadata commit: only a verified re-link can resume
    const leased = () => state.available && (early
      ? state.expires - now() > leaseMs / 2 && now() - (state.listedAt ?? 0) < leaseMs / 2 : state.expires > now());
    const waiting = () => !state.available && (state.retryAt || 0) > now();
    if (!reload && (leased() || waiting())) return;
    if (early && (state.renewRetryAt || 0) > now()) return;
    // A link holds this account until it ends, and every read would wait for it here. Instead, stop serving this
    // account's records once their lease has run out, as a failed check would, and let everyone else's reads go on.
    // The link loads them again when it switches; if it fails, the next check after it does.
    if (!reload && linking.has(state.user.handle)) {
      if (state.available && !early) hide(state);
      return;
    }
    if (state.checking) {
      if (!reload || state.reloading) return state.checking;
      // A forced reload reads every record again. A listing check already running does not stand in for it.
      await state.checking;
      return check(state, true);
    }
    const started = now();
    state.checkingSince = started;
    state.reloading = reload || !state.available;
    state.checking = exclusive(state.user.handle, async () => {
      // A link that ran first replaced this account's storage: its old records must not be loaded over the new ones.
      if (authors.get(state.user.handle) !== state) return;
      // A post published while this check waited for the account may have loaded it, or failed to.
      if (!reload && (leased() || waiting())) return;
      const began = Date.now();
      try {
        if (reload || !state.available) await loadAuthor(state);
        else {
          const store = await attempt('opening the grant', () => resolveStore(state.user.tinycloud));
          // Listing verifies the current grant and lets owner-side deletions take effect.
          const keys = new Set(await attempt('a listing', () => store.list('posts/')));
          const others = new Map<Kind, Set<string>>();
          for (const kind of ['conversations', 'summaries'] as Kind[]) others.set(kind, new Set(await attempt('a listing', () => store.list(`${kind}/`))));
          // A read gave up waiting for this check and stopped serving the account: only a full reload brings it back.
          if (!state.available) return;
          for (const [id, e] of entries) if (belongs(e, state.user) && !keys.has(`posts/${id}`)) entries.delete(id);
          for (const [kind, kept] of others)
            for (const [id, value] of index(kind)) if (belongs(value, state.user) && !kept.has(`${kind}/${id}`)) index(kind).delete(id);
          state.expires = started + leaseMs;
          state.listedAt = started;
          state.listMs = Date.now() - began;
          state.renewFailures = 0; delete state.lastRenewError;
        }
      } catch (err) {
        // Checking ahead of time: unless storage said the grant is revoked, the lease still stands, so keep serving.
        // The check at its end decides.
        if (early && !reload && !(err instanceof GroupStoreRevokedError) && state.available && state.expires > now()) {
          state.renewRetryAt = now() + leaseMs / 8;
          state.renewFailures = (state.renewFailures || 0) + 1;
          state.lastRenewError = reason(err);
          return;
        }
        failed(state, err);
      }
    }).finally(() => { delete state.checking; delete state.checkingSince; delete state.reloading; });
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
      // Each account loads on its own from here. A read waits a moment for them (see `ready`) and then serves what
      // has loaded, so one large or failing account does not hold back everyone's reads after a restart.
      for (const s of authors.values()) void check(s, true).catch(() => {});
    })().catch(err => { initializing = undefined; entries.clear(); conversations.clear(); summaries.clear(); daily.clear(); throw err; });
    await initializing;
  }
  /** Returns when the index holds everything a read may serve.
   *
   * An account inside its lease is served at once, and renewed ahead of time in the background. An account that is
   * not available has nothing in the index, so a read waits only `readerWaitMs` from the start of its load, which
   * keeps a quick load invisible, and then serves everyone else. An account whose lease has run out must be checked
   * before anything of it is served: a read waits up to `leaseWaitMs` for that, then stops serving the account.
   *
   * `wait: 'all'` waits for every check to finish. Use it before changing a record, which must not be missed
   * because its account was still loading.
   *
   * Whatever was waited for, nothing past its lease is left in the index when this returns. The caller reads the
   * index at once, without waiting again. */
  async function ready(wait: 'reads' | 'all' = 'reads') {
    await init();
    const settle = async (state: AuthorState) => {
      if (state.available && state.expires > now()) { void check(state, false, true).catch(() => {}); return; }
      const lapsed = state.available;
      const pending = check(state);
      if (wait === 'all') return pending;
      const left = (lapsed ? leaseWaitMs : readerWaitMs) - (now() - (state.checkingSince ?? now()));
      if (left > 0) await Promise.race([pending, pause(left)]);
    };
    await Promise.all([...authors.values()].map(settle));
    // While this read waited for one account, the lease of another may have run out. Those get one wait of their own.
    const lapsed = [...authors.values()].filter(s => s.available && s.expires <= now());
    if (lapsed.length) await Promise.all(lapsed.map(settle));
    for (const state of authors.values()) if (state.available && state.expires <= now()) hide(state);
  }
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
    if (!codec || !resolveStore) throw new Error('Author storage keys are unavailable');
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
        if (!state.available) {
          // One failed load is enough. The other posts waiting for this account do not each load all of it again.
          if ((state.retryAt || 0) > now()) throw unreadable(state);
          try { await loadAuthor(state); } catch (err) { failed(state, err); throw unreadable(state); }
        }
        const store = await resolveStore(state.user.tinycloud);
        saved = { ...value, id: (value as RecordValue).id || generateEntryId(), keywords: tokenize(value.content) } as RecordValue;
        await store.put(`${kind}/${saved.id}`, codec.encode(state.user.tinycloud, kind, saved));
        // Reads stopped serving this account while the write ran: the next check reloads all of it, this record included.
        if (state.hidden) return saved;
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
    if (!codec || !resolveStore) throw new Error('Author storage keys are unavailable');
    await ready('all');
    // A read may have stopped serving an account while its check ran. Load it again before taking the record as gone.
    if (!index(kind).has(id) && [...authors.values()].some(s => s.hidden && !s.available && !s.activationPending
      && !linking.has(s.user.handle) && (s.retryAt || 0) <= now())) await ready('all');
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
    { deadline = Infinity, callTimeoutMs = LINK_CALL_TIMEOUT_MS, onStep = () => {}, migrateFrom }: LinkOptions = {}) {
    const due = () => { if (now() > deadline) throw new LinkTimeoutError('The link ran out of time before switching storage.'); };
    onStep('waiting');
    linking.set(user.handle, (linking.get(user.handle) || 0) + 1);
    try {
      await init();
      handlesByPseudonym.set(binding.pseudonym,user.handle);
      // One link at a time per storage identity, so two accounts cannot both claim it, and per account.
      // Links for other accounts and other storage run alongside.
      return await exclusive(`did:${binding.ownerDid.toLowerCase()}`, () => exclusive(`assets:${binding.pseudonym}`,
        () => linkAccount(user, binding, progress, due, callTimeoutMs, onStep, migrateFrom)));
    } finally {
      const left = (linking.get(user.handle) || 1) - 1;
      if (left) linking.set(user.handle, left); else linking.delete(user.handle);
    }
  }
  function linkAccount(user: User, binding: AuthorBinding, progress: (message: string) => void, due: () => void,
    callTimeoutMs: number, onStep: (step: LinkStep) => void, migrateFrom?: string) {
    return exclusive(user.handle, async () => {
      if (!resolveStore || !codec) throw new Error('Author storage keys are unavailable');
      due();
      onStep('checking');
      const all = await base.getAllUsers();
      if (all.some(u=>u.handle!==user.handle&&u.tinycloud?.ownerDid.toLowerCase()===binding.ownerDid.toLowerCase()))
        throw new Error('This TinyCloud identity is already linked to another Router account.');
      const previous = authors.get(user.handle);
      const durableBinding = all.find(u=>u.handle===user.handle)?.tinycloud;
      const knownBinding = durableBinding || previous?.user.tinycloud;
      const moving = !!migrateFrom && knownBinding?.ownerDid === migrateFrom && migrateFrom.toLowerCase() !== binding.ownerDid.toLowerCase();
      if (migrateFrom && !moving) throw new Error('The current storage owner changed. Start the move again.');
      if (!moving && knownBinding && knownBinding.ownerDid.toLowerCase() !== binding.ownerDid.toLowerCase())
        throw new Error('Changing an existing TinyCloud identity requires an explicit migration.');
      if (!moving && knownBinding && (knownBinding.space !== binding.space || knownBinding.prefix !== binding.prefix))
        throw new Error('Changing an existing TinyCloud space requires an explicit migration.');
      if (!moving && knownBinding && canonical(knownBinding.networkRecovery) !== canonical(binding.networkRecovery)) throw new Error('Renew using the same recovery record.');
      if (!binding.ownerPublicKey) throw new Error('A fresh owner signature is required for encrypted storage and recovery.');
      binding = { ...binding, ownerDid: moving ? binding.ownerDid : knownBinding?.ownerDid || binding.ownerDid,
        ownerPublicKey: ownerPublicKey(binding, binding.ownerPublicKey),
        minRecordVersion: durableBinding?.minRecordVersion || previous?.user.tinycloud.minRecordVersion };
      const linked = { ...user, tinycloud: binding } as BindingUser;
      const store = readsWithin(await within(resolveStore(binding), callTimeoutMs, 'opening the grant'), callTimeoutMs);
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
      const verifyMove = moving && knownBinding ? await moveAuthorFolder(
        readsWithin(await within(resolveStore(knownBinding), callTimeoutMs, 'opening the current owner grant'), callTimeoutMs), store,
        knownBinding, binding, codec, value => belongs(value, linked) && (!('handle' in value) || !value.handle || value.handle === user.handle), due) : undefined;
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
      await verifyMove?.();
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
        // The account has switched by now: a failure here is cleanup left to a retry, not a failed link.
        let days: DailySummary[] = [];
        try { days = await extra.getDailySummaries(100000); } catch { failed.push('daily'); }
        for(const s of days) if(s.pseudonyms.some((p:string)=>belongs({pseudonym:p},linked))) {
          try { await extra.deleteDailySummary(s.date); } catch { failed.push(`daily/${s.date}`); }
        }
      }
      return {copied,encrypted,legacyCleanupPending:failed.length};
    });
  }
  async function assetStore(binding: AuthorBinding): Promise<GroupStore> {
    if (!resolveStore || !codec) throw new Error('Author storage keys are unavailable');
    await init();
    const raw = await resolveStore(binding);
    const write = (fn: () => Promise<void>) => exclusive(`assets:${binding.pseudonym}`, async () => {
      const current = authors.get(handlesByPseudonym.get(binding.pseudonym) || '')?.user.tinycloud;
      if (!current || current.ownerDid !== binding.ownerDid || current.space !== binding.space) throw new Error('Storage ownership changed. Refresh the account.');
      await fn();
    });
    return { ...raw, put: (k, v, condition) => write(() => raw.put(k, v, condition)), delete: k => write(() => raw.delete(k)) };
  }
  /** For moderators: which accounts are served, and why any is not. Handles and reasons only. */
  function health(): AuthorStorageHealth[] {
    return [...authors.values()].map(s => ({ handle: s.user.handle, available: s.available && s.expires > now(),
      loading: !!s.checking && !s.available, failures: s.failures || 0,
      records: [entries, conversations, summaries].reduce((n, map) => { for (const v of map.values()) if (belongs(v, s.user)) n++; return n; }, 0),
      lastError: s.lastError, lastErrorAt: s.lastErrorAt, retryAt: s.available ? undefined : s.retryAt, loadedAt: s.loadedAt, loadMs: s.loadMs,
      listedAt: s.listedAt, listMs: s.listMs, renewFailures: s.renewFailures || 0, lastRenewError: s.lastRenewError }));
  }
  /** Whether any account is being loaded, so its records are not in the index yet. */
  const loading = () => [...authors.values()].some(s => !!s.checking && !s.available);
  return { storage, ready, health, loading, link, assetStore,
    // The account's state may be replaced by a link while this waits: report the state that is current afterwards.
    refresh: async (handle:string) => { await init(); const state=authors.get(handle); if(state)await check(state,true);
      const current=authors.get(handle); return !!current && current.available && current.expires > now(); },
    status: async (handle:string) => { await init(); const s=authors.get(handle);
      if(s&&!locks.has(handle))await check(s);
      return s ? {linked:true,available:s.available&&s.expires>now(),space:s.user.tinycloud.space,ownerDid:s.user.tinycloud.ownerDid,
        recoveryMode:s.user.tinycloud.networkRecovery ? 'openkey' : 'self-held',
        encryption:{version:s.user.tinycloud.minRecordVersion || 1,setupRequired:s.user.tinycloud.minRecordVersion !== 2 || !!s.activationPending}} : {linked:false}; } };
}
