#!/usr/bin/env node
// An owner's side of Router insights: what each person's agent runs, under that person's own rules.
// It signs with the key that owns the person's TinyCloud storage; that key never leaves this machine.
// It trusts nothing Router says: it pins the enclave it checked, keeps the consent it signed, and checks
// every authorization and preview against those and against what this machine itself uploaded.
//
//   node scripts/insights-owner.mjs <command> [options]
//     enclave [--pin]                           check what the enclave says about itself; --pin remembers it
//     status                                    your consent as Router reports it, beside the one kept here
//     consent --triggers h1[,h2] [--groups g1,g2] [--days 30] [--yes]
//     requests                                  run requests that involve your posts
//     authorize <request_id> [--yes] [--unchecked-posts]
//     decline <request_id>
//     preview <run_id>                          open your sealed preview: your own answers and notes only
//     approve <run_id> [--yes] | veto <run_id> [--yes]
//
// Without --yes, signing commands only print what would be signed.
// Environment: ROUTER_URL (default https://router.teleport.computer), ROUTER_KEY or ROUTER_KEY_FILE (your Router key),
// OWNER_KEY_FILE (a file holding the 0x-hex private key that owns your storage),
// INSIGHTS_DIR (default ~/.router/insights: the enclave pin and your signed consent),
// CAPTURE_STATE (default ~/.router/traces/state.json: what capture-traces.mjs uploaded from this machine).
// Run from server/ after `npm run build`.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Wallet, computeAddress, verifyMessage } from 'ethers';
import { canonical } from '../dist/author-records.js';
import { consentMessage, authorizationMessage, approvalMessage, questionSha256 } from '../dist/insights-release.js';
import { openPreview, contributionCommitment } from '../dist/insights-enclave.js';
import { sha256Hex } from '../dist/trace-envelope.js';

const [command, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
  if (['--yes', '--pin', '--unchecked-posts'].includes(rest[i])) flags[rest[i].slice(2)] = true;
  else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else args.push(rest[i]);
}
const base = (process.env.ROUTER_URL || 'https://router.teleport.computer').replace(/\/$/, '');
const dir = process.env.INSIGHTS_DIR || join(homedir(), '.router', 'insights');
const pinPath = join(dir, 'enclave-pin.json'), consentPath = join(dir, 'consent.json');
const capturePath = process.env.CAPTURE_STATE || join(homedir(), '.router', 'traces', 'state.json');
const readJson = async path => JSON.parse(await readFile(path, 'utf8').catch(() => 'null'));
const writeJson = async (path, value) => { await mkdir(dir, { recursive: true }); await writeFile(path, JSON.stringify(value, null, 1) + '\n', { mode: 0o600 }); };
const routerKey = process.env.ROUTER_KEY || (process.env.ROUTER_KEY_FILE ? (await readFile(process.env.ROUTER_KEY_FILE, 'utf8')).trim() : '');
if (!command || command === 'help') { console.log((await readFile(new URL(import.meta.url), 'utf8')).split('\n').filter(l => l.startsWith('//')).join('\n')); process.exit(0); }
if (!routerKey && command !== 'enclave') throw new Error('Set ROUTER_KEY or ROUTER_KEY_FILE');
const ownerWallet = async () => {
  if (!process.env.OWNER_KEY_FILE) throw new Error('Set OWNER_KEY_FILE to the file holding the key that owns your storage');
  return new Wallet((await readFile(process.env.OWNER_KEY_FILE, 'utf8')).trim());
};
async function api(path, body) {
  const res = await fetch(base + path, body === undefined ? { signal: AbortSignal.timeout(60_000) } : {
    method: 'POST', signal: AbortSignal.timeout(120_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${routerKey}` }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}${json.error ? ` (${json.error})` : ''}`);
  return json;
}
const show = value => console.log(JSON.stringify(value, null, 2));
const needPin = async () => (await readJson(pinPath)) || (() => { throw new Error('No enclave pinned yet. Run `enclave`, check it, then `enclave --pin`.'); })();
const needConsent = async () => (await readJson(consentPath)) || (() => { throw new Error(`No consent kept in ${consentPath}. Sign one with \`consent\`.`); })();

/** What this tool can check about the enclave without trusting Router: that its report data commits to the key, program and policy it names. */
async function enclaveChecks() {
  const info = await api('/api/insights/release');
  const e = info.enclave || {};
  const identity = { release_key: e.release_key, app_id: e.app_id, program_sha256: e.program_sha256, upgrades: e.upgrades, min_people: e.min_people };
  const identitySha256 = sha256Hex(canonical(identity));
  const checks = {
    'program matches what Router offers': e.program_sha256 === info.program?.sha256,
    'report data commits to this key, program and policy': typeof e.report_data === 'string' && e.report_data.startsWith(identitySha256),
    'the signing address belongs to the release key': typeof e.signer === 'string' && typeof e.release_key === 'string' && computeAddress(e.release_key) === e.signer,
    'a TDX quote is attached': !!e.quote?.quote,
    'the quote carries that report data': typeof e.quote?.quote === 'string' && e.quote.quote.toLowerCase().includes(identitySha256),
  };
  return { identity, signer: e.signer, checks, compose_hash: e.quote?.compose_hash ?? null,
    still_to_check: 'Verify the quote itself (signature chain and TCB) with a DCAP verifier, and that compose_hash matches the published compose file for this enclave with a digest-pinned image.' };
}

if (command === 'enclave') {
  const r = await enclaveChecks();
  show({ ...r.identity, signer: r.signer, compose_hash: r.compose_hash, checks: r.checks, still_to_check: r.still_to_check });
  if (flags.pin) {
    const failed = Object.entries(r.checks).filter(([name, ok]) => !ok && !name.includes('quote'));
    if (failed.length) throw new Error('Not pinning: ' + failed.map(([name]) => name).join('; '));
    if (!r.checks['a TDX quote is attached']) console.error('Warning: no TDX quote. Pin this only for a local test enclave.');
    await writeJson(pinPath, { ...r.identity, signer: r.signer, compose_hash: r.compose_hash, pinned_at: new Date().toISOString() });
    console.log(`Pinned in ${pinPath}.`);
  }
}

else if (command === 'status') show({ router: await api('/api/insights/consent/status', {}), kept_here: await readJson(consentPath), pinned_enclave: await readJson(pinPath) });

else if (command === 'consent') {
  const pin = await needPin();
  const triggers = (flags.triggers || '').split(',').filter(Boolean).map(h => h.replace(/^@/, ''));
  const groups = flags.groups ? flags.groups.split(',').filter(Boolean) : ['insights-notes'];
  const days = flags.days ? Number(flags.days) : 30;
  const draft = await api('/api/insights/consent/draft', { triggers, groups, days });
  const p = draft.policy;
  // Sign only text this tool derives itself, for exactly what was asked, naming the enclave pinned here.
  const problems = [];
  if (draft.message !== consentMessage(p)) problems.push('the text does not match its policy');
  if (p.enclave.releaseKey !== pin.release_key || p.enclave.appId !== pin.app_id || canonical(p.enclave.upgrades) !== canonical(pin.upgrades)) problems.push('it names an enclave other than the one pinned');
  if (p.program.sha256 !== pin.program_sha256) problems.push('it names a program other than the pinned one');
  if (canonical(p.scope.groups) !== canonical(groups)) problems.push('its groups differ from the ones asked for');
  if (canonical(p.triggers.map(t => t.handle)) !== canonical(triggers)) problems.push('its requesters differ from the ones asked for');
  if (Math.abs(Date.parse(p.expiresAt) - Date.parse(p.issuedAt) - days * 86400_000) > 60_000) problems.push('its length differs from the one asked for');
  const wallet = await ownerWallet();
  if (`did:pkh:eip155:1:${wallet.address}`.toLowerCase() !== p.owner.did.toLowerCase()) problems.push('OWNER_KEY_FILE is not the key that owns this account\'s storage');
  if (problems.length) throw new Error('Not signing: ' + problems.join('; ') + '.');
  console.log(draft.message);
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign and save this consent)'); process.exit(0); }
  const signature = await wallet.signMessage(draft.message);
  const saved = await api('/api/insights/consent', { policy: p, signature });
  await writeJson(consentPath, { policy: p, signature, saved_at: new Date().toISOString() });
  show({ ...saved, kept_here: consentPath });
}

else if (command === 'requests') {
  const { requests } = await api('/api/insights/requests/mine', {});
  show(requests.map(r => ({ request_id: r.request_id, status: r.status, requested_by: r.created_by, question: r.params, your_posts: r.your_posts,
    your_answer: r.your_answer, deadline: r.deadline, answered: `${r.answered}/${r.people_asked}`, can_sign: !!r.to_sign?.body, note: r.to_sign?.error || null, run: r.run })));
}

else if (command === 'decline') show(await api('/api/insights/requests/answer', { request_id: args[0], answer: 'no' }));

else if (command === 'authorize') {
  const id = args[0];
  const pin = await needPin(), kept = await needConsent();
  const { requests } = await api('/api/insights/requests/mine', {});
  const r = requests.find(x => x.request_id === id);
  if (!r?.to_sign?.body) throw new Error(r?.to_sign?.error || 'Nothing to sign for that request.');
  const body = r.to_sign.body;
  // Check what is being signed against what is kept here, rather than trusting Router's summary of it.
  const problems = [];
  if (body.run !== id) problems.push('it names another request');
  if (body.enclave?.releaseKey !== pin.release_key || body.enclave?.appId !== pin.app_id) problems.push('it names an enclave other than the pinned one');
  if (body.policyId !== kept.policy.policyId) problems.push('it relies on a consent other than the one kept here');
  if (Date.parse(kept.policy.expiresAt) <= Date.now()) problems.push('the consent kept here has expired');
  if (!kept.policy.triggers.some(t => t.handle === r.created_by)) problems.push(`your consent does not name @${r.created_by} as a requester`);
  if (body.question.sha256 !== questionSha256(pin.program_sha256, body.question.template, body.question.params)) problems.push('its question hash does not match the question');
  // The posts must be ones this machine uploaded with an extraction copy, with the same ciphertext.
  const capture = await readJson(capturePath);
  for (const e of body.entries) {
    const mine = capture?.traces?.[e.entryId];
    if (mine?.extraction_sha256 === e.derivedSha256) continue;
    if (flags['unchecked-posts'] && r.your_posts.includes(e.entryId)) continue;
    problems.push(`${e.entryId} is not a post this machine uploaded an extraction copy for${capture ? '' : ` (no ${capturePath})`}`);
  }
  if (problems.length) throw new Error('Not signing: ' + problems.join('; ') + '.');
  console.log(authorizationMessage(body));
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign this authorization and answer yes)'); process.exit(0); }
  const wallet = await ownerWallet();
  show(await api('/api/insights/requests/answer', { request_id: id, answer: 'yes', authorization: { body, signature: await wallet.signMessage(authorizationMessage(body)) } }));
}

else if (command === 'preview' || command === 'approve' || command === 'veto') {
  const id = args[0];
  const pin = await needPin();
  const wallet = await ownerWallet();
  const did = `did:pkh:eip155:1:${wallet.address}`;
  const sealed = await api('/api/insights/runs/preview', { run_id: id });
  if (!sealed) throw new Error('No preview of yours for that run.');
  const preview = openPreview(sealed, did, id, wallet.privateKey);
  // Anyone can seal a message to your key; only the enclave you pinned can sign one with its release key.
  const problems = [];
  let signedBy = '';
  try { signedBy = verifyMessage(canonical(preview.body), preview.signature); } catch { /* below */ }
  if (signedBy !== pin.signer || preview.signer !== pin.signer) problems.push('it is not signed by the pinned enclave');
  if (preview.body.run !== id || preview.body.enclave?.releaseKey !== pin.release_key || preview.body.enclave?.appId !== pin.app_id) problems.push('it is for another run or enclave');
  if (preview.body.commitment !== contributionCommitment(id, did, preview.body.salt, preview.body.your_items)) problems.push('its commitment does not match its contents');
  if (problems.length) throw new Error('Not trusting this preview: ' + problems.join('; ') + '.');
  if (command === 'preview') { show(preview.body); process.exit(0); }
  if (preview.body.withheld) throw new Error(`Nothing to decide: ${preview.body.withheld}.`);
  const body = { v: 1, domain: 'teleport-router/insights-contribution-approval', run: id, enclave: preview.body.enclave,
    commitment: preview.body.commitment, approve: command === 'approve' };
  show({ your_items: preview.body.your_items, decision: body.approve ? 'publish these, counted with the others' : 'leave them out' });
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign this decision)'); process.exit(0); }
  show(await api('/api/insights/runs/decide', { run_id: id, approval: { body, signature: await wallet.signMessage(approvalMessage(body)) } }));
}

else throw new Error(`Unknown command ${command}. Try: help`);
