import { createHash, randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { TCWSessionManager, prepareSession, completeSessionSetup, createDelegation, makeSpaceId } from '@tinycloud/node-sdk-wasm';
import { deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import { Wallet } from 'ethers';
import { testWallet } from './author-test-fixtures.js';
import type { User, JournalEntry } from './storage.js';
import { traceAccess, traceRequestStore, readerDid } from './trace-access.js';
import { sealPart } from './trace-envelope.js';
import { runAppStep } from './trace-app.js';
import { answerCustody, checkRunBundle, checkRunResult, openReleased, openResult, sealForRequester, sealResult, simulatedRunnerClient, traceRunner, type RunBundle } from './trace-run.js';
import { modelKeyVault, type AttestedProvider, type ModelConnector, type ModelDeclaration } from './trace-model.js';
// @ts-expect-error The owner device uses browser WebCrypto in the production module.
import { rewrapTraceKey } from '../../browser/src/trace-keys.mjs';

const owner = testWallet('owner'), requesterKey = testWallet('reader'), host = 'https://storage.example';
const ownerDid = readerDid(owner.signingKey.compressedPublicKey);
const space = makeSpaceId(owner.address, 1, 'router'), path = 'router/traces/a-note/';
const ownerUser = {handle:'author', tinycloud:{space, ownerDid}} as User;
const author = {keyHash:'author-key-hash', pseudonym:'author pen name', user:ownerUser};
const agent = {keyHash:'reader-key-hash', pseudonym:'reader pen name', user:null};
const stranger = {keyHash:'stranger-key-hash', pseudonym:'stranger pen name', user:{handle:'stranger'} as User};
const clock = Math.floor(Date.now()/1000)*1000;
const identity = { appId: 'ab'.repeat(20), name: 'trace-runner', codeHash: 'cd'.repeat(32) };
const TRACE = ['{"type":"tool_use","name":"Read"}', '{"type":"tool_use","name":"Bash"}', '{"type":"tool_use","name":"Read"}', 'api key: sk-secret'].join('\n');
const COUNT = `function analyze(trace) {
  const counts = {};
  for (const line of trace.split('\\n')) { const m = line.match(/"name":"(\\w+)"/); if (m) counts[m[1]] = (counts[m[1]] || 0) + 1; }
  return JSON.stringify(counts);
}`;
const APP = { code: COUNT, purpose: 'Count which tools the agent called' };

/** A trace sealed to its owner, as the capture client stores it. */
function storedTrace(text = TRACE) {
  const sealed = sealPart(gzipSync(Buffer.from(text)), { ownerDid, entryId: 'a-note' }, 'full', { owner: owner.signingKey.compressedPublicKey });
  return { meta: sealed.meta, ciphertext: sealed.ciphertext, record: { v: 1, entryId: 'a-note', ownerDid, full: { ...sealed.meta, chunks: 1 } } };
}

/** Real, locally issued TinyCloud session and scoped child. The storage node enforces the parent on read. */
async function grant(recipient: string, { folder = path, seconds = 600 } = {}) {
  const manager = new TCWSessionManager();
  try {
    const key = manager.createSessionKey('owner');
    const jwk = JSON.parse(manager.jwk(key)!);
    const config = { address:owner.address, chainId:1, domain:'router.example', spaceId:space, jwk,
      issuedAt:new Date(clock).toISOString(), expirationTime:new Date(clock+86400000).toISOString(),
      abilities:{ kv:{'router/':['tinycloud.kv/get']} } };
    const prepared = prepareSession(config);
    const parent = completeSessionSetup({...prepared,signature:await owner.signMessage(prepared.siwe)});
    const session = {...parent, jwk, spaceId:space, verificationMethod:parent.verificationMethod.split('#')[0]};
    const exp = clock/1000+seconds, result = createDelegation(session,recipient,space,{kv:{[folder]:['tinycloud.kv/get']}},exp,undefined);
    return serializeDelegation({cid:result.cid,delegationHeader:{Authorization:result.delegation},spaceId:space,path:folder,
      actions:['tinycloud.kv/get'],resources:result.resources,expiry:new Date(exp*1000),delegateDID:recipient,ownerAddress:owner.address,chainId:1,host} as any);
  } finally { manager.free(); }
}

/** A model provider that has "verified". It records what it was sent, and its replies come from `reply`. */
function fakeProvider(reply: (prompt: string, call: number) => string | Response = (prompt, call) => `reply ${call} to ${prompt.length} bytes`, onCall?: () => void,
  stall?: 'connect' | 'fetch' | 'confirm' | 'close') {
  const sent: { url: string; authorization: string; body: any }[] = [];
  let connects = 0;
  const never = <T,>() => new Promise<T>(() => {});
  const connect: ModelConnector = async () => {
    connects++;
    if (stall === 'connect') return never();
    return { baseURL: 'https://model.example/v1', release: 'ee'.repeat(32), verdict: 'VERIFIED (simulated)',
      fetch: async (url, init) => {
        const body = JSON.parse(String(init.body));
        sent.push({ url, authorization: (init.headers as Record<string, string>).authorization, body });
        onCall?.();
        if (stall === 'fetch') return never();
        const r = reply(body.messages[0].content, sent.length);
        return r instanceof Response ? r : new Response(JSON.stringify({ choices: [{ message: { content: r } }] }));
      },
      confirm: async () => stall === 'confirm' ? never() : `receipt-${sent.length}`, close: async () => stall === 'close' ? never() : undefined };
  };
  return { connect, sent, connects: () => connects };
}

function fixture({ withCustody = true, models = ['redpill'] as AttestedProvider[], withVault = true, provider = fakeProvider(), connectors = ['redpill', 'tinfoil'] as AttestedProvider[], runMs, closeMs, settleMs }:
  { withCustody?: boolean; models?: AttestedProvider[]; withVault?: boolean; provider?: ReturnType<typeof fakeProvider>; connectors?: AttestedProvider[]; runMs?: number; closeMs?: number; settleMs?: number } = {}) {
  let time = clock, allowed = true, trace = storedTrace();
  const notices: any[] = [];
  const entry = {id:'a-note',handle:'author',pseudonym:author.pseudonym} as JournalEntry;
  const store = traceRequestStore();
  // The storage node's part: it serves the trace only to the key the grant names.
  const core = traceRunner({ now: () => time, execute: runAppStep, runMs, closeMs, settleMs, connectorFor: p => connectors.includes(p) ? provider.connect : null, fetchTrace: async ({ delegation, privateKey }) => {
    if (deserializeDelegation(delegation).delegateDID.toLowerCase() !== readerDid(new Wallet(privateKey).signingKey.publicKey).toLowerCase()) throw Error('refused');
    return { record: trace.record, ciphertext: trace.ciphertext };
  } });
  let duringRun: (() => Promise<unknown>) | undefined;
  const simulated = simulatedRunnerClient(core, identity);
  const custody = withCustody ? answerCustody(randomBytes(32)) : undefined;
  const runnerCalls: any[] = [];
  const call = traceAccess({ store, host, now: () => time, getUser: async () => null, models, modelKeys: withVault ? modelKeyVault(randomBytes(32)) : undefined,
    visible: async (id, who) => id === entry.id && (who.keyHash === author.keyHash || allowed && who.keyHash === agent.keyHash || who.keyHash === stranger.keyHash) ? entry : null,
    runner: { prepare: input => { runnerCalls.push({ prepare: input }); return simulated.prepare(input); },
      run: async input => { runnerCalls.push({ run: input }); const r = await simulated.run(input); await duringRun?.(); return r; } },
    traceInfo: async () => ({ ownerDid, ciphertextSha256: trace.meta.sha256, ownerPublicKey: owner.signingKey.compressedPublicKey }),
    onRequest: n => notices.push(n), custody }) as (actor: any, input: any) => Promise<any>;
  const ask = (app: any = APP) => call(agent, { action: 'request', entry_id: entry.id, app, answer_public_key: requesterKey.signingKey.compressedPublicKey });
  const askViaRouter = (app: any = APP) => call(agent, { action: 'request', entry_id: entry.id, app });
  const askModel = ({ app = MODEL_APP, model = DECL as unknown, key = MODEL_KEY as unknown } = {}) =>
    call(agent, { action: 'request', entry_id: entry.id, app, answer_public_key: requesterKey.signingKey.compressedPublicKey, model, model_key: key });
  return { call, ask, askViaRouter, askModel, custody, store, core, notices, provider, runnerCalls, models, restrict: () => { allowed = false; }, advance: (ms: number) => { time += ms; },
    whileRunning: (fn: () => Promise<unknown>) => { duringRun = fn; },
    replaceTrace: (text: string) => { trace = storedTrace(text); }, trace: () => trace };
}

/** What the owner's own tool does: prepare, check the attestation against what it showed and what it knows, grant, run, open. */
const mine = (f: ReturnType<typeof fixture>) => ({ ownerDid, ownerPublicKey: owner.signingKey.compressedPublicKey, ciphertextSha256: f.trace().meta.sha256 });
async function ownerRuns(f: ReturnType<typeof fixture>, shown: any) {
  const nonce = randomBytes(32).toString('hex');
  const prepared = await f.call(author, { action: 'prepare', request_id: shown.request_id, revision: shown.revision, nonce });
  checkRunBundle(prepared.bundle, { description: prepared.description, code: shown.app.code, publicKey: prepared.public_key, nonce, runner: identity,
    request: { request_id: shown.request_id, revision: shown.revision, entry_id: shown.entry_id, answer_key: shown.answer_public_key }, own: mine(f),
    model: shown.model.declaration }, { allowSimulated: true, now: clock });
  const wrap = await rewrapTraceKey(f.trace().meta, ownerDid, 'a-note', owner.privateKey, prepared.public_key);
  const delegation = await grant(readerDid(prepared.public_key));
  const answered = await f.call(author, { action: 'approve', request_id: shown.request_id, revision: shown.revision, run_id: prepared.description.run_id, delegation, wrap });
  checkRunResult(answered.answer.sealed, answered.answer.signature, prepared.description, prepared.public_key);
  return { prepared, answered, result: openResult(answered.answer.sealed, answered.answer.description, owner.privateKey), wrap, delegation };
}

const DECL: ModelDeclaration = { provider: 'redpill', model: 'z-ai/glm-5.3', calls: 2, prompt_bytes: 2000, reply_tokens: 100 };
const MODEL_KEY = 'sk-redpill-test-0123456789abcdef';
/** Asks twice, then answers with what the model said. Each run starts from the top with the replies so far. */
const MODEL_APP = { purpose: 'Ask a model which tools the agent used', code: `function analyze(trace, info, replies) {
  if (replies.length === 0) return { ask: 'Which tools? ' + trace.split('\\n').length + ' lines' };
  if (replies.length === 1) return { ask: 'Shorter: ' + replies[0] };
  return 'model: ' + replies.join(' / ');
}` };
const V1_FIELDS = ['answer_bytes', 'answer_key', 'app_hash', 'ciphertext_sha256', 'entry_id', 'expires_at', 'owner_did', 'owner_public_key', 'part', 'request_id', 'requester', 'revision', 'run_id', 'v'];

describe('trace requests that carry an app', () => {
  it('runs the shown code on the trace, shows the owner the answer, and releases exactly that answer to the requester', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.ask(), f.ask()]);
    expect(a.request_id).toBe(b.request_id);
    expect(a.revision).toBe(b.revision);
    expect(f.notices).toHaveLength(1);
    expect(f.notices[0]).toMatchObject({ owner: '@author', entryId: 'a-note', purpose: APP.purpose });
    const inbox = await f.call(author, { action: 'inbox' });
    expect(inbox.requests).toHaveLength(1);
    const shown = inbox.requests[0];
    expect(shown.app).toMatchObject({ code: COUNT, purpose: APP.purpose });
    const { result } = await ownerRuns(f, shown);
    expect(result).toEqual({ ok: true, answer: '{"Read":2,"Bash":1}' });
    const waiting = await f.call(agent, { action: 'status', request_id: a.request_id });
    expect(waiting.state).toBe('pending');
    expect(waiting).not.toHaveProperty('answer');
    expect((await f.call(author, { action: 'inbox' })).requests[0].state).toBe('answered');
    const answered = await f.call(author, { action: 'status', request_id: a.request_id });
    const { sealed, sealed_sha256 } = sealForRequester((result as any).answer, answered.answer.description, requesterKey.signingKey.compressedPublicKey);
    const plainHash = createHash('sha256').update((result as any).answer, 'utf8').digest('hex');
    const releaseInput = { action: 'release', request_id: a.request_id, revision: a.revision, run_id: answered.answer.run_id, sealed };
    // A hash of the plain answer would let Router test guesses at a short answer, so a release carrying one is refused.
    await expect(f.call(author, { ...releaseInput, answer_sha256: plainHash })).rejects.toThrow('hash of the plain answer');
    const tampered = { ...sealed, meta: { ...sealed.meta, sha256: plainHash } };
    await expect(f.call(author, { ...releaseInput, sealed: tampered })).rejects.toThrow('does not match its own hash');
    await f.call(author, releaseInput);
    const released = await f.call(agent, { action: 'status', request_id: a.request_id });
    expect(released.state).toBe('released');
    expect(released.sealed_sha256).toBe(sealed_sha256);
    expect(openReleased(released.answer, released.run, requesterKey.privateKey, released.sealed_sha256)).toBe('{"Read":2,"Bash":1}');
    expect(() => openReleased(released.answer, released.run, testWallet('other').privateKey, released.sealed_sha256)).toThrow();
    expect(() => openReleased(released.answer, released.run, requesterKey.privateKey, plainHash)).toThrow('does not match');
    const ownerView = await f.call(author, { action: 'status', request_id: a.request_id });
    expect(ownerView.released).toMatchObject({ run_id: answered.answer.run_id, sealed_sha256 });
    for (const view of [released, ownerView]) expect(JSON.stringify(view)).not.toContain(plainHash);
    expect((await f.call(author, { action: 'inbox' })).requests).toHaveLength(0);
  });

  it('refuses a request without an app or with code that does not parse, and needs a withdrawal to change the app', async () => {
    const f = fixture();
    await expect(f.call(agent, { action: 'request', entry_id: 'a-note', reader_public_key: requesterKey.signingKey.compressedPublicKey })).rejects.toThrow('must carry an app');
    await expect(f.ask({ code: 'function analyze( {', purpose: 'x' })).rejects.toThrow('does not parse');
    await expect(f.call(agent, { action: 'request', entry_id: 'a-note', app: APP, answer_public_key: 'nope' })).rejects.toThrow('answer_public_key');
    const first = await f.ask();
    await expect(f.ask({ ...APP, code: COUNT + '\n// v2' })).rejects.toThrow('Withdraw it first');
    await expect(f.call(author, { action: 'withdraw', request_id: first.request_id })).rejects.toThrow('Unknown');
    expect(await f.call(agent, { action: 'withdraw', request_id: first.request_id })).toMatchObject({ state: 'withdrawn' });
    expect((await f.call(author, { action: 'inbox' })).requests).toHaveLength(0);
    const second = await f.ask({ ...APP, code: COUNT + '\n// v2' });
    expect(second.revision).not.toBe(first.revision);
    expect(f.notices).toHaveLength(2);
    await expect(f.call(author, { action: 'prepare', request_id: first.request_id, revision: first.revision, nonce: 'aa'.repeat(32) })).rejects.toThrow('changed');
  });

  it('answers the requester the same way before and after the app has run, so they cannot tell when it ran', async () => {
    const f = fixture(), r = await f.ask();
    const before = { retry: await f.ask(), status: await f.call(agent, { action: 'status', request_id: r.request_id }),
      swap: await f.ask({ ...APP, code: COUNT + ' ' }).catch(e => e.message) };
    await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    const after = { retry: await f.ask(), status: await f.call(agent, { action: 'status', request_id: r.request_id }),
      swap: await f.ask({ ...APP, code: COUNT + ' ' }).catch(e => e.message) };
    expect(after).toEqual(before);
    expect(f.notices).toHaveLength(1);
  });

  it('lets the owner see that the attested run is not the request or code they were shown', async () => {
    const f = fixture(), r = await f.ask(), shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const nonce = randomBytes(32).toString('hex');
    const p = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    const expected = { description: p.description, code: shown.app.code, publicKey: p.public_key, nonce, runner: identity,
      request: { request_id: shown.request_id, revision: shown.revision, entry_id: shown.entry_id, answer_key: shown.answer_public_key }, own: mine(f) };
    const local = { allowSimulated: true, now: clock };
    expect(checkRunBundle(p.bundle, expected, local)).toEqual({ simulated: true });
    expect(() => checkRunBundle(p.bundle, expected, { now: clock })).toThrow('simulated');
    expect(() => checkRunBundle(p.bundle, { ...expected, code: COUNT + ' ' }, local)).toThrow('not the code');
    expect(() => checkRunBundle(p.bundle, { ...expected, request: { ...expected.request, revision: 'older' } }, local)).toThrow('different request');
    expect(() => checkRunBundle(p.bundle, { ...expected, request: { ...expected.request, answer_key: testWallet('router').signingKey.compressedPublicKey } }, local)).toThrow('different request');
    expect(() => checkRunBundle(p.bundle, { ...expected, own: { ...expected.own, ownerPublicKey: testWallet('router').signingKey.compressedPublicKey } }, local)).toThrow('someone other than you');
    expect(() => checkRunBundle(p.bundle, { ...expected, own: { ...expected.own, ciphertextSha256: '00'.repeat(32) } }, local)).toThrow('different version of the trace');
    expect(() => checkRunBundle(p.bundle, expected, { allowSimulated: true, now: clock + 11 * 60_000 })).toThrow('expired');
    expect(() => checkRunBundle(p.bundle, { ...expected, nonce: 'bb'.repeat(32) }, local)).toThrow('different run');
    expect(() => checkRunBundle(p.bundle, { ...expected, publicKey: testWallet('other').signingKey.publicKey }, local)).toThrow('different run');
    expect(() => checkRunBundle(p.bundle, { ...expected, description: { ...p.description, answer_bytes: 100 } }, local)).toThrow('different run');
    expect(() => checkRunBundle(p.bundle, { ...expected, runner: { ...identity, codeHash: 'ef'.repeat(32) } }, local)).toThrow('different run');
    expect(() => checkRunBundle({ ...p.bundle, report_data: '00'.repeat(64) } as RunBundle, expected, local)).toThrow('report data');
    // A bundle that merely claims to be real is not accepted without report data from a verified quote.
    const claimed = { ...p.bundle, simulated: false, quote: 'not-a-verified-quote' } as RunBundle;
    expect(() => checkRunBundle(claimed, expected, { now: clock })).toThrow('Verify the quote first');
    expect(() => checkRunBundle(claimed, expected, { now: clock, verifiedReportData: '00'.repeat(64) })).toThrow('report data');
    expect(checkRunBundle(claimed, expected, { now: clock, verifiedReportData: p.bundle.report_data })).toEqual({ simulated: false });
    // The runner itself refuses code that does not match the description it was given.
    expect(() => f.core.prepare({ description: { ...p.description, run_id: 'other-run' }, code: COUNT + ' ' })).toThrow('does not match');
  });

  it('uses each run once, on the trace version it was prepared for, with a short grant naming the run key', async () => {
    const f = fixture(), r = await f.ask();
    let shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const nonce = randomBytes(32).toString('hex');
    const p = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    const wrap = await rewrapTraceKey(f.trace().meta, ownerDid, 'a-note', owner.privateKey, p.public_key);
    const approve = { action: 'approve', request_id: r.request_id, revision: r.revision, run_id: p.description.run_id, wrap };
    await expect(f.call(author, { ...approve, delegation: await grant(readerDid(testWallet('other').signingKey.compressedPublicKey)) })).rejects.toThrow('15 minutes');
    await expect(f.call(author, { ...approve, delegation: await grant(readerDid(p.public_key), { seconds: 3600 }) })).rejects.toThrow('15 minutes');
    await expect(f.call(author, { ...approve, delegation: await grant(readerDid(p.public_key), { folder: 'router/' }) })).rejects.toThrow('15 minutes');
    await expect(f.call(stranger, { ...approve, delegation: await grant(readerDid(p.public_key)) })).rejects.toThrow('not found');
    // The trace changes after the run was prepared: the runner refuses it, and the run is spent.
    f.replaceTrace(TRACE + '\nmore');
    await expect(f.call(author, { ...approve, delegation: await grant(readerDid(p.public_key)) })).rejects.toThrow('not the version');
    await expect(f.call(author, { ...approve, delegation: await grant(readerDid(p.public_key)) })).rejects.toThrow('Prepare this run first');
    await expect(f.core.run({ run_id: p.description.run_id, delegation: await grant(readerDid(p.public_key)), wrap, host })).rejects.toThrow('already run');
    // A fresh run on the new version works, and its grant cannot be replayed.
    shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const second = await ownerRuns(f, shown);
    expect(second.result).toMatchObject({ ok: true });
    await expect(f.core.run({ run_id: second.prepared.description.run_id, delegation: second.delegation, wrap: second.wrap, host })).rejects.toThrow('already run');
    // A run that is never approved expires.
    const third = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    f.advance(10 * 60_000 + 1);
    await expect(f.call(author, { action: 'approve', request_id: r.request_id, revision: r.revision, run_id: third.description.run_id, wrap,
      delegation: await grant(readerDid(third.public_key)) })).rejects.toThrow('expired');
  });

  it('lets the owner tell a result the attested run signed from one anyone could seal to their key', async () => {
    const f = fixture(), r = await f.ask();
    const { prepared, answered } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    const forged = sealResult({ ok: true, answer: 'made up by someone else' }, prepared.description);
    expect(() => checkRunResult(forged, answered.answer.signature, prepared.description, prepared.public_key)).toThrow('not signed by the attested run');
    expect(() => checkRunResult(answered.answer.sealed, answered.answer.signature, prepared.description, testWallet('other').signingKey.publicKey)).toThrow('not signed by the attested run');
    expect(() => checkRunResult(answered.answer.sealed, 'garbage', prepared.description, prepared.public_key)).toThrow('no valid signature');
    expect(answered.answer.run_public_key).toBe(prepared.public_key);
    expect(r.state).toBe('pending');
  });

  it('seals app errors to the owner, shows the requester nothing before release, and checks every release', async () => {
    const f = fixture(), r = await f.ask({ code: 'function analyze(t) { throw new Error(t.split("\\n").pop()) }', purpose: 'Leak through an error' });
    const shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const { answered, result } = await ownerRuns(f, shown);
    expect(result).toEqual({ ok: false, error: 'The app failed: Error: api key: sk-secret' });
    expect(JSON.stringify(answered)).not.toContain('sk-secret');
    expect(JSON.stringify(await f.call(agent, { action: 'status', request_id: r.request_id }))).not.toContain('sk-secret');
    expect(await f.call(agent, { action: 'status', request_id: r.request_id })).toMatchObject({ state: 'pending' });
    const d = answered.answer.description, base = { action: 'release', request_id: r.request_id, revision: r.revision, run_id: d.run_id };
    const good = sealForRequester('released text', d, requesterKey.signingKey.compressedPublicKey);
    await expect(f.call(author, { ...base, run_id: 'another-run', ...good })).rejects.toThrow('no answer from that run');
    const toOwner = sealForRequester('x', d, owner.signingKey.compressedPublicKey);
    await expect(f.call(author, { ...base, sealed: { ...toOwner.sealed, meta: { ...toOwner.sealed.meta, wraps: { owner: toOwner.sealed.meta.wraps.reader } } } })).rejects.toThrow('requester alone');
    await expect(f.call(agent, { ...base, ...good })).rejects.toThrow('not found');
    f.restrict();
    await expect(f.call(author, { ...base, ...good })).rejects.toThrow('no longer');
  });

  it('drops an answer whose request was declined, withdrawn or replaced while the app ran', async () => {
    const f = fixture(), r = await f.ask();
    f.whileRunning(() => f.call(author, { action: 'decline', request_id: r.request_id, revision: r.revision }));
    const { answered } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]).catch(e => ({ answered: null, error: e })) as any;
    const after = await f.call(author, { action: 'status', request_id: r.request_id });
    expect(after.state).toBe('declined');
    expect(after).not.toHaveProperty('answer');
    if (answered) expect(answered).not.toHaveProperty('answer');
    const w = fixture(), asked = await w.ask();
    w.whileRunning(() => w.call(agent, { action: 'withdraw', request_id: asked.request_id }));
    await ownerRuns(w, (await w.call(author, { action: 'inbox' })).requests[0]).catch(() => null);
    expect(await w.call(author, { action: 'status', request_id: asked.request_id })).not.toHaveProperty('answer');
    expect((await w.call(agent, { action: 'status', request_id: asked.request_id })).state).toBe('withdrawn');
    const g = fixture(), first = await g.ask();
    g.whileRunning(() => g.store.change(first.request_id, current => ({ ...current!, revision: 'replaced', app: { ...current!.app!, code: COUNT + ' ' } })));
    await ownerRuns(g, (await g.call(author, { action: 'inbox' })).requests[0]).catch(() => null);
    const replaced = await g.call(author, { action: 'status', request_id: first.request_id });
    expect(replaced.state).toBe('pending');
    expect(replaced).not.toHaveProperty('answer');
  });

  it('hands the released answer back through Router to a requester who gave no key, and says so to their next session once', async () => {
    const f = fixture(), r = await f.askViaRouter();
    expect(r).toMatchObject({ state: 'pending', answer_via: 'router' });
    expect(r).not.toHaveProperty('answer_public_key');
    const shown = (await f.call(author, { action: 'inbox' })).requests[0];
    expect(shown).toMatchObject({ answer_via: 'router', answer_public_key: f.custody!.publicKey });
    const { answered, result } = await ownerRuns(f, shown);
    expect(await f.store.decidedFor(agent.keyHash)).toHaveLength(0);
    const { sealed } = sealForRequester((result as any).answer, answered.answer.description, shown.answer_public_key);
    await f.call(author, { action: 'release', request_id: r.request_id, revision: r.revision, run_id: answered.answer.run_id, sealed });
    // Stored sealed: the answer's text appears only in the requester's own view.
    const stored = await f.store.get(r.request_id);
    expect(JSON.stringify(stored)).not.toContain('Bash');
    expect((await f.store.decidedFor(agent.keyHash)).map(x => x.id)).toEqual([r.request_id]);
    const seen = await f.call(agent, { action: 'status', request_id: r.request_id });
    expect(seen).toMatchObject({ state: 'released', answer_via: 'router', answer_text: '{"Read":2,"Bash":1}' });
    expect(seen).not.toHaveProperty('answer');
    expect(await f.store.decidedFor(agent.keyHash)).toHaveLength(0);
    expect((await f.call(author, { action: 'status', request_id: r.request_id })).answer_via).toBe('router');
  });

  it('lists a declined request for its requester until they look, and needs a key where Router cannot hold answers', async () => {
    const f = fixture(), r = await f.askViaRouter();
    await f.call(author, { action: 'decline', request_id: r.request_id, revision: r.revision });
    expect((await f.store.decidedFor(agent.keyHash)).map(x => x.state)).toEqual(['declined']);
    expect(await f.call(agent, { action: 'status', request_id: r.request_id })).toMatchObject({ state: 'declined' });
    expect(await f.store.decidedFor(agent.keyHash)).toHaveLength(0);
    const plain = fixture({ withCustody: false });
    await expect(plain.askViaRouter()).rejects.toThrow('cannot hand answers back');
    expect((await plain.ask()).answer_via).toBe('your-key');
  });

  it('lets the owner withhold an answer, which the requester sees as declined', async () => {
    const f = fixture(), r = await f.ask();
    await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    await expect(f.call(author, { action: 'withhold', request_id: r.request_id, revision: 'stale' })).rejects.toThrow('changed');
    expect(await f.call(author, { action: 'withhold', request_id: r.request_id, revision: r.revision })).toMatchObject({ state: 'withheld' });
    const seen = await f.call(agent, { action: 'status', request_id: r.request_id });
    expect(seen.state).toBe('declined');
    expect(seen).not.toHaveProperty('answer');
    // Asking again starts a new request.
    expect((await f.ask()).state).toBe('pending');
  });

  it('requires the current audience to ask, to run and to release', async () => {
    const f = fixture(), r = await f.ask();
    f.restrict();
    await expect(f.ask()).rejects.toThrow('not found');
    await expect(f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce: 'aa'.repeat(32) })).rejects.toThrow('no longer');
    expect(await f.call(author, { action: 'decline', request_id: r.request_id, revision: r.revision })).toMatchObject({ state: 'declined' });
    await expect(f.call(agent, { action: 'status', request_id: r.request_id })).rejects.toThrow('not found');
  });

  it('keeps requests made before apps answerable only by declining', async () => {
    const f = fixture(), id = 'ee'.repeat(32);
    await f.store.change(id, () => ({ id, revision: 'old', entryId: 'a-note', owner: '@author', requester: agent.keyHash, requesterName: agent.pseudonym,
      publicKey: requesterKey.signingKey.compressedPublicKey, created: clock, state: 'pending' }) as any);
    const legacy = await f.call(agent, { action: 'status', request_id: id });
    expect(legacy).toMatchObject({ state: 'pending', reader_public_key: requesterKey.signingKey.compressedPublicKey });
    await expect(f.call(author, { action: 'approve', request_id: id, revision: 'old', delegation: 'x' })).rejects.toThrow('before apps');
    await expect(f.call(author, { action: 'prepare', request_id: id, revision: 'old', nonce: 'aa'.repeat(32) })).rejects.toThrow('before apps');
    expect(await f.call(author, { action: 'decline', request_id: id, revision: 'old' })).toMatchObject({ state: 'declined' });
  });
});

describe('trace apps that ask a model', () => {
  it('runs an app that asks twice through the attested provider, seals what it called to the owner, and keeps the key out of every view', async () => {
    const f = fixture(), r = await f.askModel();
    expect(r).toMatchObject({ state: 'pending', model: DECL });
    const shown = (await f.call(author, { action: 'inbox' })).requests[0];
    expect(shown.model.declaration).toEqual(DECL);
    expect(shown.model.lines).toContain("reader pen name's account at RedPill shows when the calls are made and how many tokens they use, so reader pen name can tell that the app has run.");
    expect(shown.model.lines.join(' ')).toContain('may send parts of the trace to the model z-ai/glm-5.3 at RedPill');
    // Stored sealed: the key is in no view and not in the stored record as plain text.
    expect(JSON.stringify(await f.store.get(r.request_id))).not.toContain(MODEL_KEY);
    expect(JSON.stringify(shown)).not.toContain(MODEL_KEY);
    const { prepared, answered, result } = await ownerRuns(f, shown);
    expect(prepared.description).toMatchObject({ v: 2 });
    expect(Object.keys(prepared.description).sort()).toEqual([...V1_FIELDS, 'model_hash'].sort());
    expect(f.provider.sent.map(s => s.body.messages[0].content)).toEqual(['Which tools? 4 lines', 'Shorter: reply 1 to 20 bytes']);
    expect(f.provider.sent.every(s => s.authorization === `Bearer ${MODEL_KEY}` && s.body.model === 'z-ai/glm-5.3' && s.body.max_tokens === 100)).toBe(true);
    expect(result).toEqual({ ok: true, answer: 'model: reply 1 to 20 bytes / reply 2 to 28 bytes',
      model: { provider: 'redpill', model: 'z-ai/glm-5.3', calls: 2, release: 'ee'.repeat(32), verdict: 'VERIFIED (simulated)', receipts: ['receipt-1', 'receipt-2'] } });
    // The key went to the runner and nowhere else Router answers.
    expect(f.runnerCalls.find(c => c.run).run.model_key).toBe(MODEL_KEY);
    expect(f.runnerCalls.find(c => c.prepare).prepare.model).toEqual(DECL);
    const views = [answered, await f.call(author, { action: 'status', request_id: r.request_id }), await f.call(agent, { action: 'status', request_id: r.request_id }), f.notices];
    for (const view of views) expect(JSON.stringify(view)).not.toContain(MODEL_KEY);
    const { sealed } = sealForRequester((result as any).answer, answered.answer.description, requesterKey.signingKey.compressedPublicKey);
    await f.call(author, { action: 'release', request_id: r.request_id, revision: r.revision, run_id: answered.answer.run_id, sealed });
    const stored = await f.store.get(r.request_id);
    expect(stored!.state).toBe('released');
    expect(stored).not.toHaveProperty('modelKey');
    expect(stored!.model).toEqual(DECL);
  });

  it('keeps the version 1 run description, the runner call and the sealed result exactly as before for an app without a model', async () => {
    const f = fixture(), r = await f.ask();
    const shown = (await f.call(author, { action: 'inbox' })).requests[0];
    expect(shown.model).toEqual({ declaration: null, lines: ['This app cannot call a model or reach the network.'] });
    expect(r).not.toHaveProperty('model');
    const { prepared, answered } = await ownerRuns(f, shown);
    expect(Object.keys(prepared.description).sort()).toEqual(V1_FIELDS);
    expect(prepared.description.v).toBe(1);
    expect(Object.keys(f.runnerCalls.find(c => c.prepare).prepare).sort()).toEqual(['code', 'description', 'nonce']);
    expect(Object.keys(f.runnerCalls.find(c => c.run).run).sort()).toEqual(['delegation', 'host', 'run_id', 'wrap']);
    const plain = openResult(answered.answer.sealed, answered.answer.description, owner.privateKey);
    expect(plain).toEqual({ ok: true, answer: '{"Read":2,"Bash":1}' });
    expect(f.provider.connects()).toBe(0);
  });

  it('refuses a declaration that is malformed, names a provider that is not attested, or comes without a usable key', async () => {
    const f = fixture();
    const refused = async (input: Parameters<typeof f.askModel>[0], expected: string) => {
      const error = await f.askModel(input).catch(e => e);
      expect(error.message).toContain(expected);
      expect(error.message).not.toContain(MODEL_KEY);
    };
    await refused({ model: { ...DECL, endpoint: 'https://elsewhere.example' } }, 'unknown field: endpoint');
    await refused({ model: { ...DECL, provider: 'openai' } }, 'Only attested model providers are accepted: redpill or tinfoil.');
    await refused({ model: { ...DECL, calls: 9 } }, 'between 1 and 8');
    await refused({ key: null }, 'needs model_key');
    await refused({ key: 'short' }, 'needs model_key');
    await refused({ key: `${MODEL_KEY} ${MODEL_KEY}` }, 'needs model_key');
    await refused({ model: null }, 'model_key goes only with a model declaration');
    await refused({ model: { ...DECL, provider: 'tinfoil' } }, 'does not run apps that call Tinfoil yet');
    for (const plain of [fixture({ models: [] }), fixture({ withVault: false })]) {
      const error = await plain.askModel().catch(e => e);
      expect(error.message).toBe('This server does not run apps that call a model yet. Send the app without a model declaration.');
    }
    expect((await f.call(author, { action: 'inbox' })).requests).toHaveLength(0);
  });

  it('answers a repeated request the same way before and after the run, and needs a withdrawal to change the declaration or key', async () => {
    const f = fixture(), r = await f.askModel();
    const before = { retry: await f.askModel(), status: await f.call(agent, { action: 'status', request_id: r.request_id }),
      swap: await f.askModel({ key: MODEL_KEY + 'x' }).catch(e => e.message), more: await f.askModel({ model: { ...DECL, calls: 3 } }).catch(e => e.message) };
    await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    const after = { retry: await f.askModel(), status: await f.call(agent, { action: 'status', request_id: r.request_id }),
      swap: await f.askModel({ key: MODEL_KEY + 'x' }).catch(e => e.message), more: await f.askModel({ model: { ...DECL, calls: 3 } }).catch(e => e.message) };
    expect(after).toEqual(before);
    expect(before.swap).toContain('Withdraw it first');
    expect(before.swap).not.toContain(MODEL_KEY);
    expect(f.notices).toHaveLength(1);
  });

  it("drops the requester's key when the request is declined, withheld or withdrawn, and when a new request replaces it", async () => {
    const declined = fixture(), a = await declined.askModel();
    expect((await declined.store.get(a.request_id))!.modelKey).toBeDefined();
    await declined.call(author, { action: 'decline', request_id: a.request_id, revision: a.revision });
    expect(await declined.store.get(a.request_id)).not.toHaveProperty('modelKey');

    const withdrawn = fixture(), b = await withdrawn.askModel();
    await withdrawn.call(agent, { action: 'withdraw', request_id: b.request_id });
    expect(await withdrawn.store.get(b.request_id)).not.toHaveProperty('modelKey');

    const withheld = fixture(), c = await withheld.askModel();
    await ownerRuns(withheld, (await withheld.call(author, { action: 'inbox' })).requests[0]);
    await withheld.call(author, { action: 'withhold', request_id: c.request_id, revision: c.revision });
    expect(await withheld.store.get(c.request_id)).not.toHaveProperty('modelKey');
    // Asking again without a model replaces the request, and holds no key.
    await withheld.ask();
    expect(await withheld.store.get(c.request_id)).not.toHaveProperty('modelKey');
    expect((await withheld.store.get(c.request_id))!.model).toBeUndefined();
    // And asking again with a new key holds only that one.
    await withheld.call(agent, { action: 'withdraw', request_id: c.request_id });
    await withheld.askModel({ key: MODEL_KEY + '-new' });
    const shown = (await withheld.call(author, { action: 'inbox' })).requests[0];
    await ownerRuns(withheld, shown);
    expect(withheld.runnerCalls.filter(x => x.run).map(x => x.run.model_key)).toEqual([MODEL_KEY, MODEL_KEY + '-new']);
  });

  it('seals what went wrong to the owner when the app goes beyond its declaration', async () => {
    const keepsAsking = { purpose: 'Ask three times', code: 'function analyze(t, i, replies) { return { ask: "again " + replies.length } }' };
    const f = fixture();
    await f.askModel({ app: keepsAsking });
    const { result } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    expect(result).toMatchObject({ ok: false, error: 'The app tried to call the model more than the 2 times it declared.', model: { calls: 2, receipts: ['receipt-1', 'receipt-2'] } });
    expect(f.provider.sent).toHaveLength(2);

    const tooLong = { purpose: 'Send the whole trace', code: 'function analyze(trace) { return { ask: trace + "x".repeat(3000) } }' };
    const g = fixture();
    await g.askModel({ app: tooLong });
    const sent = await ownerRuns(g, (await g.call(author, { action: 'inbox' })).requests[0]);
    expect(sent.result).toMatchObject({ ok: false, error: 'The app tried to send more than the 2 KB it declared.', model: { calls: 0, release: null, receipts: [] } });
    expect(g.provider.sent).toHaveLength(0);
    expect(g.provider.connects()).toBe(0);
    // A provider's own error text, which could quote the prompt, never reaches the owner either.
    const h = fixture({ provider: fakeProvider(prompt => new Response(`cannot process: ${prompt}`, { status: 400 })) });
    await h.askModel();
    const failed = await ownerRuns(h, (await h.call(author, { action: 'inbox' })).requests[0]);
    expect(failed.result).toMatchObject({ ok: false, error: 'RedPill refused the call (status 400).', model: { calls: 1 } });
  });

  it('stops a run at its deadline, and says so to the owner with what was already sent', async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture({ provider: fakeProvider(undefined, () => f.advance(150_000)) });
    await f.askModel();
    const { result } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    expect(result).toMatchObject({ ok: false, error: 'The run ran out of time (140 seconds).', model: { calls: 1 } });
    expect(f.provider.sent).toHaveLength(1);
    // Each call gets at most the time left, and the run ends at the deadline even while the app still has steps to go.
    let g: ReturnType<typeof fixture>;
    g = fixture({ runMs: 100_000, provider: fakeProvider(undefined, () => g.advance(60_000)) });
    await g.askModel();
    const second = await ownerRuns(g, (await g.call(author, { action: 'inbox' })).requests[0]);
    expect(second.result).toMatchObject({ ok: false, error: 'The run ran out of time (100 seconds).', model: { calls: 2 } });
    expect(g.provider.sent).toHaveLength(2);
  });

  it("lets the owner see that a run would allow different model use than the request they were shown", async () => {
    const f = fixture(), r = await f.askModel(), shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const nonce = randomBytes(32).toString('hex');
    const p = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    const expected = { description: p.description, code: shown.app.code, publicKey: p.public_key, nonce, runner: identity, model: DECL,
      request: { request_id: shown.request_id, revision: shown.revision, entry_id: shown.entry_id, answer_key: shown.answer_public_key }, own: mine(f) };
    const local = { allowSimulated: true, now: clock };
    expect(checkRunBundle(p.bundle, expected, local)).toEqual({ simulated: true });
    for (const model of [null, undefined, { ...DECL, calls: 1 }, { ...DECL, provider: 'tinfoil' as const }])
      expect(() => checkRunBundle(p.bundle, { ...expected, model }, local)).toThrow('different model use');
    expect(() => checkRunBundle(p.bundle, { ...expected, model: { ...DECL, extra: 1 } as any }, local)).toThrow('malformed');
    // And a request without a model cannot be run under a version 2 description.
    const g = fixture(), plain = await g.ask(), shownPlain = (await g.call(author, { action: 'inbox' })).requests[0];
    const q = await g.call(author, { action: 'prepare', request_id: plain.request_id, revision: plain.revision, nonce });
    expect(() => checkRunBundle(q.bundle, { ...expected, code: shownPlain.app.code, description: q.description, publicKey: q.public_key, model: DECL,
      request: { request_id: shownPlain.request_id, revision: shownPlain.revision, entry_id: shownPlain.entry_id, answer_key: shownPlain.answer_public_key }, own: mine(g) }, local)).toThrow('different model use');
  });

  it('refuses to prepare when the runner cannot reach the provider, before anything is granted', async () => {
    const f = fixture({ models: ['redpill', 'tinfoil'], connectors: ['redpill'] }), r = await f.askModel({ model: { ...DECL, provider: 'tinfoil' } });
    await expect(f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce: 'aa'.repeat(32) }))
      .rejects.toThrow('This runner cannot reach the declared model provider, so the run was not prepared.');
    expect(f.runnerCalls.filter(c => c.run)).toHaveLength(0);
  });
});

describe('a requester\'s key pays for one run, which ends by its deadline', () => {
  it('drops the key when a run is claimed, so a second prepare or approve cannot call the model', async () => {
    const f = fixture(), r = await f.askModel();
    let shown = (await f.call(author, { action: 'inbox' })).requests[0];
    const first = await ownerRuns(f, shown);
    expect(first.result).toMatchObject({ ok: true, model: { calls: 2 } });
    expect(await f.store.get(r.request_id)).not.toHaveProperty('modelKey');
    shown = (await f.call(author, { action: 'inbox' })).requests[0];
    await expect(ownerRuns(f, shown)).rejects.toThrow('a request pays for at most one run. Decline it; they can ask again.');
    expect(f.provider.sent).toHaveLength(2);
    // The requester still gets the same answer to the same request after the run.
    expect((await f.askModel()).revision).toBe(r.revision);
  });

  it('drops the key when the run is claimed even if the run then fails, and gives it to only one of two approvals', async () => {
    const f = fixture(), r = await f.askModel();
    const nonce = randomBytes(32).toString('hex');
    const p = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    const wrap = await rewrapTraceKey(f.trace().meta, ownerDid, 'a-note', owner.privateKey, p.public_key);
    const delegation = await grant(readerDid(p.public_key));
    const approve = { action: 'approve', request_id: r.request_id, revision: r.revision, run_id: p.description.run_id, delegation, wrap };
    f.replaceTrace(TRACE + '\nchanged');
    const both = await Promise.allSettled([f.call(author, approve), f.call(author, approve)]);
    expect(both.every(x => x.status === 'rejected')).toBe(true);
    expect(f.runnerCalls.filter(c => c.run)).toHaveLength(1);
    expect(await f.store.get(r.request_id)).not.toHaveProperty('modelKey');
    await expect(f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce })).rejects.toThrow('at most one run');
    expect(f.provider.sent).toHaveLength(0);
  });

  it('refuses to approve a prepared run once its provider has been turned off', async () => {
    const f = fixture(), r = await f.askModel();
    const nonce = randomBytes(32).toString('hex');
    const p = await f.call(author, { action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
    f.models.splice(0);
    const wrap = await rewrapTraceKey(f.trace().meta, ownerDid, 'a-note', owner.privateKey, p.public_key);
    await expect(f.call(author, { action: 'approve', request_id: r.request_id, revision: r.revision, run_id: p.description.run_id, delegation: await grant(readerDid(p.public_key)), wrap }))
      .rejects.toThrow('does not run apps that call a model');
    expect(f.runnerCalls.filter(c => c.run)).toHaveLength(0);
    expect((await f.store.get(r.request_id))!.modelKey).toBeDefined();
  });

  for (const stall of ['connect', 'fetch', 'confirm', 'close'] as const) {
    it(`settles by the deadline when the provider never answers at ${stall}, and frees the runner's slots`, async () => {
      const f = fixture({ runMs: 400, closeMs: 100, settleMs: 300, provider: fakeProvider(undefined, undefined, stall) });
      await f.askModel();
      const started = Date.now();
      const { prepared, result } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.ok).toBe(stall === 'close');
      if (!result.ok) expect(result.error).toMatch(/^(The run ran out of time \(0\.4 seconds\)\.|RedPill could not be verified, so nothing was sent to it\.|The call to RedPill did not complete\.|RedPill's signed receipt for the call did not verify, so its reply was not used\.)$/);
      // Both of the runner's slots are free again.
      for (const id of ['again-1', 'again-2']) f.core.prepare({ description: { ...prepared.description, run_id: id }, code: MODEL_APP.code, model: DECL });
      expect(() => f.core.prepare({ description: { ...prepared.description, run_id: 'again-3' }, code: MODEL_APP.code, model: DECL })).toThrow('busy');
    });
  }

  it('stops a run whose provider ignores every bound, a little after the deadline, and seals what it had called', async () => {
    // A close that takes longer than the run has: only the runner's own stop ends it.
    const f = fixture({ runMs: 300, closeMs: 60_000, settleMs: 200, provider: fakeProvider(undefined, undefined, 'close') });
    await f.askModel();
    const started = Date.now();
    const { result } = await ownerRuns(f, (await f.call(author, { action: 'inbox' })).requests[0]);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result).toMatchObject({ ok: false, error: 'The run ran out of time (0.3 seconds).', model: { calls: 2 } });
  });
});
