// The owner's side of trace requests that carry an app (docs/attested-trace-apps.md). Run it on
// your own machine; it needs your Router key and your storage key, and neither leaves it.
//
//   node scripts/trace-app-owner.mjs inbox             --router-key-file <file>
//   node scripts/trace-app-owner.mjs show <request>    --router-key-file <file>
//   node scripts/trace-app-owner.mjs run <request>     --router-key-file <file> --owner-key-file <file> [--trace-key-file <file>]
//   node scripts/trace-app-owner.mjs release <request> --router-key-file <file> --owner-key-file <file> [--trace-key-file <file>]
//   node scripts/trace-app-owner.mjs withhold <request> --router-key-file <file>
//
//   --router <url>          default https://router.teleport.computer
//   --tinycloud-host <url>  default https://tee.node.tinycloud.xyz
//   --approved-file <file>  default subhost/approved.json in this checkout
//   --trace-key-file <file> the key your traces are sealed to, when it is not your storage key
//   --records <dir>         where reviewed runs are remembered, default ~/.router/trace-apps
//   --simulated             local test servers only: accepts a simulated attestation; refuses any HTTPS Router
//
// `run` checks the enclave on this machine before granting anything. Phala's verifier must accept the
// TDX quote; the OS, the compose file and the deploy manifest must be approved (subhost/verify.mjs);
// the runner and sandbox must be the ones in this checkout; and the run must bind this request, the
// code shown here, the requester's key, the trace version read from your own storage, your key and a
// fresh nonce. Only then does it rewrap the trace's key to the run's key and grant that key a
// 10-minute read of that one trace. It checks that the result was signed by the attested run, prints
// the answer and remembers what you reviewed. Nothing reaches the requester until you `release`,
// which refuses unless the run, the answer and the requester's key are still the ones you reviewed.
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Wallet } from 'ethers';
import { TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
import { compressPublicKey, unwrapKey, wrapKey } from '../dist/trace-envelope.js';
import { checkRunBundle, checkRunResult, openResult, runHash, sealForRequester } from '../dist/trace-run.js';
import { readerDid } from '../dist/trace-access.js';
import { verifyRunBundle } from '../../subhost/verify.mjs';
import { runnerSpec, sandboxSpec } from '../../subhost/embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: v, positionals: [action, requestId] } = parseArgs({ allowPositionals: true, options: {
  'router-key-file': { type: 'string' }, 'owner-key-file': { type: 'string' }, 'trace-key-file': { type: 'string' },
  router: { type: 'string', default: 'https://router.teleport.computer' }, 'tinycloud-host': { type: 'string', default: 'https://tee.node.tinycloud.xyz' },
  'approved-file': { type: 'string' }, records: { type: 'string', default: join(homedir(), '.router', 'trace-apps') }, simulated: { type: 'boolean', default: false },
} });
const fail = message => { console.error(message); process.exit(2); };
if (!['inbox', 'show', 'run', 'release', 'withhold'].includes(action) || (action !== 'inbox' && !/^[a-f0-9]{64}$/.test(requestId || '')))
  fail('Use inbox, show <request>, run <request>, release <request> or withhold <request>; see the top of this file.');
if (!v['router-key-file']) fail('Give --router-key-file <file holding your Router key>.');
const base = new URL(v.router);
const local = base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname);
if (base.protocol !== 'https:' && !local) fail('Use an HTTPS Router.');
if (v.simulated && !local) fail('--simulated works only against a local test server.');
const routerKey = readFileSync(v['router-key-file'], 'utf8').trim();
const readKey = file => { const k = readFileSync(file, 'utf8').trim(); if (!/^0x[0-9a-fA-F]{64}$/.test(k)) fail(`${file} must hold 0x and 64 hex characters.`); return k; };
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

// Code, purposes and answers are written by other people. Show control and direction characters as
// escapes, so nothing can hide or rewrite what the terminal shows.
const HIDDEN = new RegExp('[' + [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x61c, 0x61c], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]]
  .map(([a, b]) => `\\u${a.toString(16).padStart(4, '0')}-\\u${b.toString(16).padStart(4, '0')}`).join('') + ']', 'g');
const visible = text => String(text).replace(HIDDEN, c => `\\u{${c.codePointAt(0).toString(16)}}`);
const quoted = (text, mark) => visible(text).replace(/^/gm, mark);

async function router(path, body) {
  const r = await fetch(new URL(path, base), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
    headers: { Authorization: 'Bearer ' + routerKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await r.json().catch(() => ({}));
  if (!r.ok) throw Error(value.error || `Router answered HTTP ${r.status}.`);
  return value;
}
const access = body => router('/api/trace-access', body);
const say = text => console.log(text);
const showApp = r => {
  say(`Request ${r.request_id} from ${visible(r.requester)} for note ${r.entry_id} (${r.state})`);
  say(`What it is for: ${r.app ? visible(r.app.purpose) : '(made before apps were required)'}`);
  if (r.app) say(`Code (hash ${r.app.hash}):\n${quoted(r.app.code, '  | ')}`);
};
const recordFile = id => join(v.records, `${id}.json`);

if (action === 'inbox') {
  const { requests } = await access({ action: 'inbox' });
  if (!requests.length) say('No requests are waiting.');
  for (const r of requests) say(`${r.request_id}  ${r.state.padEnd(8)}  ${visible(r.requester)}  ${r.entry_id}  ${r.app ? visible(r.app.purpose) : '(no app)'}`);
  process.exit(0);
}
const r = await access({ action: 'status', request_id: requestId });
if (action === 'show') { showApp(r); process.exit(0); }
if (action === 'withhold') {
  const done = await access({ action: 'withhold', request_id: r.request_id, revision: r.revision });
  say(`Withheld. The requester sees: declined. (${done.state})`);
  process.exit(0);
}

const ownerKey = v['owner-key-file'] ? readKey(v['owner-key-file']) : null;
const traceKey = v['trace-key-file'] ? readKey(v['trace-key-file']) : ownerKey;
if (!traceKey) fail('Give --owner-key-file (and --trace-key-file if your traces are sealed to another key).');

if (action === 'release') {
  let reviewed;
  try { reviewed = JSON.parse(readFileSync(recordFile(r.request_id), 'utf8')); } catch { fail('There is no reviewed run of this request on this machine. Run it first.'); }
  if (r.state !== 'answered' || !r.answer) fail(`There is no answer waiting to release (the request is ${r.state}).`);
  if (r.revision !== reviewed.revision || r.answer.run_id !== reviewed.run_id || compressPublicKey(r.answer_public_key) !== reviewed.answer_key
    || r.answer.description.answer_key !== reviewed.answer_key)
    fail('The request, its run or the requester\'s key changed since you reviewed it. Nothing was released; run it again.');
  checkRunResult(r.answer.sealed, r.answer.signature, r.answer.description, reviewed.run_public_key);
  const result = openResult(r.answer.sealed, r.answer.description, traceKey);
  if (!result.ok) fail(`The app failed, so there is nothing to release: ${visible(result.error)}\nWithhold it, or run it again.`);
  if (sha256(result.answer) !== reviewed.answer_sha256) fail('This is not the answer you reviewed. Nothing was released.');
  say(`This exact text will be sealed to the requester's key:\n${quoted(result.answer, '  > ')}`);
  const { sealed, answer_sha256 } = sealForRequester(result.answer, r.answer.description, reviewed.answer_key);
  await access({ action: 'release', request_id: r.request_id, revision: r.revision, run_id: r.answer.run_id, sealed, answer_sha256 });
  say(`Released. SHA-256 of the answer: ${answer_sha256}`);
  process.exit(0);
}

// run
if (!ownerKey) fail('Give --owner-key-file: your storage key signs the read grant.');
if (!r.app) fail('This request was made before apps were required. Decline it on the trace access page.');
showApp(r);
const owner = new TinyCloudNode({ privateKey: ownerKey, host: v['tinycloud-host'], prefix: 'router', autoCreateSpace: false, enablePublicSpace: false });
await owner.signIn();
try {
  // The trace's record, read from your own storage rather than taken from Router.
  const got = await owner.kv.get(`router/traces/${r.entry_id}/meta`, { source: 'network' });
  if (!got.ok || got.data?.data == null) fail('No trace is stored for this note in your storage.');
  const record = typeof got.data.data === 'string' ? JSON.parse(got.data.data) : got.data.data;
  if (record?.v !== 1 || record.entryId !== r.entry_id || !record.full?.sha256 || String(record.ownerDid).toLowerCase() !== owner.did.toLowerCase())
    fail('The trace record in your storage is not this note\'s, or not yours.');
  const sealedOwnerDid = record.sealedOwnerDid || record.ownerDid;
  const ownerPublicKey = compressPublicKey(new Wallet(traceKey).signingKey.publicKey);
  // The trace's key must open with yours before anything is asked of the enclave.
  const contentKey = unwrapKey(record.full.wraps?.owner, { ownerDid: sealedOwnerDid, entryId: r.entry_id }, 'full', 'owner', traceKey);

  say('\nPreparing a run and checking the enclave on this machine...');
  const nonce = randomBytes(32).toString('hex');
  const prepared = await access({ action: 'prepare', request_id: r.request_id, revision: r.revision, nonce });
  const own = { ownerDid: record.ownerDid, ownerPublicKey, ciphertextSha256: record.full.sha256 };
  const request = { request_id: r.request_id, revision: r.revision, entry_id: r.entry_id, answer_key: r.answer_public_key };
  if (v.simulated) {
    checkRunBundle(prepared.bundle, { description: prepared.description, code: r.app.code, publicKey: prepared.public_key, nonce, runner: prepared.runner, request, own },
      { allowSimulated: true });
    say('  --  SIMULATED attestation accepted (local test server only)');
  } else {
    const runner = runnerSpec(ROOT), sandbox = sandboxSpec(ROOT);
    if (!runner || !sandbox) fail('This checkout has no pinned runner and sandbox, so it cannot check a real run. Update it.');
    const facts = verifyRunBundle(prepared.bundle, {
      nonce, runHash: runHash(prepared.description), publicKey: prepared.public_key, runnerSpec: runner, sandboxSpec: sandbox,
      template: readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8'),
      approved: JSON.parse(readFileSync(v['approved-file'] || join(ROOT, 'subhost/approved.json'), 'utf8')),
    });
    say(`  ok  app ${facts.appId}; OS, compose file (Router ${facts.routerVersions.GIT_SHA}) and deploy manifest approved`);
    say(`  ok  runner and sandbox are this checkout's (code hash ${facts.codeHash.slice(0, 16)}...)`);
    const res = await fetch('https://cloud-api.phala.network/api/v1/attestations/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hex: prepared.bundle.quote }), signal: AbortSignal.timeout(60_000) });
    const verdict = await res.json().catch(() => ({}));
    const body = verdict?.quote?.body || {};
    if (!res.ok || verdict.success !== true || verdict.quote?.verified !== true) fail('Phala\'s verifier did not accept the quote. Nothing was granted.');
    if (String(body.reportdata).replace(/^0x/, '') !== facts.reportData || String(body.rtmr3).replace(/^0x/, '') !== facts.quote.rtmr3) fail('Phala\'s verifier checked a different quote. Nothing was granted.');
    say(`  ok  TDX signature valid (Phala's verifier, record ${verdict.checksum})`);
    checkRunBundle(prepared.bundle, { description: prepared.description, code: r.app.code, publicKey: prepared.public_key, nonce, runner: facts.runner, request, own },
      { verifiedReportData: facts.reportData });
  }
  say('  ok  the run binds this request, the code above, the requester\'s key, the trace in your storage, your key and a fresh nonce');

  const wrap = wrapKey(contentKey, { ownerDid: sealedOwnerDid, entryId: r.entry_id }, 'full', 'reader', prepared.public_key);
  contentKey.fill(0);
  const grant = await owner.createDelegation({ delegateDID: readerDid(prepared.public_key), path: `router/traces/${r.entry_id}/`,
    actions: ['tinycloud.kv/get'], expiryMs: 10 * 60_000, includePublicSpace: false });
  say('  ok  granted the run\'s key a 10-minute read of this one trace\n\nRunning...');
  const answered = await access({ action: 'approve', request_id: r.request_id, revision: r.revision, run_id: prepared.description.run_id,
    delegation: serializeDelegation(grant), wrap });
  if (!answered.answer || answered.answer.run_id !== prepared.description.run_id) fail(`No answer from this run was kept (the request is now ${answered.state}).`);
  checkRunResult(answered.answer.sealed, answered.answer.signature, prepared.description, prepared.public_key);
  const result = openResult(answered.answer.sealed, prepared.description, traceKey);
  if (result.ok) {
    mkdirSync(v.records, { recursive: true, mode: 0o700 });
    writeFileSync(recordFile(r.request_id), JSON.stringify({ request_id: r.request_id, revision: r.revision, run_id: prepared.description.run_id,
      run_public_key: prepared.public_key, answer_key: prepared.description.answer_key, answer_sha256: sha256(result.answer), reviewed_at: new Date().toISOString() }), { mode: 0o600 });
  }
  say('  ok  the result is signed by the attested run');
  say(result.ok ? `Answer (only you can see it so far):\n${quoted(result.answer, '  > ')}` : `The app failed (only you can see this): ${visible(result.error)}`);
  say(`\nTo send it: release ${r.request_id}   To refuse: withhold ${r.request_id}`);
} finally { await owner.signOut?.(); }
