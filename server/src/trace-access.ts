import { createHash, randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { computeAddress, SigningKey } from 'ethers';
import { tracePointer } from './trace-pointer.js';
import type { JournalEntry, User } from './storage.js';
import type { KeyWrap } from './trace-envelope.js';
import { APP_LIMITS, appHash, checkApp, checkAppParses, TraceAppError } from './trace-app.js';
import { RUN_GRANT_MS, RUN_PREPARE_MS, RunError, checkRunDescription, type RunBundle, type RunDescription, type SealedAnswer } from './trace-run.js';

export const TRACE_GRANT_MS = 24 * 3600_000;
export const traceFolder = (entryId: string) => `router/traces/${entryId}/`;
export const readerDid = (key: string) => 'did:pkh:eip155:1:' + computeAddress(key);
interface Actor { pseudonym: string; keyHash: string; user: User | null }
interface Approval { delegation: string; wrap: KeyWrap; expires: number; ownerDid: string; host: string }
interface AppRecord { runtime: string; code: string; purpose: string; hash: string }
interface RunRecord { id: string; description: RunDescription; publicKey: string; preparedAt: number }
/** Sealed to the owner by the runner and signed by the run's key. Router cannot open it. */
interface AnswerRecord { runId: string; description: RunDescription; sealed: SealedAnswer; signature: string; runPublicKey: string; at: number }
/** Sealed to the requester by the owner's side. Its receipt is the sealed answer's own hash; Router never holds a hash of the plain answer. */
interface ReleaseRecord { runId: string; description: RunDescription; sealed: SealedAnswer; at: number }
type State = 'pending' | 'declined' | 'approved' | 'answered' | 'released' | 'withheld' | 'withdrawn';
interface Request {
  id: string; revision: string; entryId: string; owner: string; requester: string; requesterName: string;
  /** The requester's key: before apps, the trace reader's; with an app, the key the answer is sealed to. */
  publicKey: string; created: number; state: State; approval?: Approval;
  app?: AppRecord; run?: RunRecord; answer?: AnswerRecord; released?: ReleaseRecord;
  /** The run whose key has been handed its grant. Only that run's result may be saved, and only to this revision. */
  running?: { runId: string; since: number };
}
export class TraceRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const missing = () => new TraceRequestError('Request or note not found.', 404);
const identities = (actor: Actor) => [actor.pseudonym, ...(actor.user ? ['@' + actor.user.handle] : [])];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
function checkedKey(key: unknown, purpose = 'Give the compressed public key of the agent that will read the trace.') {
  if (typeof key !== 'string' || !/^0x(?:02|03)[0-9a-fA-F]{64}$/.test(key)) throw new TraceRequestError(purpose);
  try { return SigningKey.computePublicKey(key, true); } catch { throw new TraceRequestError('Invalid public key.'); }
}
function checkedWrap(value: any): KeyWrap {
  const field = (v: unknown, n: number) => typeof v === 'string' && Buffer.from(v, 'base64url').length === n && Buffer.from(v, 'base64url').toString('base64url') === v;
  if (!value || !field(value.nonce, 12) || !field(value.tag, 16) || !field(value.ciphertext, 32)) throw new TraceRequestError('Invalid reader key envelope.');
  return { ephemeralPublicKey: checkedKey(value.ephemeralPublicKey), nonce: value.nonce, tag: value.tag, ciphertext: value.ciphertext };
}
/** Shape of an answer the owner's side sealed to the requester. Router cannot check its contents; it checks the ciphertext against the sealed answer's own hash. */
function checkedRelease(value: any): SealedAnswer {
  const b64 = (v: unknown, n: number) => typeof v === 'string' && Buffer.from(v, 'base64url').length === n && Buffer.from(v, 'base64url').toString('base64url') === v;
  const m = value?.meta;
  if (!m || !b64(m.nonce, 12) || !b64(m.tag, 16) || !/^[a-f0-9]{64}$/.test(m.sha256 || '') || !Number.isInteger(m.bytes) || m.bytes < 1
    || m.bytes > APP_LIMITS.answerBytes + 64 || typeof value.data !== 'string' || value.data.length > 2 * APP_LIMITS.answerBytes
    || !m.wraps || Object.keys(m.wraps).join() !== 'reader') throw new TraceRequestError('The released answer must be sealed to the requester alone.');
  return { meta: { nonce: m.nonce, tag: m.tag, sha256: m.sha256, bytes: m.bytes, wraps: { reader: checkedWrap(m.wraps.reader) } }, data: value.data };
}

/** One document per requester and post. Retrying an ask never creates a second inbox item. */
export function traceRequestStore(db?: Firestore) {
  const memory = new Map<string, Request>();
  const collection = db?.collection('traceAccessRequests');
  return {
    async get(id: string): Promise<Request | undefined> {
      return collection ? (await collection.doc(id).get()).data() as Request | undefined : memory.get(id);
    },
    /** Requests waiting on the owner: not yet run, or run and waiting for release. */
    async pending(owner: string): Promise<Request[]> {
      const states: State[] = ['pending', 'answered'];
      if (!collection) return [...memory.values()].filter(r => r.owner === owner && states.includes(r.state));
      const snapshots = await Promise.all(states.map(state => collection.where('owner', '==', owner).where('state', '==', state).get()));
      return snapshots.flatMap(s => s.docs.map(doc => doc.data() as Request));
    },
    async change(id: string, update: (current?: Request) => Request): Promise<Request> {
      if (!db || !collection) { const next = update(memory.get(id)); memory.set(id, next); return next; }
      const ref = collection.doc(id);
      return db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data() as Request | undefined;
        const next = update(current);
        // The JSON round trip drops fields set to undefined (a cleared run), which Firestore would refuse.
        if (next !== current) tx.set(ref, JSON.parse(JSON.stringify(next)));
        return next;
      });
    },
  };
}

/** The trace runner as Router sees it: in an enclave, reached over an authenticated link (or in-process in local tests). */
export interface TraceRunnerClient {
  prepare(input: { description: RunDescription; code: string; nonce: string }): Promise<{
    run_id: string; public_key: string; bundle: RunBundle; runner: { appId: string; name: string; codeHash: string };
  }>;
  run(input: { run_id: string; delegation: string; wrap: KeyWrap; host: string }): Promise<{ run_id: string; sealed: SealedAnswer; signature: string }>;
}
/** What Router knows about the stored trace: its owner, the hash of its ciphertext and the owner's public key. */
export type TraceInfo = (owner: User, entryId: string) => Promise<{ ownerDid: string; ciphertextSha256: string; ownerPublicKey: string } | null>;

interface Dependencies {
  store: ReturnType<typeof traceRequestStore>;
  visible: (entryId: string, actor: Actor) => Promise<JournalEntry | null>;
  getUser: (keyHash: string) => Promise<User | null>;
  host: string;
  runner?: TraceRunnerClient;
  traceInfo?: TraceInfo;
  /** Called once for each new request, and again when the requester replaces the app before the owner runs it. */
  onRequest?: (request: { id: string; owner: string; entryId: string; requesterName: string; purpose: string }) => void;
  now?: () => number;
}
export function traceAccess({ store, visible, getUser, host, runner, traceInfo, onRequest, now = Date.now }: Dependencies) {
  const isOwner = (r: Request, actor: Actor) => identities(actor).includes(r.owner);
  /** What the requester sees before release: no timing or failure detail. */
  const requesterState = (r: Request): string => {
    if (r.state === 'answered') return 'pending';
    if (r.state === 'withheld') return 'declined';
    if (r.approval && r.approval.expires <= now()) return 'expired';
    return r.state;
  };
  function view(r: Request, who: 'owner' | 'requester') {
    const base = {
      request_id: r.id, revision: r.revision, entry_id: r.entryId, trace_url: tracePointer(r.entryId),
      owner: r.owner, requester: r.requesterName, requested_at: r.created,
    };
    if (!r.app) {
      return { ...base, reader_public_key: r.publicKey, reader_did: readerDid(r.publicKey),
        state: r.approval && r.approval.expires <= now() ? 'expired' : r.state,
        ...(r.approval ? { expires_at: r.approval.expires } : {}),
        ...(who === 'requester' && r.approval && r.approval.expires > now() ? { grant: r.approval } : {}) };
    }
    const app = { purpose: r.app.purpose, code: r.app.code, hash: r.app.hash, runtime: r.app.runtime };
    if (who === 'requester') {
      return { ...base, app, answer_public_key: r.publicKey, state: requesterState(r),
        ...(r.state === 'released' && r.released ? { answer: r.released.sealed, sealed_sha256: r.released.sealed.meta.sha256, run: r.released.description, released_at: r.released.at } : {}) };
    }
    return { ...base, app, answer_public_key: r.publicKey, state: r.state,
      ...(r.run ? { run: { run_id: r.run.id, description: r.run.description, public_key: r.run.publicKey, prepared_at: r.run.preparedAt } } : {}),
      ...(r.answer ? { answer: { run_id: r.answer.runId, description: r.answer.description, sealed: r.answer.sealed, signature: r.answer.signature, run_public_key: r.answer.runPublicKey, at: r.answer.at } } : {}),
      ...(r.released ? { released: { run_id: r.released.runId, sealed_sha256: r.released.sealed.meta.sha256, at: r.released.at } } : {}) };
  }
  const requester = async (r: Request) => ({ keyHash: r.requester, user: await getUser(r.requester), pseudonym: r.requesterName });
  /** Only the runner's own errors, which are fixed sentences, are shown; anything else becomes one fixed message.
   *  App errors never come this way: they are sealed to the owner. */
  const runnerFailed = (err: unknown): never => {
    throw new TraceRequestError(err instanceof RunError ? err.message : 'The run failed.', 502);
  };
  const revised = (r: Request, input: Record<string, unknown>) => {
    if (r.revision !== input.revision) throw new TraceRequestError('This request changed. Review it again.', 409);
  };

  async function request(actor: Actor, input: Record<string, unknown>) {
    if (!validId(input.entry_id)) throw missing();
    const entry = await visible(input.entry_id, actor);
    if (!entry) throw missing();
    const owner = entry.handle ? '@' + entry.handle : entry.pseudonym;
    if (identities(actor).includes(owner)) throw new TraceRequestError('This is your own trace.');
    if (input.app === undefined) throw new TraceRequestError('A trace request must carry an app: {code, purpose}, with answer_public_key. The code defines function analyze(trace, info), which returns a short string; the owner reads the code, runs it in Router\'s enclave and decides whether to release its answer to you.');
    const app = await (async () => {
      try { const checked = checkApp(input.app); await checkAppParses(checked.code); return checked; }
      catch (err) { throw new TraceRequestError(err instanceof TraceAppError ? err.message : 'Invalid app.'); }
    })();
    const publicKey = checkedKey(input.answer_public_key, 'Give answer_public_key: the compressed secp256k1 public key the answer should be sealed to. Keep its private key on the requester\'s device.');
    const hash = appHash(app);
    const id = createHash('sha256').update(JSON.stringify([entry.id, owner, actor.keyHash])).digest('hex');
    let fresh = false;
    const result = await store.change(id, current => {
      // While a request waits on its owner, asking again gets the same answer whether or not the app has run,
      // so the requester cannot learn when it ran.
      if (current?.app && (current.state === 'pending' || current.state === 'answered')) {
        if (current.app.hash === hash && current.publicKey === publicKey) return current;
        throw new TraceRequestError('A request from you for this note is already waiting on its owner. Withdraw it first to send a different app.', 409);
      }
      fresh = true;
      return { id, revision: randomUUID(), entryId: entry.id, owner, requester: actor.keyHash, requesterName: identities(actor).at(-1)!,
        publicKey, created: now(), state: 'pending', app: { ...app, hash } };
    });
    if (fresh) try { onRequest?.({ id, owner, entryId: entry.id, requesterName: result.requesterName, purpose: app.purpose }); } catch { /* an alert never blocks the request */ }
    return view(result, 'requester');
  }

  async function prepare(actor: Actor, r: Request, input: Record<string, unknown>) {
    if (!r.app) throw new TraceRequestError('This request was made before apps were required. Decline it; the requester can ask again with an app.', 409);
    if (!runner || !traceInfo) throw new TraceRequestError('Trace apps cannot run on this server yet.', 503);
    if (r.state !== 'pending' && r.state !== 'answered') throw new TraceRequestError('This request has already been answered.', 409);
    revised(r, input);
    if (typeof input.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(input.nonce)) throw new TraceRequestError('Give a fresh nonce: 64 lowercase hex characters.');
    if (!await visible(r.entryId, await requester(r))) throw new TraceRequestError('The requester can no longer see this post.', 409);
    if (!actor.user?.tinycloud) throw new TraceRequestError('Link your TinyCloud storage first.');
    const trace = await traceInfo(actor.user, r.entryId);
    if (!trace) throw new TraceRequestError('No trace is stored for this note.', 409);
    const description = checkRunDescription({
      v: 1, request_id: r.id, revision: r.revision, requester: r.requesterName, owner_did: trace.ownerDid, entry_id: r.entryId, part: 'full',
      ciphertext_sha256: trace.ciphertextSha256, app_hash: r.app.hash, run_id: randomUUID(), expires_at: now() + RUN_PREPARE_MS,
      answer_bytes: APP_LIMITS.answerBytes, owner_public_key: trace.ownerPublicKey, answer_key: r.publicKey,
    });
    const prepared = await runner.prepare({ description, code: r.app.code, nonce: input.nonce }).catch(runnerFailed);
    if (prepared.run_id !== description.run_id) throw new TraceRequestError('The runner prepared a different run.', 502);
    const saved = await store.change(r.id, current => {
      if (!current) throw missing();
      revised(current, input);
      if (current.state !== 'pending' && current.state !== 'answered') throw new TraceRequestError('This request has already been answered.', 409);
      return { ...current, run: { id: description.run_id, description, publicKey: prepared.public_key, preparedAt: now() } };
    });
    return { request: view(saved, 'owner'), description, code: r.app.code, public_key: prepared.public_key, bundle: prepared.bundle, runner: prepared.runner };
  }

  async function approveRun(actor: Actor, r: Request, input: Record<string, unknown>) {
    if (!runner) throw new TraceRequestError('Trace apps cannot run on this server yet.', 503);
    revised(r, input);
    const run = r.run;
    if (!run || run.id !== input.run_id) throw new TraceRequestError('Prepare this run first.', 409);
    if (run.description.expires_at <= now()) throw new TraceRequestError('This run expired before it was approved. Prepare it again.', 409);
    if (!await visible(r.entryId, await requester(r))) throw new TraceRequestError('The requester can no longer see this post.', 409);
    const binding = actor.user?.tinycloud;
    if (!binding) throw new TraceRequestError('Link your TinyCloud storage first.');
    const wire = input.delegation;
    if (typeof wire !== 'string' || wire.length > 90000) throw new TraceRequestError('A TinyCloud read grant is required.');
    const { signedFolderGrant } = await import('./tinycloud-grant-scope.js');
    try {
      signedFolderGrant(wire, { space: binding.space, ownerDid: binding.ownerDid, delegateDid: readerDid(run.publicKey),
        path: traceFolder(r.entryId), actions: ['tinycloud.kv/get'], host, maxMs: RUN_GRANT_MS }, now());
    } catch { throw new TraceRequestError('The signed TinyCloud permission must give this run get-only access to this one trace for up to 15 minutes.'); }
    const wrap = checkedWrap(input.wrap);
    // The run's key is used once: claim the run before calling the runner, so a second approval cannot start it again.
    await store.change(r.id, current => {
      if (!current || current.run?.id !== run.id) throw new TraceRequestError('This run was replaced. Review the request again.', 409);
      revised(current, input);
      if (current.state !== 'pending' && current.state !== 'answered') throw new TraceRequestError('This request has already been answered.', 409);
      return { ...current, run: undefined, running: { runId: run.id, since: now() } };
    });
    const clearRunning = (current?: Request): Request => {
      if (!current) throw missing();
      return current.running?.runId === run.id ? { ...current, running: undefined } : current;
    };
    let result: { sealed: SealedAnswer; signature: string };
    try { result = await runner.run({ run_id: run.id, delegation: wire, wrap, host }); }
    catch (err) { await store.change(r.id, clearRunning).catch(() => {}); return runnerFailed(err); }
    return view(await store.change(r.id, current => {
      if (!current) throw missing();
      // Declined, withdrawn, released or replaced while the app ran, or overtaken by a later run: the answer is dropped.
      if (current.revision !== r.revision || current.running?.runId !== run.id || (current.state !== 'pending' && current.state !== 'answered')) return clearRunning(current);
      return { ...current, running: undefined, state: 'answered',
        answer: { runId: run.id, description: run.description, sealed: result.sealed, signature: result.signature, runPublicKey: run.publicKey, at: now() } };
    }), 'owner');
  }

  async function release(r: Request, input: Record<string, unknown>) {
    revised(r, input);
    if (r.state !== 'answered' || !r.answer || r.answer.runId !== input.run_id) throw new TraceRequestError('There is no answer from that run to release.', 409);
    if (input.answer_sha256 !== undefined) throw new TraceRequestError('This release carries a hash of the plain answer, which Router must not hold. Update your owner tool and release again.');
    const sealed = checkedRelease(input.sealed);
    const ciphertext = Buffer.from(sealed.data, 'base64');
    if (createHash('sha256').update(ciphertext).digest('hex') !== sealed.meta.sha256 || ciphertext.length !== sealed.meta.bytes)
      throw new TraceRequestError('The sealed answer does not match its own hash.');
    if (!await visible(r.entryId, await requester(r))) throw new TraceRequestError('The requester can no longer see this post.', 409);
    return view(await store.change(r.id, current => {
      if (!current || current.state !== 'answered' || !current.answer || current.answer.runId !== input.run_id) throw new TraceRequestError('This request changed. Review it again.', 409);
      revised(current, input);
      return { ...current, state: 'released', released: { runId: current.answer.runId, description: current.answer.description, sealed, at: now() } };
    }), 'owner');
  }

  return async (actor: Actor, input: Record<string, unknown>) => {
    if (input.action === 'request') return request(actor, input);
    if (input.action === 'inbox') {
      const records = (await Promise.all(identities(actor).map(owner => store.pending(owner)))).flat();
      const current = await Promise.all(records.map(async r => await visible(r.entryId, actor) ? r : null));
      return { requests: current.filter((r): r is Request => r !== null).sort((a, b) => a.created - b.created).map(r => view(r, 'owner')) };
    }
    if (typeof input.request_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.request_id)) throw missing();
    const r = await store.get(input.request_id);
    if (!r || !isOwner(r, actor) && actor.keyHash !== r.requester) throw missing();
    const entry = await visible(r.entryId, actor);
    if (!entry || (entry.handle ? '@' + entry.handle : entry.pseudonym) !== r.owner && entry.pseudonym !== r.owner) throw missing();
    if (input.action === 'status') return view(r, isOwner(r, actor) ? 'owner' : 'requester');
    if (input.action === 'withdraw' && actor.keyHash === r.requester && !isOwner(r, actor)) {
      return view(await store.change(r.id, current => {
        if (!current) throw missing();
        if (current.state !== 'pending' && current.state !== 'answered') return current;
        return { ...current, state: 'withdrawn', run: undefined, running: undefined, answer: undefined };
      }), 'requester');
    }
    if (!isOwner(r, actor)) throw missing();
    if (input.action === 'prepare') return prepare(actor, r, input);
    if (input.action === 'approve') {
      if (!r.app) throw new TraceRequestError('This request was made before apps were required. Decline it; the requester can ask again with an app.', 409);
      return approveRun(actor, r, input);
    }
    if (input.action === 'release') return release(r, input);
    if (input.action === 'withhold') {
      revised(r, input);
      return view(await store.change(r.id, current => {
        if (!current || current.state !== 'answered') throw new TraceRequestError('There is no answer waiting to withhold.', 409);
        revised(current, input);
        return { ...current, state: 'withheld' };
      }), 'owner');
    }
    if (input.action !== 'decline') throw new TraceRequestError('Unknown trace request action.');
    return view(await store.change(r.id, current => {
      if (!current || current.revision !== input.revision) throw new TraceRequestError('This request changed. Review it again.', 409);
      if (current.state === 'declined') return current;
      if (current.state !== 'pending') throw new TraceRequestError('This request has already been answered.', 409);
      return { ...current, state: 'declined', run: undefined, running: undefined };
    }), 'owner');
  };
}
