#!/usr/bin/env node
// The private trace behind each of your Router posts.
//
// A trace is the part of a Claude Code or Codex session that led to a post. By default nothing
// leaves this machine: the script only keeps an index of which post came from which session
// log. A trace is uploaded when you name its post, for example because an insights run asked
// for it and you agreed. It is then cleaned and encrypted here, so that only your storage key
// opens it, and Router keeps the ciphertext in your own storage, linked to the post. Router
// cannot read it. A post gets one trace, written once.
//
//   node capture-traces.mjs                       index new posts; sends nothing
//   node capture-traces.mjs --upload <entry-id>   upload the trace of that post (repeat for several)
//   node capture-traces.mjs --upload-all          upload every indexed trace not uploaded before
//   node capture-traces.mjs --open <entry-id> --owner-key-file <file> [--out <file>]
//                                                 download one trace and open it with your storage key
// Options:
//   --key-file <file>        file holding your Router key (or set ROUTER_KEY); needed to upload or open
//   --router <url>           default https://router.teleport.computer
//   --projects <dir>         a folder of session logs: a Claude Code "projects" folder or a Codex "sessions"
//                            folder; repeat for several accounts (default: ~/.claude/projects,
//                            $CLAUDE_CONFIG_DIR/projects when set, and ~/.codex/sessions or $CODEX_HOME/sessions)
//   --days <n>               only session logs changed in the last n days (default 2)
//   --state <file>           the index and upload record (default ~/.router/traces/state.json)
//   --rules <file>           your rules (default ~/.router/traces/rules.json), for example
//                            { "never_upload_tools": ["mcp__diary__"] }: once a session calls such a tool,
//                            that post and later ones get a record that says "withheld" and holds nothing else
//   --never-upload <prefix>  add one such tool-name prefix for this run
//   --owner-key-file <file>  your storage key, or
//   --owner-public-key <k>   its public key, from your own copy of the key and not from Router.
//                            One of the two is required for the first upload, because traces are encrypted to
//                            this key and Router is the party that must not be able to read them. The run
//                            stops if Router reports a different key. The key is then remembered.
import { readFile, writeFile, readdir, stat, mkdir, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { findPosts, buildTrace, sourceOf, mentionsNeverUpload, sealFull, openFull, readTrace, compressPublicKey, publicKeyOf } from './trace-lib.mjs';

const argv = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const values = name => argv.flatMap((a, i) => a === name && argv[i + 1] ? [argv[i + 1]] : []);
const fail = message => { console.error(message); process.exit(1); };

const router = (value('--router') || 'https://router.teleport.computer').replace(/\/+$/, '');
const statePath = value('--state') || join(homedir(), '.router', 'traces', 'state.json');
const days = Number(value('--days') || 2);
if (!(days > 0)) fail('--days must be a positive number');

const routerKey = (value('--key-file') ? (await readFile(value('--key-file'), 'utf8')) : process.env.ROUTER_KEY || '').trim();
const needKey = () => routerKey || fail('Give your Router key with --key-file <file> or the ROUTER_KEY environment variable.');
async function call(path, body = {}) {
  const response = await fetch(router + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${needKey()}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(data.error || `Router answered ${response.status}`); err.status = response.status; throw err; }
  return data;
}

if (flag('--open')) {
  const entryId = value('--open'), keyFile = value('--owner-key-file');
  if (!entryId || !keyFile) fail('Usage: --open <entry-id> --owner-key-file <file> [--out <file>]');
  const ownerKey = (await readFile(keyFile, 'utf8')).trim();
  const got = await call('/api/traces/get', { entry_id: entryId });
  const trace = readTrace(openFull(got.meta, Buffer.from(got.data, 'base64'), { ownerDid: got.owner_did, entryId }, ownerKey));
  if (trace.entry_id !== entryId) fail('The opened record names a different post.');
  if (value('--out')) { await writeFile(value('--out'), JSON.stringify(trace, null, 1), { flag: 'wx' }); console.log(JSON.stringify({ opened: entryId, records: trace.records.length, written_to: value('--out') })); }
  else console.log(JSON.stringify({ opened: entryId, agent: trace.agent, session_id: trace.session_id, posted_at: trace.posted_at, records: trace.records.length, withheld: trace.withheld || null, cleaning: trace.cleaning || null }));
  process.exit(0);
}

// The state file holds the index, the remembered storage key and the sessions whose traces are withheld.
// Losing it silently would lose all three, so a damaged file stops the run and two runs never write at once.
await mkdir(dirname(statePath), { recursive: true });
const lockPath = statePath + '.lock';
const lockAge = await stat(lockPath).then(s => Date.now() - s.mtimeMs, () => null);
if (lockAge !== null && lockAge > 30 * 60_000) await rm(lockPath, { force: true });
await writeFile(lockPath, String(process.pid), { flag: 'wx' }).catch(() => fail(`Another run is using ${statePath} (lock file ${lockPath}). Try again when it finishes.`));
const unlock = () => rm(lockPath, { force: true });
const stop = async message => { await unlock(); fail(message); };
let saved = {};
const existing = await readFile(statePath, 'utf8').catch(err => err.code === 'ENOENT' ? null : stop(`Could not read ${statePath}: ${err.message}`));
if (existing !== null) { try { saved = JSON.parse(existing); } catch { await stop(`${statePath} is damaged and was left untouched. Restore it or move it aside, then run again.`); } }
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) await stop(`${statePath} is damaged and was left untouched.`);
const state = { v: 1, owner: null, index: {}, traces: {}, excluded_sessions: {}, ...saved };
const saveState = async () => { const tmp = `${statePath}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(state, null, 1)); await rename(tmp, statePath); };
const sliceHash = (lines, post) => createHash('sha256').update(lines.slice(post.firstLine, post.lastLine + 1).join('\n')).digest('hex');
const excluded = () => new Set(Object.keys(state.excluded_sessions));
const rulesPath = value('--rules') || join(dirname(statePath), 'rules.json');
const rulesText = await readFile(rulesPath, 'utf8').catch(err => err.code === 'ENOENT' && !value('--rules') ? null : stop(`Could not read ${rulesPath}: ${err.message}`));
let rules = {};
if (rulesText !== null) { try { rules = JSON.parse(rulesText); } catch { await stop(`${rulesPath} is not valid JSON. Nothing was indexed or uploaded.`); } }
const neverUpload = [...new Set([...(Array.isArray(rules.never_upload_tools) ? rules.never_upload_tools : []), ...values('--never-upload')])];
if (neverUpload.some(p => typeof p !== 'string' || p.length < 4)) await stop('Each never-upload entry must be a tool-name prefix of at least four characters.');

try {
  // 1. Index: which post came from which lines of which session log. Local only.
  const roots = values('--projects');
  if (!roots.length) {
    roots.push(join(homedir(), '.claude', 'projects'));
    if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
    roots.push(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'));
  }
  const cutoff = Date.now() - days * 86400_000, MAX_LOG_BYTES = 400 * 1024 * 1024;
  async function* logs(dir) {
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, item.name);
      if (item.isDirectory()) yield* logs(path);
      else if (item.name.endsWith('.jsonl')) { const s = await stat(path).catch(() => null); if (s && s.mtimeMs >= cutoff) yield { path, bytes: s.size }; }
    }
  }
  const totals = { never_upload_rules: neverUpload.length, logs_with_posts: 0, logs_too_large: 0, posts_found: 0, newly_indexed: 0, indexed_total: 0, indexed_withheld: 0, failed_writes: 0, unrecognized_receipts: 0,
    uploaded: 0, already_uploaded: 0, withheld: 0, not_your_post: 0, failed: 0 };
  const report = [], scanned = [];
  for (const root of roots) {
    for await (const log of logs(root)) {
      if (log.bytes > MAX_LOG_BYTES) { totals.logs_too_large++; continue; }
      const text = await readFile(log.path, 'utf8');
      const mentionsPost = text.includes('router_write_entry') || text.includes('write_to_shared_notebook');
      if (!mentionsPost && !mentionsNeverUpload(text, neverUpload)) continue;
      const lines = text.split('\n');
      const found = findPosts(lines, { neverUpload, excludedSessions: excluded(), fileName: basename(log.path) });
      // A session that called a never-upload tool is remembered, so that sessions it started are withheld too.
      if (found.calledNeverUpload && found.sessionId) state.excluded_sessions[found.sessionId] ||= { since: new Date().toISOString() };
      if (!found.posts.length) continue;
      totals.logs_with_posts++; totals.failed_writes += found.failedWrites; totals.unrecognized_receipts += found.unrecognizedResults;
      scanned.push({ path: log.path, parent: found.parentSessionId, posts: found.posts.map(post => ({ ...post, hash: sliceHash(lines, post) })) });
    }
  }
  const now = new Date().toISOString();
  for (const log of scanned) {
    // The session that started this one may have been read later in the same run.
    const viaParent = log.parent && state.excluded_sessions[log.parent] ? 'the session that started this one called a tool whose results are never uploaded' : null;
    for (const post of log.posts) {
      totals.posts_found++;
      const withheld = post.withheld || viaParent || undefined, known = state.index[post.entryId];
      if (known) { if (withheld && !known.withheld && known.log === log.path) known.withheld = withheld; continue; }   // a resumed session repeats its history; the first log seen keeps the post
      state.index[post.entryId] = { agent: post.agent, log: log.path, first_line: post.firstLine, last_line: post.lastLine, session_id: post.sessionId,
        posted_at: post.postedAt, previous_entry_id: post.previousEntryId, withheld, slice_sha256: post.hash, indexed_at: now };
      totals.newly_indexed++;
    }
  }
  totals.indexed_total = Object.keys(state.index).length;
  totals.indexed_withheld = Object.values(state.index).filter(i => i.withheld).length;
  await saveState();

  // 2. Upload only what was named.
  const wanted = flag('--upload-all')
    ? Object.keys(state.index).filter(id => { const t = state.traces[id]; return !t || (t.skipped && (t.tries || 1) < 3); })
    : [...new Set(values('--upload'))];
  let owner = null;
  async function ownerKey() {
    if (owner) return owner;
    // The key traces are encrypted to must come from the owner, not from Router: Router is who must not read them.
    const mine = value('--owner-key-file') ? publicKeyOf((await readFile(value('--owner-key-file'), 'utf8')).trim())
      : value('--owner-public-key') ? compressPublicKey(value('--owner-public-key')) : state.owner?.publicKey;
    if (!mine) await stop('The first upload needs your storage key, so traces are encrypted to a key you supplied and not one Router reported.\nGive --owner-key-file <file with your storage key> or --owner-public-key <its public key, from your own copy>. Nothing was uploaded.');
    if (state.owner && state.owner.publicKey !== mine) await stop(`The storage key given differs from the one remembered in ${statePath}. Nothing was uploaded. If you changed your storage key, delete the "owner" entry there.`);
    const reported = await call('/api/traces/owner');
    if (compressPublicKey(reported.owner_public_key) !== mine) await stop('Router reports a different storage key for your account than the one you gave. Nothing was uploaded. Check which storage is linked to your Router account.');
    if (state.owner && state.owner.did !== reported.owner_did) await stop('Router reports a different storage identity than the one remembered. Nothing was uploaded.');
    if (!state.owner) { state.owner = { handle: reported.handle, did: reported.owner_did, publicKey: mine, confirmedAt: new Date().toISOString() }; await saveState(); }
    return owner = { did: reported.owner_did, publicKey: mine, maxBytes: Math.min(reported.full_max_bytes || 6 * 1024 * 1024, 6 * 1024 * 1024) };
  }

  for (const entryId of wanted) {
    const item = state.index[entryId], known = state.traces[entryId];
    if (!item) { totals.failed++; report.push({ entry: entryId, error: 'No session log on this machine is indexed for that post. Try a larger --days.' }); continue; }
    if (known && !known.skipped) { totals.already_uploaded++; continue; }
    const line = { entry: entryId, agent: item.agent, session: item.session_id?.slice(0, 8), posted_at: item.posted_at };
    let built;
    try {
      const lines = (await readFile(item.log, 'utf8')).split('\n');
      // Decide again whether this trace may be uploaded: an exclusion may have been learned since it was indexed.
      const fresh = findPosts(lines, { neverUpload, excludedSessions: excluded(), fileName: basename(item.log) });
      const post = fresh.posts.find(p => p.entryId === entryId);
      if (!post || post.firstLine !== item.first_line || post.lastLine !== item.last_line || sliceHash(lines, post) !== item.slice_sha256) throw new Error('The session log changed since this post was indexed.');
      post.withheld ||= item.withheld || (fresh.parentSessionId && state.excluded_sessions[fresh.parentSessionId] ? 'the session that started this one called a tool whose results are never uploaded' : null);
      if (post.withheld && !item.withheld) item.withheld = post.withheld;
      built = buildTrace({ post, lines, source: { log: basename(item.log), ...sourceOf(lines, post) }, extraSecrets: [routerKey].filter(Boolean), maxBytes: (await ownerKey()).maxBytes - 64 * 1024 });
    } catch (err) { totals.failed++; report.push({ ...line, error: err.code === 'ENOENT' ? 'The session log is no longer on this machine.' : err.message }); continue; }
    Object.assign(line, { records: built.summary.records, bytes: built.plaintext.length, withheld: built.summary.withheld, secrets_removed: built.summary.secrets_removed ?? 0, shortened_to: built.summary.shortened_to });
    if (built.summary.withheld) totals.withheld++;
    const o = await ownerKey();
    const sealed = sealFull(built.plaintext, { ownerDid: o.did, entryId }, o.publicKey);
    try {
      const stored = await call('/api/traces', { entry_id: entryId, full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } });
      state.traces[entryId] = { sha256: stored.full_sha256, bytes: sealed.meta.bytes, at: new Date().toISOString(), withheld: built.summary.withheld || undefined };
      totals.uploaded++; report.push({ ...line, uploaded: true });
    } catch (err) {
      if (/already has its trace/.test(err.message)) { state.traces[entryId] = { existing: true, at: new Date().toISOString() }; totals.already_uploaded++; }
      // Tried on three runs before it is left alone: the post's group storage may only have been unreachable.
      else if (/not one of your posts/.test(err.message)) { state.traces[entryId] = { skipped: 'not your post, or deleted', tries: (known?.tries || 0) + 1, at: new Date().toISOString() }; totals.not_your_post++; }
      else { totals.failed++; report.push({ ...line, error: err.message }); if (err.status === 401 || err.status === 404) { await saveState(); break; } }
    }
    await saveState();
  }
  console.log(JSON.stringify({ mode: wanted.length ? 'index and upload' : 'index only (nothing sent)', router: wanted.length ? router : undefined, days, ...totals, traces: report }, null, 1));
  if (totals.failed) process.exitCode = 1;
} finally { await unlock(); }
