// Owner side of the sub-container test (subhost/README.md).
//
// 1. Asks the host for a fresh binding quote and checks it on this machine:
//    TDX signature (Phala's verifier), approved OS, the measured compose file is
//    this checkout's template apart from Router's image versions, and the quote
//    commits to the container's public key, its code hash and our nonce.
// 2. Only then grants that key read access to one TinyCloud folder, for a short
//    time, and asks the container to read one file with it. The container
//    answers with the file's size and SHA-256, never its contents.
// 3. With --revoke, revokes the grant and shows the container can no longer read.
//
//   node scripts/subhost-grant.mjs --url https://<app-id>-8091.dstack-pha-prod9.phala.network --new-owner
//   node scripts/subhost-grant.mjs --url ... --owner-key-file <file holding a 0x key> [--prefix subhost-test]
//     [--folder subhost/] [--file hello.txt] [--minutes 30] [--check-only] [--revoke] [--simulated]
//
// --new-owner makes a throwaway TinyCloud owner (a synthetic test account).
// --simulated skips the TDX signature check, for a local run against subhost/dev/fake-dstack.mjs
// (with --approved-file subhost/dev/approved-local.json).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeAddress, Wallet } from 'ethers';
import { TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
import { verifyBundle } from '../../subhost/verify.mjs';
import { probeSpec } from '../../subhost/embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const flag = name => args.includes(`--${name}`);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i === -1 ? fallback : args[i + 1]; };

const url = (option('url') || '').replace(/\/+$/, '');
if (!/^https?:\/\//.test(url)) { console.error('Usage: --url <host endpoint> (see the header of this file)'); process.exit(2); }
const tinycloudHost = option('tinycloud-host', 'https://tee.node.tinycloud.xyz');
const folder = option('folder', 'subhost/');
const file = option('file', 'hello.txt');
const minutes = Number(option('minutes', '30'));
if (!/^[a-z0-9-]+\/$/.test(folder) || !/^[A-Za-z0-9._-]{1,64}$/.test(file) || !(minutes > 0 && minutes <= 24 * 60)) {
  console.error('--folder must look like name/, --file one file name, --minutes between 1 and 1440'); process.exit(2);
}

const step = text => console.log(`\n== ${text}`);
const ok = text => console.log(`  ok  ${text}`);
async function json(path, init = {}) {
  const res = await fetch(`${url}${path}`, { ...init, signal: AbortSignal.timeout(90_000) });
  const text = await res.text();
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${path}: HTTP ${res.status}, not JSON`); }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${value.error || ''}`);
  return value;
}

step('Fetch a fresh binding quote');
const nonce = randomBytes(32).toString('hex');
const bundle = await json(`/bundle?nonce=${nonce}`);
ok(`container generation ${bundle.container?.generation}, runtime ${bundle.runtime}`);

step('Check it on this machine');
const facts = verifyBundle(bundle, {
  nonce,
  spec: probeSpec(ROOT),
  template: readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8'),
  approved: JSON.parse(readFileSync(option('approved-file', join(ROOT, 'subhost/approved.json')), 'utf8')),
});
ok(`app ${facts.appId}`);
ok(`OS image ${facts.osImageHash} with today's approved boot measurements`);
ok(`compose file measured at boot (${facts.composeHash}) is this checkout's template; Router image ${facts.routerVersions.GIT_SHA}`);
ok(`pre-launch script ${facts.preLaunch.slice(0, 16)}... approved`);
ok(`container code hash ${facts.codeHash} matches subhost/probe.mjs and probe.base.json here`);
ok('report data commits to that code, the container\'s public key and our nonce');

if (flag('simulated')) {
  // Without a real quote, nothing stops this "container" from being anything: only throwaway owners.
  if (!flag('new-owner')) throw new Error('--simulated works only with --new-owner (a throwaway account)');
  console.log('  --  TDX signature NOT checked (--simulated)');
} else {
  const res = await fetch('https://cloud-api.phala.network/api/v1/attestations/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hex: bundle.quote }), signal: AbortSignal.timeout(60_000),
  });
  const v = await res.json();
  const body = v?.quote?.body || {};
  if (!res.ok || v.success !== true || v.quote?.verified !== true) throw new Error('Phala\'s verifier did not accept the quote');
  if (String(body.reportdata).replace(/^0x/, '') !== facts.quote.reportData || String(body.rtmr3).replace(/^0x/, '') !== facts.quote.rtmr3)
    throw new Error('Phala\'s verifier checked a different quote');
  ok(`TDX signature valid (Phala's verifier, record ${v.checksum})`);
}

const did = `did:pkh:eip155:1:${computeAddress(facts.publicKey)}`;
console.log(`\n  The container's key ${did} belongs to code ${facts.codeHash.slice(0, 16)}... in this CVM.`);
if (flag('check-only')) process.exit(0);

step('Grant it read access in TinyCloud');
let ownerKey;
if (flag('new-owner')) ownerKey = Wallet.createRandom().privateKey;
else {
  const keyFile = option('owner-key-file');
  if (!keyFile) { console.error('Pass --new-owner or --owner-key-file'); process.exit(2); }
  ownerKey = readFileSync(keyFile, 'utf8').trim();
}
if (!/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) throw new Error('owner key must be 0x followed by 64 hex characters');
const owner = new TinyCloudNode({ privateKey: ownerKey, host: tinycloudHost, prefix: option('prefix', 'subhost-test'), autoCreateSpace: true, enablePublicSpace: false });
await owner.signIn();
const content = `Synthetic file for the sub-container test, written ${new Date().toISOString()}.\n`;
const written = await owner.kv.put(`${folder}${file}`, content);
if (!written.ok) throw new Error(`could not write ${folder}${file}`);
const expectedSha = createHash('sha256').update(content).digest('hex');
ok(`owner ${owner.did} wrote ${folder}${file} (${Buffer.byteLength(content)} bytes)`);
const grant = await owner.createDelegation({ delegateDID: did, path: folder, actions: ['tinycloud.kv/get'], expiryMs: minutes * 60_000, includePublicSpace: false });
ok(`granted ${did} read access to ${folder} until ${new Date(grant.expiry).toISOString()}`);

step('Ask the container to read the file with the grant');
const used = await json('/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delegation: serializeDelegation(grant), path: file }) });
if (!used.ok) throw new Error(`the container could not read the file: ${used.error}`);
if (used.sha256 !== expectedSha) throw new Error('the container read different contents');
ok(`the container read ${used.bytes} bytes; SHA-256 matches what the owner wrote`);

if (flag('revoke')) {
  step('Revoke the grant and ask again');
  await owner.revokeDelegation(grant.cid);
  // Control: the file and the storage node are still there for the owner.
  const control = await owner.kv.get(`${folder}${file}`, { source: 'network' });
  if (!control.ok) throw new Error('control read by the owner failed after revocation; the result below would not prove anything');
  ok('control: the owner can still read the file');
  const after = await json('/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ delegation: serializeDelegation(grant), path: file }) });
  if (after.ok) throw new Error('the container could still read after revocation');
  if (!/revok|unauthori[sz]ed|forbidden|denied|not allowed|invalid (delegation|capability)|\b40[13]\b/i.test(after.error || ''))
    throw new Error(`the container's read failed, but not clearly because of the revocation: ${after.error}`);
  ok(`refused after revocation: ${after.error}`);
}
console.log('\nDone.');
