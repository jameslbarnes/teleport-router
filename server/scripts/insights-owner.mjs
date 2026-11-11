#!/usr/bin/env node
// An owner's side of Router insights: what each person's agent runs, under that person's own rules.
// It signs with the key that owns the person's TinyCloud storage; that key never leaves this machine.
//
//   node scripts/insights-owner.mjs <command> [options]
//     status                                   consent and enclave as Router reports them
//     enclave                                  what the enclave says about itself, with the checks this tool can do here
//     consent --triggers h1[,h2] [--groups g1,g2] [--days 30] [--yes]
//     requests                                 run requests that involve your posts
//     authorize <request_id> [--yes]           sign the authorization for your posts in one request
//     decline <request_id>
//     preview <run_id>                         open your sealed preview: your answers, and the draft result
//     approve <run_id> [--yes] | veto <run_id> [--yes]
//
// Without --yes, signing commands only print what would be signed.
// Environment: ROUTER_URL (default https://router.teleport.computer), ROUTER_KEY or ROUTER_KEY_FILE (your Router key),
// OWNER_KEY_FILE (a file holding the 0x-hex private key that owns your storage).
// Run from server/ after `npm run build`.
import { readFile } from 'node:fs/promises';
import { Wallet } from 'ethers';
import { canonical } from '../dist/author-records.js';
import { consentMessage, authorizationMessage, approvalMessage, questionSha256 } from '../dist/insights-release.js';
import { openPreview } from '../dist/insights-enclave.js';
import { sha256Hex } from '../dist/trace-envelope.js';

const [command, ...rest] = process.argv.slice(2);
const flags = {}, args = [];
for (let i = 0; i < rest.length; i++) {
  if (rest[i] === '--yes') flags.yes = true;
  else if (rest[i].startsWith('--')) flags[rest[i].slice(2)] = rest[++i];
  else args.push(rest[i]);
}
const base = (process.env.ROUTER_URL || 'https://router.teleport.computer').replace(/\/$/, '');
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

/** What this tool can check about the enclave without trusting Router: that its report data commits to the key, program and policy it names. */
async function enclaveChecks() {
  const info = await api('/api/insights/release');
  const e = info.enclave || {};
  const identity = { release_key: e.release_key, app_id: e.app_id, program_sha256: e.program_sha256, upgrades: e.upgrades, min_people: e.min_people };
  const identitySha256 = sha256Hex(canonical(identity));
  const checks = {
    'program matches what Router offers': e.program_sha256 === info.program?.sha256,
    'report data commits to this key, program and policy': typeof e.report_data === 'string' && e.report_data.startsWith(identitySha256),
    'a TDX quote is attached': !!e.quote?.quote,
    'the quote carries that report data': typeof e.quote?.quote === 'string' && e.quote.quote.toLowerCase().includes(identitySha256),
  };
  return { info, identity, checks, compose_hash: e.quote?.compose_hash ?? null,
    still_to_check: 'Verify the quote itself (signature chain and TCB) with a DCAP verifier, and that compose_hash matches the published compose file for this enclave with a digest-pinned image.' };
}

if (command === 'status') show(await api('/api/insights/consent/status', {}));

else if (command === 'enclave') { const r = await enclaveChecks(); show({ app_id: r.identity.app_id, release_key: r.identity.release_key, upgrades: r.identity.upgrades, compose_hash: r.compose_hash, checks: r.checks, still_to_check: r.still_to_check }); }

else if (command === 'consent') {
  const triggers = (flags.triggers || '').split(',').filter(Boolean);
  const groups = flags.groups ? flags.groups.split(',').filter(Boolean) : undefined;
  const draft = await api('/api/insights/consent/draft', { triggers, groups, days: flags.days ? Number(flags.days) : undefined });
  // Sign only text this tool derives itself from the policy fields.
  if (draft.message !== consentMessage(draft.policy)) throw new Error('Router sent consent text that does not match its policy. Not signing.');
  const wallet = await ownerWallet();
  if (`did:pkh:eip155:1:${wallet.address}`.toLowerCase() !== draft.policy.owner.did.toLowerCase()) throw new Error('OWNER_KEY_FILE is not the key that owns this account\'s storage.');
  console.log(draft.message);
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign and save this consent)'); process.exit(0); }
  show(await api('/api/insights/consent', { policy: draft.policy, signature: await wallet.signMessage(draft.message) }));
}

else if (command === 'requests') {
  const { requests } = await api('/api/insights/requests/mine', {});
  show(requests.map(r => ({ request_id: r.request_id, status: r.status, requested_by: r.created_by, question: r.params, your_posts: r.your_posts,
    your_answer: r.your_answer, deadline: r.deadline, answered: `${r.answered}/${r.people_asked}`, can_sign: !!r.to_sign?.body, note: r.to_sign?.error || null, run: r.run })));
}

else if (command === 'authorize' || command === 'decline') {
  const id = args[0];
  if (command === 'decline') { show(await api('/api/insights/requests/answer', { request_id: id, answer: 'no' })); process.exit(0); }
  const { requests } = await api('/api/insights/requests/mine', {});
  const r = requests.find(x => x.request_id === id);
  if (!r?.to_sign?.body) throw new Error(r?.to_sign?.error || 'Nothing to sign for that request.');
  const body = r.to_sign.body;
  const status = await api('/api/insights/consent/status', {});
  // Check what is being signed, rather than trusting Router's summary of it.
  const problems = [];
  if (body.run !== id) problems.push('it names another request');
  if (body.enclave?.releaseKey !== status.release_key) problems.push('it names an enclave key other than the one in your consent');
  if (status.policy?.policyId !== body.policyId) problems.push('it relies on a consent that is not your current one');
  if (!body.entries.every(e => r.your_posts.includes(e.entryId))) problems.push('it lists posts that are not yours');
  if (body.question.sha256 !== questionSha256(status.program_sha256, body.question.template, body.question.params)) problems.push('its question hash does not match the question');
  if (problems.length) throw new Error('Not signing: ' + problems.join('; ') + '.');
  console.log(authorizationMessage(body));
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign this authorization and answer yes)'); process.exit(0); }
  const wallet = await ownerWallet();
  show(await api('/api/insights/requests/answer', { request_id: id, answer: 'yes', authorization: { body, signature: await wallet.signMessage(authorizationMessage(body)) } }));
}

else if (command === 'preview' || command === 'approve' || command === 'veto') {
  const id = args[0];
  const sealed = await api('/api/insights/runs/preview', { run_id: id });
  const status = await api('/api/insights/consent/status', {});
  const wallet = await ownerWallet();
  const preview = openPreview(sealed, status.owner_did, id, wallet.privateKey);
  if (command === 'preview') { show(preview.body); process.exit(0); }
  const body = { v: 1, domain: 'teleport-router/insights-result-approval', run: id, enclave: preview.body.enclave,
    resultSha256: preview.body.result_sha256, approve: command === 'approve' };
  if (!body.resultSha256) throw new Error(preview.body.withheld || 'This run has no result to decide on.');
  if (sha256Hex(canonical(preview.body.draft)) !== body.resultSha256) throw new Error('The draft does not match its hash. Not signing.');
  show({ draft: preview.body.draft, decision: body.approve ? 'approve' : 'veto' });
  if (!flags.yes) { console.log('\n(not signed: add --yes to sign this decision)'); process.exit(0); }
  show(await api('/api/insights/runs/decide', { run_id: id, approval: { body, signature: await wallet.signMessage(approvalMessage(body)) } }));
}

else throw new Error(`Unknown command ${command}. Try: help`);
