// Walks through one trace request that carries an app, in this process, with synthetic keys and a
// synthetic trace. The attestation is simulated, and says so. Run after `npm run build`:
//
//   node scripts/trace-app-demo.mjs
//
// It shows what each side sees: the requester's agent, Router, the runner and the owner's tool.
import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Wallet } from 'ethers';
import { TCWSessionManager, prepareSession, completeSessionSetup, createDelegation, makeSpaceId } from '@tinycloud/node-sdk-wasm';
import { deserializeDelegation, serializeDelegation } from '@tinycloud/node-sdk';
import { traceAccess, traceRequestStore, readerDid } from '../dist/trace-access.js';
import { sealPart, unwrapKey, wrapKey } from '../dist/trace-envelope.js';
import { checkRunBundle, checkRunResult, openReleased, openResult, sealForRequester, simulatedRunnerClient, traceRunner, workerExecutor } from '../dist/trace-run.js';

const say = (who, text) => console.log(`\n[${who}] ${text}`);
const owner = Wallet.createRandom(), requesterKey = Wallet.createRandom(), host = 'https://storage.example';
const ownerDid = readerDid(owner.signingKey.compressedPublicKey), space = makeSpaceId(owner.address, 1, 'router');
const author = { keyHash: 'author', pseudonym: 'author pen name', user: { handle: 'author', tinycloud: { space, ownerDid } } };
const agent = { keyHash: 'requester', pseudonym: 'requester pen name', user: { handle: 'requester' } };
const entry = { id: 'demo-note', handle: 'author', pseudonym: author.pseudonym };

// The owner's capture client stored this trace, sealed to the owner.
const TRACE = ['{"type":"tool_use","name":"Read","input":{"file":"notes.md"}}', '{"type":"tool_use","name":"Bash","input":{"cmd":"npm test"}}',
  '{"type":"tool_use","name":"Read","input":{"file":"plan.md"}}', 'export API_KEY=sk-demo-secret'].join('\n');
const sealed = sealPart(gzipSync(Buffer.from(TRACE)), { ownerDid, entryId: entry.id }, 'full', { owner: owner.signingKey.compressedPublicKey });
const record = { v: 1, entryId: entry.id, ownerDid, full: { ...sealed.meta, chunks: 1 } };

// The runner: in production, in an enclave. Here, in this process, with a simulated attestation.
// The storage node serves the trace only to the key a grant names.
const runner = traceRunner({
  execute: workerExecutor(new URL('../dist/trace-app.js', import.meta.url).href),
  fetchTrace: async ({ delegation, privateKey }) => {
    if (deserializeDelegation(delegation).delegateDID.toLowerCase() !== readerDid(new Wallet(privateKey).signingKey.publicKey).toLowerCase()) throw Error('refused');
    return { record, ciphertext: sealed.ciphertext };
  },
});
const identity = { appId: '0'.repeat(40), name: 'trace-runner', codeHash: '0'.repeat(64) };
const router = traceAccess({ store: traceRequestStore(), host, getUser: async () => null,
  visible: async (id, who) => (id === entry.id && [author.keyHash, agent.keyHash].includes(who.keyHash) ? entry : null),
  runner: simulatedRunnerClient(runner, identity),
  traceInfo: async () => ({ ownerDid, ciphertextSha256: sealed.meta.sha256, ownerPublicKey: owner.signingKey.compressedPublicKey }),
  onRequest: n => say('Router → owner alert', `${n.requesterName} wants to run an app on the trace behind ${n.entryId}: "${n.purpose}"`) });

// 1. The requester's agent writes an app and asks.
const app = {
  purpose: 'Count which tools the agent called while writing this note',
  code: `function analyze(trace) {
  const counts = {};
  for (const line of trace.split('\\n')) {
    const m = line.match(/"name":"(\\w+)"/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return JSON.stringify(counts);
}`,
};
say('requester', 'sends a request with an app and a key for the answer.');
const asked = await router(agent, { action: 'request', entry_id: entry.id, app, answer_public_key: requesterKey.signingKey.compressedPublicKey });
console.log(`  state: ${asked.state}; app hash ${asked.app.hash.slice(0, 16)}…`);
try { await router(agent, { action: 'request', entry_id: entry.id, answer_public_key: requesterKey.signingKey.compressedPublicKey }); }
catch (e) { say('Router', `refuses a request without an app: "${e.message.slice(0, 80)}…"`); }

// 2. The owner's tool reads the request, prepares a run and checks its attestation against what it showed.
const shown = (await router(author, { action: 'inbox' })).requests[0];
say('owner', `reads the purpose ("${shown.app.purpose}") and the code:\n${shown.app.code.replace(/^/gm, '    ')}`);
const nonce = randomBytes(32).toString('hex');
const prepared = await router(author, { action: 'prepare', request_id: shown.request_id, revision: shown.revision, nonce });
const check = checkRunBundle(prepared.bundle, { description: prepared.description, code: shown.app.code, publicKey: prepared.public_key, nonce, runner: identity,
  request: { request_id: shown.request_id, revision: shown.revision, entry_id: shown.entry_id, answer_key: shown.answer_public_key },
  own: { ownerDid, ownerPublicKey: owner.signingKey.compressedPublicKey, ciphertextSha256: sealed.meta.sha256 } }, { allowSimulated: true });
say('owner', `checked the run against what the owner's side knows: this request, this code (hash ${prepared.description.app_hash.slice(0, 16)}…), the trace version in the owner's storage, the answer sealed to the owner's own key, and a fresh run key${check.simulated ? ' (SIMULATED attestation: local demo only)' : ''}.`);

// 3. The owner rewraps the trace key to the run key and grants a 10-minute read of this one trace.
// The owner's tool opens the trace's content key with the owner's key and wraps it to the run's key; the trace stays encrypted.
const contentKey = unwrapKey(sealed.meta.wraps.owner, { ownerDid, entryId: entry.id }, 'full', 'owner', owner.privateKey);
const wrap = wrapKey(contentKey, { ownerDid, entryId: entry.id }, 'full', 'reader', prepared.public_key);
contentKey.fill(0);
const delegation = await grant(readerDid(prepared.public_key));
const answered = await router(author, { action: 'approve', request_id: shown.request_id, revision: shown.revision, run_id: prepared.description.run_id, delegation, wrap });
say('Router', `holds only the sealed result (${answered.answer.sealed.data.length} base64 characters); it cannot read it.`);
const status = await router(agent, { action: 'status', request_id: shown.request_id });
say('requester', `sees state "${status.state}" and no answer yet.`);

// 4. The owner checks the attested run signed the result, opens the answer and releases exactly that text.
checkRunResult(answered.answer.sealed, answered.answer.signature, prepared.description, prepared.public_key);
const result = openResult(answered.answer.sealed, answered.answer.description, owner.privateKey);
say('owner', `opens the answer: ${JSON.stringify(result)}`);
const release = sealForRequester(result.answer, answered.answer.description, requesterKey.signingKey.compressedPublicKey);
await router(author, { action: 'release', request_id: shown.request_id, revision: shown.revision, run_id: answered.answer.run_id, ...release });

// 5. The requester opens what was released.
const released = await router(agent, { action: 'status', request_id: shown.request_id });
say('requester', `state "${released.state}"; opens the answer: ${openReleased(released.answer, released.run, requesterKey.privateKey, released.answer_sha256)}`);
console.log(`\nThe requester never received the trace. Its last line held a secret ("sk-demo-secret"); it appears nowhere in what Router or the requester saw: ${!JSON.stringify([asked, status, released, answered]).includes('sk-demo-secret')}.`);

async function grant(recipient) {
  const manager = new TCWSessionManager(), now = Math.floor(Date.now() / 1000) * 1000;
  try {
    const key = manager.createSessionKey('owner'), jwk = JSON.parse(manager.jwk(key));
    const prepared = prepareSession({ address: owner.address, chainId: 1, domain: 'router.example', spaceId: space, jwk,
      issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + 3600000).toISOString(), abilities: { kv: { 'router/': ['tinycloud.kv/get'] } } });
    const parent = completeSessionSetup({ ...prepared, signature: await owner.signMessage(prepared.siwe) });
    const session = { ...parent, jwk, spaceId: space, verificationMethod: parent.verificationMethod.split('#')[0] };
    const folder = `router/traces/${entry.id}/`, exp = now / 1000 + 600;
    const r = createDelegation(session, recipient, space, { kv: { [folder]: ['tinycloud.kv/get'] } }, exp, undefined);
    return serializeDelegation({ cid: r.cid, delegationHeader: { Authorization: r.delegation }, spaceId: space, path: folder, actions: ['tinycloud.kv/get'],
      resources: r.resources, expiry: new Date(exp * 1000), delegateDID: recipient, ownerAddress: owner.address, chainId: 1, host });
  } finally { manager.free(); }
}
