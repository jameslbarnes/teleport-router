/** One run of a trace app: what the runner is told, what its attestation commits to, and how
 *  answers are sealed. See docs/attested-trace-apps.md.
 *
 * Router prepares a run with a description and the app's code. The runner checks the code
 * against the description, makes a key for this run alone and reports it. An attestation (a TDX
 * quote, or a simulated one in local tests) commits to the runner's code, the description's hash,
 * the key and the owner's nonce. The owner's side checks that, then gives the key a short read of
 * the trace. The runner uses the key once, runs the app, and seals the result to the owner.
 * Router only ever stores sealed results.
 */
import { createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { Worker } from 'node:worker_threads';
import { gunzipSync } from 'node:zlib';
import { SigningKey, Wallet } from 'ethers';
import { APP_LIMITS, APP_RUNTIME, appHash, checkAppCode, type AppInfo, type AppLimits, type AppResult, type TraceApp } from './trace-app.js';
import { compressPublicKey, openPart, publicKeyOf, sealPart, sha256Hex, type KeyWrap, type PartMeta, type TraceContext } from './trace-envelope.js';

export const RUN_DOMAIN = 'teleport-router/trace-run/v1';
export const RUN_GRANT_MS = 15 * 60_000;
export const RUN_PREPARE_MS = 10 * 60_000;

/** Everything a run is allowed to do, fixed before the owner approves it. */
export interface RunDescription {
  v: 1;
  request_id: string;
  revision: string;
  requester: string;
  owner_did: string;
  entry_id: string;
  part: 'full';
  ciphertext_sha256: string;
  app_hash: string;
  run_id: string;
  expires_at: number;
  answer_bytes: number;
  owner_public_key: string;
  /** The requester's key. Only an answer sealed to it can be released. */
  answer_key: string;
}

export class RunError extends Error {}

/** Deterministic JSON: keys sorted, no whitespace. The same rule as subhost/host.mjs. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new RunError('canonicalJson: numbers must be finite'); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson((value as any)[k])}`).join(',')}}`;
  throw new RunError(`canonicalJson: unsupported value of type ${typeof value}`);
}

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[\w-]{1,160}$/;
const DID = /^did:pkh:eip155:1:0x[0-9a-fA-F]{40}$/;
const COMPRESSED = /^0x0[23][0-9a-f]{64}$/;
const UNCOMPRESSED = /^0x04[0-9a-f]{128}$/;

/** Strict check: exactly these fields, each well formed. A field one side ignores could otherwise mean something to the other. */
export function checkRunDescription(input: unknown): RunDescription {
  const d = input as Record<string, unknown>;
  const fields = ['v', 'request_id', 'revision', 'requester', 'owner_did', 'entry_id', 'part', 'ciphertext_sha256', 'app_hash', 'run_id', 'expires_at', 'answer_bytes', 'owner_public_key', 'answer_key'];
  if (!d || typeof d !== 'object' || Array.isArray(d) || Object.keys(d).length !== fields.length || fields.some(f => !(f in d)))
    throw new RunError('The run description has the wrong fields.');
  const ok = d.v === 1 && typeof d.request_id === 'string' && HEX64.test(d.request_id)
    && typeof d.revision === 'string' && ID.test(d.revision) && typeof d.requester === 'string' && d.requester.length > 0 && d.requester.length <= 200
    && typeof d.owner_did === 'string' && DID.test(d.owner_did) && typeof d.entry_id === 'string' && ID.test(d.entry_id) && d.part === 'full'
    && typeof d.ciphertext_sha256 === 'string' && HEX64.test(d.ciphertext_sha256) && typeof d.app_hash === 'string' && HEX64.test(d.app_hash)
    && typeof d.run_id === 'string' && ID.test(d.run_id) && Number.isSafeInteger(d.expires_at)
    && Number.isSafeInteger(d.answer_bytes) && (d.answer_bytes as number) > 0 && (d.answer_bytes as number) <= APP_LIMITS.answerBytes
    && typeof d.owner_public_key === 'string' && COMPRESSED.test(d.owner_public_key)
    && typeof d.answer_key === 'string' && COMPRESSED.test(d.answer_key);
  if (!ok) throw new RunError('The run description is malformed.');
  return d as unknown as RunDescription;
}

export const runHash = (d: RunDescription) => sha256Hex(canonicalJson(d));

/** The text whose SHA-512 is a run attestation's report data. Its domain differs from the probe's, so neither can pass for the other. */
export function runBindingPreimage(b: { appId: string; name: string; codeHash: string; runHash: string; publicKey: string; nonce: string }): string {
  if (!/^[0-9a-f]{40}$/.test(b.appId) || !/^[a-z][a-z0-9-]{1,30}$/.test(b.name) || !HEX64.test(b.codeHash) || !HEX64.test(b.runHash)
    || !UNCOMPRESSED.test(b.publicKey) || !HEX64.test(b.nonce)) throw new RunError('Malformed run binding.');
  return canonicalJson({ domain: RUN_DOMAIN, app_id: b.appId, name: b.name, code_hash: b.codeHash, run_hash: b.runHash, public_key: b.publicKey, nonce: b.nonce });
}
export const runReportData = (preimage: string) => createHash('sha512').update(preimage, 'utf8').digest('hex');

/** What the owner's side receives to check a run before granting anything. */
export interface RunBundle {
  version: 1;
  simulated: boolean;
  preimage: string;
  report_data: string;
  /** The TDX quote, event log and measured compose file; absent when simulated. */
  quote?: string; event_log?: unknown; app_compose?: string;
}

/**
 * The owner-side check of a run. Router supplies the description; everything in it that matters is
 * checked here against what the owner's side knows for itself: the request and code it showed the
 * owner, its own DID and public key (the answer is sealed to that key), and the hash of the trace
 * ciphertext in its own storage. Then the bundle must commit to that description, the run's key and
 * the owner's fresh nonce.
 *
 * This checks the binding, not the attestation. For a real bundle the caller must first verify the
 * quote (Phala's verifier and subhost/verify.mjs: TDX signature, boot measurements, event log,
 * compose file), pass the report data read from that verified quote as verifiedReportData, and pass
 * a runner identity it pinned itself, never the one in Router's response. A simulated bundle has no
 * quote, so it passes only with allowSimulated.
 */
export function checkRunBundle(bundle: RunBundle, expected: {
  description: RunDescription; code: string; publicKey: string; nonce: string; runner: { appId: string; name: string; codeHash: string };
  request: { request_id: string; revision: string; entry_id: string; answer_key: string };
  own: { ownerDid: string; ownerPublicKey: string; ciphertextSha256: string };
}, { allowSimulated = false, now = Date.now(), verifiedReportData }: { allowSimulated?: boolean; now?: number; verifiedReportData?: string } = {}): { simulated: boolean } {
  if (bundle?.version !== 1 || typeof bundle.preimage !== 'string' || typeof bundle.report_data !== 'string') throw new RunError('Not a run bundle.');
  if (bundle.simulated && !allowSimulated) throw new RunError('This run attestation is simulated. Only local tests accept it.');
  if (!bundle.simulated && !verifiedReportData) throw new RunError('Verify the quote first, and pass the report data read from it.');
  const d = checkRunDescription(expected.description);
  if (d.request_id !== expected.request.request_id || d.revision !== expected.request.revision || d.entry_id !== expected.request.entry_id
    || d.answer_key !== compressPublicKey(expected.request.answer_key))
    throw new RunError('This run is for a different request or version of it.');
  if (d.owner_did.toLowerCase() !== expected.own.ownerDid.toLowerCase() || d.owner_public_key !== compressPublicKey(expected.own.ownerPublicKey))
    throw new RunError('This run would seal its answer to someone other than you.');
  if (d.ciphertext_sha256 !== expected.own.ciphertextSha256) throw new RunError('This run is for a different version of the trace than the one in your storage.');
  if (d.expires_at <= now || d.expires_at > now + RUN_PREPARE_MS + 60_000) throw new RunError('This run has expired or expires too late.');
  if (appHash({ code: expected.code, runtime: APP_RUNTIME }) !== d.app_hash) throw new RunError('The code shown is not the code this run will execute.');
  const preimage = runBindingPreimage({ ...expected.runner, runHash: runHash(d), publicKey: expected.publicKey, nonce: expected.nonce });
  if (bundle.preimage !== preimage) throw new RunError('The attestation is for a different run, key, runner or nonce.');
  if (runReportData(preimage) !== bundle.report_data || (!bundle.simulated && verifiedReportData !== bundle.report_data))
    throw new RunError('The attestation report data does not match.');
  return { simulated: !!bundle.simulated };
}

// --- Answers -------------------------------------------------------------------------------

export interface SealedAnswer { meta: PartMeta; data: string }
/** Each run's answer has its own envelope context, so a sealed answer cannot be moved to another run or note. */
const answerContext = (d: RunDescription): TraceContext => ({ ownerDid: d.owner_did, entryId: `${d.entry_id}/answer/${d.run_id}` });

/** What the run's key signs over a sealed result: anyone can seal text to the owner's public key, but only the attested run holds this key. */
export const resultDigest = (sealed: SealedAnswer, d: RunDescription) =>
  '0x' + sha256Hex(canonicalJson({ domain: 'teleport-router/trace-run-result/v1', run_hash: runHash(d), sealed_sha256: sha256Hex(canonicalJson(sealed)) }));
/** On the owner's side: the result came from the run whose key the attestation named. */
export function checkRunResult(sealed: SealedAnswer, signature: unknown, d: RunDescription, runPublicKey: string) {
  let signer: string;
  try { signer = SigningKey.recoverPublicKey(resultDigest(sealed, d), String(signature)); }
  catch { throw new RunError('The result carries no valid signature from the run.'); }
  if (compressPublicKey(signer) !== compressPublicKey(runPublicKey)) throw new RunError('The result was not signed by the attested run.');
}

const SECP256K1_N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');

/**
 * Router's key for answers released through Router, to a requester who gave no key of their own.
 * It is derived from Router's record-encryption key, so it exists only inside the enclave and stays
 * the same across restarts. Released answers stay sealed to it at rest; Router opens one only to hand
 * it to its requester.
 */
export function answerCustody(secret: Uint8Array) {
  let privateKey = '';
  for (let i = 0; !privateKey; i++) {
    const k = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), `teleport-router/answer-custody/v1/${i}`, 32));
    const n = BigInt('0x' + k.toString('hex'));
    if (n > 0n && n < SECP256K1_N) privateKey = '0x' + k.toString('hex');
  }
  return {
    publicKey: publicKeyOf(privateKey),
    open: (sealed: SealedAnswer, d: RunDescription, sealedSha256: string) => openReleased(sealed, d, privateKey, sealedSha256),
  };
}
export type AnswerCustody = ReturnType<typeof answerCustody>;

export function sealResult(result: AppResult, d: RunDescription): SealedAnswer {
  const { meta, ciphertext } = sealPart(Buffer.from(JSON.stringify(result), 'utf8'), answerContext(d), 'answer', { owner: d.owner_public_key });
  return { meta, data: ciphertext.toString('base64') };
}
export function openResult(sealed: SealedAnswer, d: RunDescription, ownerPrivateKey: string): AppResult {
  const plain = openPart(sealed.meta, Buffer.from(sealed.data, 'base64'), answerContext(d), 'answer', 'owner', ownerPrivateKey);
  const r = JSON.parse(plain.toString('utf8'));
  if (r?.ok === true && typeof r.answer === 'string') return { ok: true, answer: r.answer };
  if (r?.ok === false && typeof r.error === 'string') return { ok: false, error: r.error };
  throw new RunError('The sealed result is malformed.');
}
/**
 * On the owner's side, at release: seal exactly the answer the owner read to the requester's key. The receipt is the
 * sealed answer's own hash, of its ciphertext, which says nothing about the answer. No hash of the plain answer is
 * ever sent: Router could test guesses against it, and a yes, a no or a small count is easy to guess.
 */
export function sealForRequester(answer: string, d: RunDescription, requesterPublicKey: string): { sealed: SealedAnswer; sealed_sha256: string } {
  const { meta, ciphertext } = sealPart(Buffer.from(answer, 'utf8'), answerContext(d), 'answer', { reader: compressPublicKey(requesterPublicKey) });
  return { sealed: { meta, data: ciphertext.toString('base64') }, sealed_sha256: meta.sha256 };
}
/** On the requester's side. `sealedSha256` is the receipt Router recorded at release; opening checks the ciphertext against it. */
export function openReleased(sealed: SealedAnswer, d: RunDescription, requesterPrivateKey: string, sealedSha256: string): string {
  if (!sealed?.meta || sealed.meta.sha256 !== sealedSha256) throw new RunError('The released answer does not match the one the owner released.');
  return openPart(sealed.meta, Buffer.from(sealed.data, 'base64'), answerContext(d), 'answer', 'reader', requesterPrivateKey).toString('utf8');
}

// --- The runner ----------------------------------------------------------------------------

/** Reads the granted trace's record and full ciphertext from the owner's storage, with the run's key. */
export type TraceSource = (input: { delegation: string; host: string; entryId: string; privateKey: string }) => Promise<{ record: any; ciphertext: Buffer }>;
export type AppExecutor = (app: TraceApp, trace: string, info: AppInfo, limits: AppLimits) => Promise<AppResult>;

interface Run { d: RunDescription; code: string; wallet: ReturnType<typeof Wallet.createRandom> | null; state: 'prepared' | 'running' | 'done' }

/** `execute` runs stranger-written code, so it has no default: the runner passes workerExecutor, which kills a stuck
 *  app; tests may pass runApp. */
export function traceRunner({ fetchTrace, execute, now = Date.now, maxActive = 2, limits = APP_LIMITS, fetchTimeoutMs = 60_000 }: {
  fetchTrace: TraceSource; execute: AppExecutor; now?: () => number; maxActive?: number; limits?: AppLimits; fetchTimeoutMs?: number;
}) {
  const runs = new Map<string, Run>();
  const sweep = () => {
    for (const [id, r] of runs) if (r.d.expires_at < now() && r.state !== 'running') { r.wallet = null; runs.delete(id); }
  };
  return {
    /** Checks the code against the description and makes this run's key. The key never leaves the runner. */
    prepare(input: { description: unknown; code: unknown }) {
      sweep();
      const d = checkRunDescription(input.description);
      if (d.expires_at <= now() || d.expires_at > now() + RUN_PREPARE_MS + 1000) throw new RunError('The run must expire within ten minutes.');
      if (d.answer_bytes > limits.answerBytes) throw new RunError('The answer limit is larger than the runner allows.');
      let code: string;
      try { code = checkAppCode(input.code); } catch { throw new RunError('The code is not a valid app.'); }
      if (appHash({ code, runtime: APP_RUNTIME }) !== d.app_hash) throw new RunError('The code does not match the run description.');
      if (runs.has(d.run_id)) throw new RunError('This run ID was already used.');
      if ([...runs.values()].filter(r => r.state !== 'done').length >= maxActive) throw new RunError('The runner is busy. Try again in a minute.');
      const wallet = Wallet.createRandom();
      runs.set(d.run_id, { d, code, wallet, state: 'prepared' });
      return { run_id: d.run_id, run_hash: runHash(d), public_key: wallet.signingKey.publicKey };
    },
    /** Uses the run's key once: reads the trace, checks it is the version described, runs the app, seals the result to the owner. */
    async run(input: { run_id: string; delegation: string; wrap: KeyWrap; host: string }) {
      sweep();
      const r = runs.get(input.run_id);
      if (!r || r.state !== 'prepared' || !r.wallet) throw new RunError('There is no prepared run with that ID, or it has already run.');
      const wallet = r.wallet;
      r.wallet = null; r.state = 'running';
      try {
        let record: any, ciphertext: Buffer;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          ({ record, ciphertext } = await Promise.race([
            fetchTrace({ delegation: input.delegation, host: input.host, entryId: r.d.entry_id, privateKey: wallet.privateKey }),
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), fetchTimeoutMs); }),
          ]));
        } catch { throw new RunError('The runner could not read the trace with this grant.'); }
        finally { clearTimeout(timer); }
        if (sha256Hex(ciphertext) !== r.d.ciphertext_sha256) throw new RunError('The trace is not the version this run was prepared for.');
        if (record?.entryId !== r.d.entry_id || String(record?.ownerDid).toLowerCase() !== r.d.owner_did.toLowerCase())
          throw new RunError('The trace belongs to a different note or owner.');
        let plain: Buffer;
        try {
          plain = gunzipSync(openPart({ ...record.full, wraps: { reader: input.wrap } }, ciphertext,
            { ownerDid: record.sealedOwnerDid || record.ownerDid, entryId: r.d.entry_id }, 'full', 'reader', wallet.privateKey),
            { maxOutputLength: limits.traceBytes });
        } catch { throw new RunError('The trace could not be opened with this run\'s key, or it is too large.'); }
        const result = await execute({ runtime: APP_RUNTIME, code: r.code, purpose: '' }, plain.toString('utf8'),
          { entry_id: r.d.entry_id, bytes: plain.length }, { ...limits, answerBytes: r.d.answer_bytes });
        plain.fill(0);
        const sealed = sealResult(result, r.d);
        return { run_id: r.d.run_id, sealed, signature: wallet.signingKey.sign(resultDigest(sealed, r.d)).serialized };
      } finally { r.state = 'done'; }
    },
  };
}

/**
 * A runner in this process with a simulated attestation, for local tests and demos only. Its
 * bundles say `simulated: true`, and checkRunBundle refuses them unless the caller opts in.
 */
export function simulatedRunnerClient(runner: ReturnType<typeof traceRunner>, identity: { appId: string; name: string; codeHash: string }) {
  return {
    async prepare(input: { description: RunDescription; code: string; nonce: string }) {
      const prepared = runner.prepare({ description: input.description, code: input.code });
      const preimage = runBindingPreimage({ ...identity, runHash: prepared.run_hash, publicKey: prepared.public_key, nonce: input.nonce });
      const bundle: RunBundle = { version: 1, simulated: true, preimage, report_data: runReportData(preimage) };
      return { run_id: prepared.run_id, public_key: prepared.public_key, bundle, runner: identity };
    },
    run: (input: { run_id: string; delegation: string; wrap: KeyWrap; host: string }) => runner.run(input),
  };
}

// --- A hard stop around the sandbox --------------------------------------------------------

const WORKER_SOURCE = `
const { parentPort, workerData: w } = require('node:worker_threads');
import(w.moduleUrl).then(m => m.runApp(w.app, w.trace, w.info, w.limits))
  .then(r => parentPort.postMessage(r), () => parentPort.postMessage({ ok: false, error: 'The sandbox failed to start.' }));
`;

/** Runs the app in a worker thread and terminates it a little after the time limit, whatever the engine is doing.
 *  `moduleUrl` is the compiled trace-app.js; in the runner, file:///app/server/dist/trace-app.js. */
export function workerExecutor(moduleUrl: string): AppExecutor {
  return (app, trace, info, limits) => new Promise(resolve => {
    let settled = false;
    const done = (r: AppResult) => { if (settled) return; settled = true; clearTimeout(timer); void worker.terminate(); resolve(r); };
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { moduleUrl, app, trace, info, limits },
      resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 8 } });
    const timer = setTimeout(() => done({ ok: false, error: `The app ran out of time (${limits.timeMs / 1000} seconds), and the runner stopped it.` }), limits.timeMs + 2000);
    worker.once('message', (r: AppResult) => done(r?.ok === true || r?.ok === false ? r : { ok: false, error: 'The sandbox returned nothing usable.' }));
    worker.once('error', () => done({ ok: false, error: 'The app stopped the sandbox; it may have run out of memory.' }));
    worker.once('exit', () => done({ ok: false, error: 'The sandbox exited before the app finished.' }));
  });
}

// --- Inside Router's enclave ------------------------------------------------------------------
// The sub-container host (subhost/host.mjs) runs the runner container and, per run, a sandbox
// container with no network. subhost/runner.mjs and subhost/sandbox.mjs start what is below.

/** A POST or DELETE over a Unix socket (a named pipe on Windows), with limits on time and reply size. */
export function unixPost(socketPath: string, path: string, body: unknown, { method = 'POST', timeoutMs = 30_000, maxBytes = 64 * 1024 } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest({ socketPath, method, path, timeout: timeoutMs,
      headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes) req.destroy(new Error('reply too large')); else chunks.push(c); });
      res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

/** Router's side of the runs socket the sub-container host gives it. Only fixed sentences come back on failure. */
export function subhostRunnerClient(socketPath: string) {
  const call = async (path: string, body: unknown, timeoutMs: number, maxBytes = 256 * 1024) => {
    let r: { status: number; text: string };
    try { r = await unixPost(socketPath, path, body, { timeoutMs, maxBytes }); }
    catch { throw new RunError('The trace runner did not answer.'); }
    let value: any;
    try { value = JSON.parse(r.text); } catch { throw new RunError('The trace runner gave an unreadable reply.'); }
    if (r.status !== 200) throw new RunError(typeof value?.error === 'string' ? value.error.slice(0, 300) : 'The trace runner refused.');
    return value;
  };
  return {
    async prepare(input: { description: RunDescription; code: string; nonce: string }) {
      // A real bundle carries the measured compose file, the event log and the quote: hundreds of kilobytes.
      const v = await call('/prepare', input, 60_000, 4 * 1024 * 1024);
      return { run_id: v.run_id, public_key: v.public_key, bundle: v.bundle as RunBundle, runner: v.runner };
    },
    async run(input: { run_id: string; delegation: string; wrap: KeyWrap; host: string }) {
      const v = await call('/run', input, 160_000);
      return { run_id: v.run_id, sealed: v.sealed as SealedAnswer, signature: String(v.signature) };
    },
  };
}

/** The runner's service on its socket: prepare and run. Failures are fixed sentences; nothing about a trace or an app's output. */
export function runnerService(runner: ReturnType<typeof traceRunner>) {
  return async (path: string | undefined, body: any): Promise<{ status: number; value: unknown }> => {
    try {
      if (path === '/prepare') return { status: 200, value: runner.prepare({ description: body?.description, code: body?.code }) };
      if (path === '/run') return { status: 200, value: await runner.run({ run_id: body?.run_id, delegation: body?.delegation, wrap: body?.wrap, host: body?.host }) };
      return { status: 404, value: { error: 'not found' } };
    } catch (err) {
      return err instanceof RunError ? { status: 400, value: { error: err.message } } : { status: 500, value: { error: 'The run failed.' } };
    }
  };
}

/** Runs each app in a fresh sandbox container that the host starts on request and removes after. */
export function sandboxExecutor({ askHost, socketFor, ready = (socket: string) => existsSync(socket), waitMs = 20_000 }: {
  askHost: (method: 'POST' | 'DELETE', id: string) => Promise<void>;
  socketFor: (id: string) => string;
  ready?: (socket: string) => boolean;
  waitMs?: number;
}): AppExecutor {
  return async (app, trace, info, limits) => {
    const id = randomBytes(16).toString('hex');
    try {
      try { await askHost('POST', id); } catch { return { ok: false, error: 'The sandbox could not start.' }; }
      const socket = socketFor(id), until = Date.now() + waitMs;
      while (!ready(socket)) {
        if (Date.now() > until) return { ok: false, error: 'The sandbox could not start.' };
        await new Promise(r => setTimeout(r, 100));
      }
      const r = await unixPost(socket, '/job', { app: { code: app.code }, trace, info, limits }, { timeoutMs: limits.timeMs + 5_000, maxBytes: 4 * limits.answerBytes + 4096 });
      const v = r.status === 200 ? JSON.parse(r.text) : null;
      if (v?.ok === true && typeof v.answer === 'string' && Buffer.byteLength(v.answer) <= limits.answerBytes) return { ok: true, answer: v.answer };
      if (v?.ok === false && typeof v.error === 'string') return { ok: false, error: v.error.slice(0, 600) };
      return { ok: false, error: 'The sandbox returned nothing usable.' };
    } catch (err) {
      return { ok: false, error: /timed out/.test(String((err as Error)?.message)) ? `The app ran out of time (${limits.timeMs / 1000} seconds), and the runner stopped it.` : 'The sandbox failed.' };
    } finally { await askHost('DELETE', id).catch(() => {}); }
  };
}

/** The sandbox container's one job: check it, run the app with the worker's hard stop, and answer. Limits never exceed the defaults. */
export function sandboxJobHandler(execute: AppExecutor) {
  return async (body: any): Promise<AppResult> => {
    const malformed: AppResult = { ok: false, error: 'The sandbox was given a malformed job.' };
    if (!body || typeof body.trace !== 'string' || typeof body.info?.entry_id !== 'string' || !Number.isSafeInteger(body.info?.bytes)) return malformed;
    let code: string;
    try { code = checkAppCode(body.app?.code); } catch { return malformed; }
    const asked = Number(body.limits?.answerBytes);
    const limits = { ...APP_LIMITS, answerBytes: Number.isSafeInteger(asked) && asked > 0 ? Math.min(asked, APP_LIMITS.answerBytes) : APP_LIMITS.answerBytes };
    return execute({ runtime: APP_RUNTIME, code, purpose: '' }, body.trace, { entry_id: body.info.entry_id, bytes: body.info.bytes }, limits);
  };
}

// --- Reading the trace from TinyCloud --------------------------------------------------------

/** The runner's TinyCloud reader: the same reads as server/scripts/trace-reader.mjs, with checks on the grant's scope. */
export function tinyCloudTraceSource(): TraceSource {
  return async ({ delegation, host, entryId, privateKey }) => {
    const [{ TinyCloudNode, deserializeDelegation }, { sessionExpiryFor }] = await Promise.all([
      import('@tinycloud/node-sdk'), import('./tinycloud-group-store.js')]);
    const d: any = deserializeDelegation(delegation);
    const did = 'did:pkh:eip155:1:' + new Wallet(privateKey).address;
    if (d.delegateDID.toLowerCase() !== did.toLowerCase() || !d.expiry || d.expiry.getTime() <= Date.now() || (d.host && d.host !== host)
      || d.path !== `router/traces/${entryId}/` || d.actions.length !== 1 || d.actions[0] !== 'tinycloud.kv/get')
      throw new RunError('The grant is not a read of this trace for this run.');
    const node: any = new TinyCloudNode({ privateKey, host, autoCreateSpace: false, enablePublicSpace: false,
      autoBootstrapAccount: false, includeAccountRegistryPermissions: false } as any);
    await node.signIn();
    try {
      const access = await node.useDelegation({ ...d, host, expiry: sessionExpiryFor(d.expiry) });
      const get = async (path: string) => {
        const r = await access.kv.get(path, { source: 'network' });
        if (!r.ok || r.data.data == null) throw new RunError('TinyCloud refused the read or the trace is incomplete.');
        return r.data.data;
      };
      const raw = await get('meta'), record = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const meta = record?.full;
      if (record?.v !== 1 || record.entryId !== entryId || (record.upload && !ID.test(record.upload)) || !Number.isInteger(meta?.chunks) || meta.chunks < 1 || meta.chunks > 48)
        throw new RunError('The trace record is invalid.');
      const pieces: string[] = [];
      for (let i = 0; i < meta.chunks; i++) {
        const chunk = await get((record.upload ? record.upload + '/' : '') + 'full-' + String(i).padStart(3, '0'));
        if (typeof chunk !== 'string' || chunk.length > 180000) throw new RunError('Invalid trace chunk.');
        pieces.push(chunk);
      }
      return { record, ciphertext: Buffer.from(pieces.join(''), 'base64') };
    } finally { await node.signOut(); }
  };
}
