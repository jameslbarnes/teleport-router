// Compares the RedPill gateway releases the trace runner accepts (REDPILL_RELEASES in
// subhost/runner.base.json) with the releases RedPill has published, so the list can be
// updated before a new release rolls out. See docs/trace-app-model-calls.md, "Upkeep".
//
//   node scripts/redpill-releases.mjs           report; exit 1 if the list should change
//   node scripts/redpill-releases.mjs --write   also rewrite runner.base.json; then run node subhost/embed.mjs
//
// What it trusts: the releases of Dstack-TEE/private-ai-gateway on GitHub, where RedPill announces
// each gateway release at least three days before it rolls out, and the app contract on Base that
// says which releases a gateway replica may boot with. A release's hash is computed here from its
// published app_compose.json, not copied from text, and is added only when the contract allows it.
// Nothing is merged by this script: a person reviews the change.
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = join(ROOT, 'subhost', 'runner.base.json');
export const GATEWAY_REPO = 'Dstack-TEE/private-ai-gateway';
/** The gateway's app contract on Base (chain 8453). A release that names another contract is not added. */
export const APP_ID = '89c51ab856bee41efe78c40309a4deb277a02a0f';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const TAG = /^gateway-prod-(\d{4})-(\d{2})-(\d{2})(?:-(\d{1,2}))?$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Newest first. Tags carry the rollout date; a numeric suffix orders releases of the same day. */
export function gatewayReleases(releases) {
  return releases
    .filter(r => r && !r.draft && typeof r.tag_name === 'string' && TAG.test(r.tag_name))
    .map(r => { const [, y, m, d, n] = r.tag_name.match(TAG); return { tag: r.tag_name, prerelease: !!r.prerelease, order: `${y}${m}${d}${String(n || 0).padStart(2, '0')}`, assets: r.assets || [] }; })
    .sort((a, b) => b.order.localeCompare(a.order));
}

/** The releases the runner should accept: any announced after the current one, the current one, and the
 *  full release before it. Keeping that one covers a rollout, when replicas run both, and means the list
 *  changes once per release instead of twice. A prerelease older than the current release was never
 *  rolled out and is ignored. */
export function wantedReleases(releases) {
  const all = gatewayReleases(releases), current = all.findIndex(r => !r.prerelease);
  if (current < 0) throw new Error('No current gateway release was found.');
  const previous = all.slice(current + 1).find(r => !r.prerelease);
  return [...all.slice(0, current).map(r => ({ ...r, role: 'scheduled' })), { ...all[current], role: 'current' }, ...(previous ? [{ ...previous, role: 'previous' }] : [])];
}

/** The host refuses an env value over 4096 characters (subhost/host.mjs): 63 hashes and their commas. */
const MOST = 63;

/** What to do given the list now and each wanted release's { tag, role, hash, onChain } (onChain: true, false, or null
 *  when the chain could not be asked). A hash is added only when the app contract allows it. An announced release
 *  the contract does not allow yet waits, and is looked at again the next day. Nothing is removed unless the
 *  release before the current one was found, so a short page of releases cannot drop a hash that is live. */
export function plan(listed, wanted) {
  const problems = [], waiting = [], next = [];
  for (const r of wanted) {
    const known = listed.includes(r.hash);
    if (!HEX64.test(r.hash || '')) problems.push(`${r.tag}: no usable hash (${r.problem || 'unknown'}).`);
    else if (known || r.onChain === true) next.push(r.hash);
    else if (r.onChain === null) problems.push(`${r.tag}: the app contract could not be asked, so its hash was not added.`);
    else if (r.role === 'scheduled') waiting.push(r.tag);
    else problems.push(`${r.tag}: the app contract does not allow its hash, though the release is marked as rolled out.`);
    if (known && r.role !== 'scheduled' && r.onChain === false) problems.push(`${r.tag}: the app contract no longer allows its hash.`);
  }
  const complete = wanted.some(r => r.role === 'previous');
  const kept = [...new Set([...next, ...(complete ? [] : listed)])];
  if (kept.length > MOST) problems.push(`The list would hold ${kept.length} hashes; the runner's spec has room for ${MOST}.`);
  const add = kept.filter(h => !listed.includes(h)), drop = listed.filter(h => !kept.includes(h));
  return { next: kept, add, drop, problems, waiting, change: !problems.length && (add.length > 0 || drop.length > 0) };
}

export function readListed(text = readFileSync(SPEC, 'utf8')) {
  return String(JSON.parse(text).env?.REDPILL_RELEASES || '').split(',').map(s => s.trim()).filter(Boolean);
}

/** Rewrites only the value, keeping the file's layout. */
export function writeListed(text, next) {
  const out = text.replace(/("REDPILL_RELEASES"\s*:\s*")[^"]*(")/, (_, a, b) => a + next.join(',') + b);
  if (out === text || readListed(out).join(',') !== next.join(',')) throw new Error('Could not rewrite REDPILL_RELEASES in subhost/runner.base.json.');
  return out;
}

/** Reads at most `limit` bytes; a larger answer is an error, not a truncated file. */
async function get(url, accept, limit) {
  const headers = { accept, 'user-agent': 'router-release-check' };
  if (process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com') headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).hostname} answered ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    if ((size += chunk.length) > limit) throw new Error(`an answer from ${new URL(url).hostname} was larger than ${limit} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
const parse = (buffer, what) => { try { return JSON.parse(buffer.toString('utf8')); } catch { throw new Error(`${what} is not JSON`); } };

/** The release's hash is the SHA-256 of its app_compose.json; measurements.json, when present, must agree and name the known app contract. */
async function measure(release) {
  const asset = name => release.assets.find(a => a.name === name && Number.isInteger(a.id));
  const download = a => get(`https://api.github.com/repos/${GATEWAY_REPO}/releases/assets/${a.id}`, 'application/octet-stream', 1024 * 1024);
  try {
    const compose = asset('app_compose.json');
    if (!compose) return { problem: 'no app_compose.json' };
    const hash = createHash('sha256').update(await download(compose)).digest('hex');
    const measurements = asset('measurements.json');
    if (measurements) {
      const app = parse(await download(measurements), 'measurements.json')?.app || {};
      if (app.compose_hash !== hash) return { problem: 'measurements.json names a different hash than app_compose.json has' };
      if (String(app.app_id).toLowerCase() !== APP_ID) return { problem: 'it names a different app contract' };
    }
    return { hash };
  } catch (err) { return { problem: String(err?.message || err).slice(0, 120) }; }
}

/** allowedComposeHashes(bytes32) on the app contract: true, false, or null if the chain could not be asked. */
async function allowedOnChain(hash) {
  try {
    const response = await fetch(BASE_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(20_000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: `0x${APP_ID}`, data: `0x2f6622e5${hash}` }, 'latest'] }) });
    const result = (await response.json())?.result;
    return /^0x[0-9a-f]{64}$/.test(result || '') ? /[1-9a-f]/.test(result.slice(2)) : null;
  } catch { return null; }
}

/** Markdown for a person: every value here is ours or was checked against a pattern, never text copied from a release. */
export function report(listed, wanted, { add, drop, problems, waiting, change }) {
  const chain = v => v === true ? 'allowed' : v === false ? 'not allowed yet' : 'could not be checked';
  const lines = [
    change ? 'RedPill has published a gateway release the trace runner does not accept yet, or one it no longer needs to.' : problems.length ? 'The list was left alone because something did not check out.' : 'The trace runner accepts the releases RedPill has published. Nothing to change.',
    '', '| Release | Role | Hash (SHA-256 of its `app_compose.json`) | On the app contract | In the list now |', '| - | - | - | - | - |',
    ...wanted.map(r => `| [${r.tag}](https://github.com/${GATEWAY_REPO}/releases/tag/${r.tag}) | ${r.role} | ${HEX64.test(r.hash || '') ? `\`${r.hash}\`` : 'none'} | ${chain(r.onChain)} | ${listed.includes(r.hash) ? 'yes' : 'no'} |`),
    '', ...problems.map(p => `- Problem: ${p}`),
    ...waiting.map(tag => `- ${tag} is announced, but the app contract does not allow its hash yet, so it is not added. It is checked again tomorrow.`),
    ...(change ? [`- Adds ${add.length}, removes ${drop.length}${drop.length ? ` (${drop.map(h => `\`${h.slice(0, 12)}…\``).join(', ')}: older than the previous release)` : ''}.`,
      '- Merging deploys Router. The list is part of the runner\'s measured spec, so the runner gets a new identity, and owners\' tools accept it only from a checkout that has this list.',
      '- Until a release is in the list, RedPill calls from trace apps stop when it rolls out (they fail closed).',
      '- Before merging, open the release pages above and check they are RedPill\'s.'] : []),
  ];
  return lines.join('\n');
}

async function main() {
  const write = process.argv.includes('--write');
  const releases = parse(await get(`https://api.github.com/repos/${GATEWAY_REPO}/releases?per_page=100`, 'application/vnd.github+json', 16 * 1024 * 1024), 'The list of releases');
  if (!Array.isArray(releases)) throw new Error('The list of releases is not a list.');
  const wanted = [];
  for (const r of wantedReleases(releases)) {
    const measured = await measure(r);
    wanted.push({ tag: r.tag, role: r.role, ...measured, onChain: measured.hash ? await allowedOnChain(measured.hash) : null });
  }
  const text = readFileSync(SPEC, 'utf8'), listed = readListed(text), result = plan(listed, wanted);
  const body = report(listed, wanted, result);
  console.log(body);
  if (result.change && write) writeFileSync(SPEC, writeListed(text, result.next));
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `change=${result.change}\nkey=${createHash('sha256').update(result.next.join(',')).digest('hex').slice(0, 12)}\n`);
  process.exitCode = result.problems.length ? 2 : result.change && !write ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(err => { console.error(`Release check failed: ${String(err?.message || err).slice(0, 200)}`); process.exitCode = 2; });
