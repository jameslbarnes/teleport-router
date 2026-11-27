#!/usr/bin/env node
// The private trace behind each of your Router posts.
//
// A trace is the part of a Claude Code or Codex session that led to a post. The script keeps an
// index of which post came from which session log, and its own copy of those log lines under
// ~/.router/traces/copies (created with owner-only permissions; on Windows they follow the folder's), so a trace can still be made after the agent
// cleans up its session logs. Nothing of a trace leaves this machine until you upload it.
//
// With --pointers (the plugin's hook runs this after each post), the script also tells Router
// that a trace exists for each of your posts and is held on this machine: the post's ID, the
// agent kind (claude-code or codex) and a fingerprint, the SHA-256 of the raw log lines. People
// who can read the post can then see that it has a trace and ask to run an app on it. Put
// "pointers": false in your rules file to stop this. Posts whose trace your rules withhold get
// no pointer; a pointer registered before your rules withheld a post stays on Router.
//
// A trace is uploaded when you name its post, or when you approve a run on it with the owner
// tool (server/scripts/trace-app-owner.mjs run), which calls this script. It is then cleaned and
// encrypted here, so that only your storage key opens it, and Router keeps the ciphertext in your
// own storage, linked to the post. Router cannot read it. A post gets one trace, written once.
//
//   node capture-traces.mjs                       index new posts and copy their log lines; sends nothing
//   node capture-traces.mjs --pointers            also tell Router which posts have a trace on this machine
//   node capture-traces.mjs --pointers --days 30  the same for older posts whose session logs are still here
//   node capture-traces.mjs --pointers-only       as --pointers, but refuses any upload or open option and registers only
//                                                 posts made by this plugin's Router tools in Claude Code (the hook runs this)
//   node capture-traces.mjs --upload <entry-id>   upload the trace of that post (repeat for several)
//   node capture-traces.mjs --upload-all          upload every indexed trace not uploaded before
//   node capture-traces.mjs --open <entry-id> --owner-key-file <file> [--out <file>]
//                                                 download one trace and open it with your storage key
// Options:
//   --key-file <file>        file holding your Router key (or set ROUTER_KEY); needed to register pointers, upload
//                            or open. In the plugin's hook, the key you gave the plugin is used.
//   --router <url>           default https://router.teleport.computer (the plugin's hook always uses the default)
//   --projects <dir>         a folder of session logs: a Claude Code "projects" folder or a Codex "sessions"
//                            folder; repeat for several accounts (default: ~/.claude/projects,
//                            $CLAUDE_CONFIG_DIR/projects when set, and ~/.codex/sessions or $CODEX_HOME/sessions)
//   --log <file>             read only this session log instead of the folders (repeat for several)
//   --days <n>               only session logs changed in the last n days (default 2)
//   --state <file>           the index and upload record (default ~/.router/traces/state.json); the copies of
//                            log lines go in a "copies" folder beside it
//   --rules <file>           your rules (default ~/.router/traces/rules.json), for example
//                            { "never_upload_tools": ["mcp__diary__"] }: once a session calls such a tool,
//                            that post and later ones get a record that says "withheld" and holds nothing else.
//                            The file must exist, with that list, before anything is uploaded; the list may be
//                            empty. { "pointers": false } stops --pointers from telling Router anything.
//   --never-upload <prefix>  add one such tool-name prefix for this run
//   --owner-key-file <file>  your storage key, or
//   --owner-public-key <k>   its public key, from your own copy of the key and not from Router.
//                            One of the two is required for the first upload, because traces are encrypted to
//                            this key and Router is the party that must not be able to read them. The run
//                            stops if Router reports a different key. The key is then remembered.
//   --extraction-copy        also upload a shorter extraction copy that the insights enclave may open, in runs
//                            you authorize one at a time. Needs a current insights consent. Withheld traces get none.
//   --release-key <k>        the enclave key you checked (scripts/insights-owner.mjs enclave); required with the
//                            first extraction copy, then remembered. The run stops if Router or your consent names
//                            another key.
import { readFile, writeFile, readdir, lstat, mkdir, rename, rm, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { postFinder, originReader, eachLine, sliceHasher, buildTrace, sourceOf, mentionsNeverUpload, mentionsRouterWrite, sealFull, sealDerived, openFull, readTrace, compressPublicKey, publicKeyOf } from './trace-lib.mjs';

// The extraction copy must fit the enclave's limit on what it opens (400 KiB of ciphertext).
const EXTRACTION_MAX_BYTES = 380 * 1024;

const fail = message => { console.error(message); process.exit(1); };
// Options are parsed strictly: an option's value is consumed as a value and never read as another option, so a
// file name that looks like "--upload" cannot switch on an upload. A value that starts with "-" needs the
// --option=value form. Unknown options and stray arguments stop the run.
const STRING = ['router', 'state', 'days', 'key-file', 'rules', 'owner-key-file', 'owner-public-key', 'release-key', 'open', 'out'];
const LISTS = ['projects', 'log', 'never-upload', 'upload'];
const FLAGS = ['pointers', 'pointers-only', 'upload-all', 'extraction-copy'];
let parsed;
try {
  parsed = parseArgs({ args: process.argv.slice(2), strict: true, allowPositionals: false, options: Object.fromEntries([
    ...STRING.map(n => [n, { type: 'string' }]), ...LISTS.map(n => [n, { type: 'string', multiple: true }]), ...FLAGS.map(n => [n, { type: 'boolean' }])]) }).values;
} catch (err) { fail(`${err.message}\nSee the top of capture-traces.mjs for the options. Nothing was read or sent.`); }
const flag = name => parsed[name.slice(2)] === true;
const value = name => parsed[name.slice(2)];
const values = name => parsed[name.slice(2)] || [];
// --pointers-only is what the plugin's hook runs: it can index, copy and register pointers, and nothing else.
if (flag('--pointers-only')) {
  const other = ['--upload', '--upload-all', '--open', '--extraction-copy', '--owner-key-file', '--owner-public-key', '--release-key', '--out']
    .filter(name => { const v = parsed[name.slice(2)]; return v !== undefined && v !== false && !(Array.isArray(v) && !v.length); });
  if (other.length) fail(`--pointers-only cannot be combined with ${other.join(', ')}. Nothing was read or sent.`);
}
const pointersAsked = flag('--pointers') || flag('--pointers-only');

// The Router key goes only to this address: --router, or Router itself. No environment variable can redirect it.
const router = (value('--router') || 'https://router.teleport.computer').replace(/\/+$/, '');
const statePath = value('--state') || join(homedir(), '.router', 'traces', 'state.json');
const days = Number(value('--days') || 2);
if (!(days > 0)) fail('--days must be a positive number');

// CLAUDE_PLUGIN_OPTION_ROUTER_KEY is how Claude Code hands a plugin hook the key the plugin was configured with.
const routerKey = (value('--key-file') ? (await readFile(value('--key-file'), 'utf8')) : process.env.ROUTER_KEY || process.env.CLAUDE_PLUGIN_OPTION_ROUTER_KEY || '').trim();
const needKey = () => routerKey || fail('Give your Router key with --key-file <file> or the ROUTER_KEY environment variable.');
async function call(path, body = {}) {
  const response = await fetch(router + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${needKey()}` },
    body: JSON.stringify(body), signal: AbortSignal.timeout(120_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const err = new Error(data.error || `Router answered ${response.status}`); err.status = response.status; throw err; }
  return data;
}

if (value('--open') !== undefined) {
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
// The lock names its process. It is taken over only when that process is gone, never by age alone, and a
// run removes the lock only while it is still its own.
const lockToken = `${process.pid} ${Date.now()}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; } };
const holder = await readFile(lockPath, 'utf8').catch(() => null);
if (holder !== null && !alive(Number(holder.split(' ')[0]))) {
  // Move the dead run's lock aside before removing it. Only one contender's rename succeeds, and a contender
  // that renamed a lock other than the one it read puts it back.
  const aside = `${lockPath}.${process.pid}.stale`;
  if (await rename(lockPath, aside).then(() => true, () => false)) {
    if (await readFile(aside, 'utf8').catch(() => null) === holder) await rm(aside, { force: true });
    else await rename(aside, lockPath).catch(() => {});
  }
}
await writeFile(lockPath, lockToken, { flag: 'wx' }).catch(() => fail(`Another run is using ${statePath} (lock file ${lockPath}). Try again when it finishes.`));
const unlock = async () => { if (await readFile(lockPath, 'utf8').catch(() => null) === lockToken) await rm(lockPath, { force: true }); };
const stop = async message => { await unlock(); fail(message); };
process.on('uncaughtException', err => { stop(err?.stack || String(err)); });
let saved = {};
const existing = await readFile(statePath, 'utf8').catch(err => err.code === 'ENOENT' ? null : stop(`Could not read ${statePath}: ${err.message}`));
if (existing !== null) { try { saved = JSON.parse(existing); } catch { await stop(`${statePath} is damaged and was left untouched. Restore it or move it aside, then run again.`); } }
if (!saved || typeof saved !== 'object' || Array.isArray(saved)) await stop(`${statePath} is damaged and was left untouched.`);
const state = { v: 1, owner: null, index: {}, traces: {}, sessions: {}, copies: {}, pointers: {}, unchanged: {}, ...saved };
state.copies ||= {}; state.pointers ||= {}; state.unchanged ||= {};
// This machine's own copies of indexed log lines, for when the agent has cleaned up the original logs.
const copiesDir = join(dirname(statePath), 'copies');
const saveState = async () => { const tmp = `${statePath}.${process.pid}.tmp`; await writeFile(tmp, JSON.stringify(state, null, 1)); await rename(tmp, statePath); };
const sliceHash = (lines, post) => createHash('sha256').update(lines.slice(post.firstLine, post.lastLine + 1).join('\n')).digest('hex');
const EMPTY_SLICE = createHash('sha256').update('').digest('hex');
// state.sessions records, for every log read, which session started it and whether it called a never-upload
// tool or opened with carried-over history. A session is excluded if it or any ancestor did, however the
// logs were ordered when they were read.
// A session named as a parent whose own log has not been read is treated as excluded: nothing is known
// about what it called.
const isExcluded = (id, seen = new Set()) => {
  if (!id || seen.has(id)) return false;
  const s = state.sessions[id];
  if (!s) return true;
  return !!(s.called || s.summary) || isExcluded(s.parent, seen.add(id));
};
// findPosts asks whether a log's parent is excluded, so parents that are named but unread are listed too.
const excluded = () => new Set([...Object.keys(state.sessions), ...Object.values(state.sessions).map(s => s.parent).filter(Boolean)].filter(id => isExcluded(id)));
const VIA_PARENT = 'a session this one descends from called a tool whose results are never uploaded, or its log has not been read so that cannot be ruled out';
const rulesPath = value('--rules') || join(dirname(statePath), 'rules.json');
const rulesText = await readFile(rulesPath, 'utf8').catch(err => err.code === 'ENOENT' && !value('--rules') ? null : stop(`Could not read ${rulesPath}: ${err.message}`));
let rules = {};
if (rulesText !== null) { try { rules = JSON.parse(rulesText); } catch { await stop(`${rulesPath} is not valid JSON. Nothing was indexed or uploaded.`); } }
if (!rules || typeof rules !== 'object' || Array.isArray(rules)) await stop(`${rulesPath} must hold an object such as { "never_upload_tools": [] }. Nothing was indexed or uploaded.`);
if ('never_upload_tools' in rules && !Array.isArray(rules.never_upload_tools)) await stop(`${rulesPath} must list never_upload_tools as an array, for example { "never_upload_tools": ["mcp__diary__"] } or { "never_upload_tools": [] }. Nothing was indexed or uploaded.`);
if ('pointers' in rules && typeof rules.pointers !== 'boolean') await stop(`In ${rulesPath}, "pointers" must be true or false. Nothing was indexed or uploaded.`);
// Rules that only switch pointers off say nothing about what must never be uploaded, so they do not allow uploads.
const uploadRules = rulesText !== null && Array.isArray(rules.never_upload_tools);
const neverUpload = [...new Set([...(rules.never_upload_tools || []), ...values('--never-upload')])].sort();
if (neverUpload.some(p => typeof p !== 'string' || p.length < 4)) await stop('Each never-upload entry must be a tool-name prefix of at least four characters.');
// What was learned about sessions was learned under the rules of the time. When the rules change it is
// forgotten, and sessions count as unread until their logs are read again.
const rulesMark = createHash('sha256').update(JSON.stringify(neverUpload)).digest('hex');
if (state.rules_sha256 !== rulesMark) { state.sessions = {}; state.unchanged = {}; state.rules_sha256 = rulesMark; }

try {
  // 1. Index: which post came from which lines of which session log. Local only.
  const roots = values('--projects'), only = values('--log');
  if (!roots.length && !only.length) {
    roots.push(join(homedir(), '.claude', 'projects'));
    if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
    roots.push(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions'));
  }
  const cutoff = Date.now() - days * 86400_000, MAX_LOG_BYTES = 400 * 1024 * 1024;
  async function* logs(dir) {
    for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, item.name);
      if (item.isDirectory()) yield* logs(path);
      else if (item.name.endsWith('.jsonl')) { const s = await lstat(path).catch(() => null); if (s?.isFile() && s.mtimeMs >= cutoff) yield { path, bytes: s.size, mtimeMs: s.mtimeMs }; }
    }
  }
  // Logs named with --log are read whatever their age.
  async function* named() {
    for (const path of only) { const s = await lstat(path).catch(() => null); if (s?.isFile()) yield { path, bytes: s.size, mtimeMs: s.mtimeMs }; }
  }
  async function* allLogs() { yield* named(); for (const root of roots) yield* logs(root); }
  const totals = { never_upload_rules: neverUpload.length, logs_with_posts: 0, logs_too_large: 0, posts_found: 0, newly_indexed: 0, indexed_total: 0, indexed_withheld: 0, failed_writes: 0, unrecognized_receipts: 0,
    logs_unchanged: 0, copies_written: 0, copy_reads: 0, pointers_registered: 0, pointers_without_copy: 0, pointers_not_router_tool: 0, pointers_already: 0, pointers_withheld: 0, pointers_failed: 0,
    uploaded: 0, already_uploaded: 0, uploaded_from_copy: 0, withheld: 0, not_your_post: 0, failed: 0 };
  const report = [], scanned = [], read = new Set();
  {
    for await (const log of allLogs()) {
      if (read.has(log.path)) continue;
      read.add(log.path);
      if (log.bytes > MAX_LOG_BYTES) { totals.logs_too_large++; continue; }
      // A log unchanged since it was last read, under the same rules, has nothing new: its posts and its session's
      // ancestry are already recorded. This keeps the hook's runs at session start short.
      const before = state.unchanged[log.path];
      if (before && before.bytes === log.bytes && before.mtimeMs === log.mtimeMs) { totals.logs_unchanged++; continue; }
      // Logs are read one line at a time and never held whole: a session log can be hundreds of megabytes, and
      // holding one (or several) with its lines ran the hook out of memory. First pass: does the log mention a
      // Router write or a never-upload tool, and which session started it. A log with neither has its origin read
      // from its first 2,000,000 characters only, as before.
      const fileName = basename(log.path), HEAD_CHARS = 2_000_000;
      const fullOrigin = originReader(fileName), headOrigin = originReader(fileName);
      let full = false, chars = 0;
      await eachLine(log.path, line => {
        if (!full && (mentionsRouterWrite(line) || mentionsNeverUpload(line, neverUpload))) full = true;
        fullOrigin.push(line);
        const end = chars + line.length;   // where this line's newline is in the whole text
        if (end < HEAD_CHARS) headOrigin.push(line);
        chars = end + 1;
        return full && fullOrigin.done;
      });
      state.unchanged[log.path] = { bytes: log.bytes, mtimeMs: log.mtimeMs };
      // Every log's ancestry is recorded, also when it holds no post: it may sit between two that do.
      const origin = full || chars - 1 <= HEAD_CHARS ? fullOrigin.result() : headOrigin.result();
      if (origin.logSessionId) {
        const known = state.sessions[origin.logSessionId] ||= {};
        if (origin.parentSessionId) known.parent = origin.parentSessionId;
        if (origin.startsFromSummary) known.summary = true;
      }
      if (!full) continue;
      // Second pass: the posts, each with the fingerprint of its slice. Slices follow one another from the first
      // line, so one running hash covers the slice being read.
      const finder = postFinder({ neverUpload, excludedSessions: excluded(), origin });
      const hashes = [];
      let sliceStart = 0, running = createHash('sha256');
      await eachLine(log.path, (line, i) => {
        running.update(i > sliceStart ? '\n' + line : line);
        const before = finder.posts.length;
        finder.push(line, i);
        for (let k = before; k < finder.posts.length; k++) {
          const post = finder.posts[k];
          if (post.firstLine > post.lastLine) { hashes[k] = EMPTY_SLICE; continue; }   // a second post answered on the same line
          if (post.firstLine !== sliceStart || post.lastLine !== i) throw new Error('A post slice did not start where the last one ended.');
          hashes[k] = running.digest('hex'); running = createHash('sha256'); sliceStart = i + 1;
        }
      });
      const found = finder.result();
      if (found.calledNeverUpload && found.logSessionId) state.sessions[found.logSessionId].called = true;
      if (!found.posts.length) continue;
      totals.logs_with_posts++; totals.failed_writes += found.failedWrites; totals.unrecognized_receipts += found.unrecognizedResults;
      scanned.push({ path: log.path, parent: found.parentSessionId, posts: found.posts.map((post, k) => ({ ...post, hash: hashes[k] })) });
    }
  }
  const now = new Date().toISOString();
  for (const log of scanned) {
    // The session that started this one may have been read later in the same run.
    const viaParent = isExcluded(log.parent) ? VIA_PARENT : null;
    for (const post of log.posts) {
      totals.posts_found++;
      const withheld = post.withheld || viaParent || undefined, known = state.index[post.entryId];
      if (known) { if (withheld && !known.withheld && known.log === log.path) known.withheld = withheld; continue; }   // a resumed session repeats its history; the first log seen keeps the post
      state.index[post.entryId] = { agent: post.agent, log: log.path, first_line: post.firstLine, last_line: post.lastLine, session_id: post.sessionId,
        posted_at: post.postedAt, previous_entry_id: post.previousEntryId, withheld, slice_sha256: post.hash, tool: post.tool, indexed_at: now };
      totals.newly_indexed++;
    }
  }
  // Which of these posts (all from one log) this machine's copy holds exactly as indexed. Read fresh each time it is
  // asked, one line at a time, and only as far as the last of their slices. With `tools`, also the tool that made
  // each post, read again from the copy (as findPosts over the copy would find it; the session's origin plays no
  // part in which tool or lines a post has, so none is read).
  async function copyCheck(entryIds, { tools = false } = {}) {
    const items = entryIds.map(id => [id, state.index[id]]).filter(([, item]) => item);
    const copy = items.length && state.copies[items[0][1].log];
    const result = new Map();
    const usable = copy ? items.filter(([, item]) => item.log === items[0][1].log && copy.lines >= item.last_line + 1) : [];
    if (!usable.length) return result;
    const ranges = usable.map(([id, item]) => ({ id, first: item.first_line, last: item.last_line }));
    const hasher = sliceHasher(ranges), last = Math.max(...ranges.map(r => r.last));
    const finder = tools ? postFinder({ neverUpload: [], origin: { sessionId: null, logSessionId: null, parentSessionId: null, startsFromSummary: false } }) : null;
    totals.copy_reads++;
    // Read one line past the last slice: every line of a copy ends with a newline, so line r.last is known to be
    // complete in the copy only when a line r.last + 1 (if only the empty one after the final newline) follows it.
    const read = await eachLine(copy.file, (line, i) => { hasher.push(line, i); finder?.push(line, i); return i > last; }).catch(() => null);
    if (read === null) return result;
    for (const r of ranges) {
      // A copy cut short would otherwise match an empty slice (a second post answered on the same line) by its empty
      // hash, whatever its recorded line count says.
      if (read <= r.last + 1 || hasher.digest(r) !== state.index[r.id].slice_sha256) continue;
      const post = finder?.posts.find(p => p.entryId === r.id && p.firstLine === r.first && p.lastLine === r.last);
      result.set(r.id, { tool: post?.tool || null });
    }
    return result;
  }
  // The automatic path (--pointers-only, which the plugin's hook runs) registers only posts made by this plugin's
  // own Router server in Claude Code. The tool is read again from the copy, so an index entry made before tools were
  // recorded is judged the same way. Codex names its MCP servers as each person configured them, so there is no
  // fixed name to check, and Codex posts are left to the manual --pointers command.
  const ROUTER_TOOL = /^mcp__plugin_teleport-router_router__(?:router_write_entry|write_to_shared_notebook|channel_[\w-]+|skill_[\w-]+)$/;
  const madeByRouter = (entryId, held) => state.index[entryId].agent === 'claude-code' && ROUTER_TOOL.test(held.tool || '');
  // This machine's own copy of each log, from its first line to the last line of the last post this index takes
  // from it and does not withhold. The slices of a log's posts follow one another from its first line, so this is
  // exactly those posts' slices; nothing after the last of them is copied, nor anything from a log whose posts are
  // all withheld. The copy is used only when the original log is gone.
  for (const log of scanned) {
    // A post's ID can appear more than once in a log, for example when a later Router call returns the same note's
    // receipt. The index keeps the first; only that slice is checked and copied.
    const mine = log.posts.filter(p => { const e = state.index[p.entryId]; return e?.log === log.path && !e.withheld && p.firstLine === e.first_line && p.lastLine === e.last_line; });
    if (!mine.length) continue;
    const needed = Math.max(...mine.map(p => p.lastLine)) + 1;
    // Rewritten when it would not cover the newest post, or when the copy file has gone.
    if ((state.copies[log.path]?.lines || 0) >= needed && await lstat(state.copies[log.path].file).then(f => f.isFile(), () => false)) continue;
    const file = join(copiesDir, createHash('sha256').update(log.path).digest('hex').slice(0, 16), basename(log.path));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      // Streamed from the log to the copy, one line at a time. The log may have been appended to since it was read,
      // never rewritten; the slices are checked again as they are copied, and the copy is kept only if they match.
      const ranges = mine.map(p => ({ first: p.firstLine, last: p.lastLine, entryId: p.entryId }));
      const hasher = sliceHasher(ranges), out = await open(tmp, 'w', 0o600);
      let copied = 0;
      try {
        let batch = [], size = 0;
        // writeFile on the handle writes the whole batch at the current position, however many writes that takes.
        const flush = async () => { if (batch.length) { const text = batch.join(''); batch = []; size = 0; await out.writeFile(text); } };
        await eachLine(log.path, (line, i) => {
          hasher.push(line, i); batch.push(line, '\n'); size += line.length + 1; copied = i + 1;
          const done = copied >= needed;
          return done || size >= 4 * 1024 * 1024 ? flush().then(() => done) : false;
        });
        await flush();
      } finally { await out.close(); }
      if (copied < needed || ranges.some(r => hasher.digest(r) !== state.index[r.entryId].slice_sha256)) throw new Error('changed while it was read');
      await rename(tmp, file);
      state.copies[log.path] = { file, lines: needed, at: now };
      // Read back: a pointer is registered only for a post whose slice the copy is known to hold.
      const ids = [...new Set(mine.map(p => p.entryId))];
      if ((await copyCheck(ids)).size !== ids.length) { delete state.copies[log.path]; throw new Error('the copy did not read back the same'); }
      totals.copies_written++;
    } catch (err) { await rm(tmp, { force: true }).catch(() => {}); delete state.unchanged[log.path]; report.push({ log: basename(log.path), error: `Could not copy its lines: ${err.message}` }); }
  }
  for (const [path, seen] of Object.entries(state.unchanged)) if (seen.mtimeMs < Date.now() - 45 * 86400_000) delete state.unchanged[path];
  totals.indexed_total = Object.keys(state.index).length;
  totals.indexed_withheld = Object.values(state.index).filter(i => i.withheld).length;
  await saveState();

  // 2. Pointers, only when asked: tell Router that these posts have a trace held on this machine. Only the post's
  // ID, the agent kind and the fingerprint of its log lines are sent. Only posts from the logs this run looked at
  // count, so only posts whose session log is still here and changed within --days. Withheld posts get none, and
  // neither does a post whose slice this machine's copy does not hold, so a pointer always has a trace behind it.
  const pointersOff = rules.pointers === false;
  if (pointersAsked && !pointersOff) {
    if (!routerKey) await stop('--pointers needs your Router key: --key-file <file> or the ROUTER_KEY environment variable. Nothing was sent.');
    const seen = Object.keys(state.index).filter(id => read.has(state.index[id].log));
    const onlyRouterTool = flag('--pointers-only');
    const wanting = entryId => {
      const known = state.pointers[entryId];
      return !state.index[entryId].withheld && !(known && !known.skipped) && !(known?.skipped && (known.tries || 1) >= 3);
    };
    // Each log's copy is read once for all its posts that may get a pointer, not once per post.
    const byLog = new Map();
    for (const entryId of seen.filter(wanting)) { const log = state.index[entryId].log; byLog.set(log, [...(byLog.get(log) || []), entryId]); }
    const heldInCopy = new Map();
    for (const ids of byLog.values()) for (const [id, held] of await copyCheck(ids, { tools: onlyRouterTool })) heldInCopy.set(id, held);
    for (const entryId of seen) {
      const item = state.index[entryId], known = state.pointers[entryId];
      if (item.withheld) { if (!state.pointers[entryId]) totals.pointers_withheld++; continue; }
      if (!wanting(entryId)) continue;
      const held = heldInCopy.get(entryId);
      if (!held) { totals.pointers_without_copy++; continue; }
      if (onlyRouterTool && !madeByRouter(entryId, held)) { totals.pointers_not_router_tool++; continue; }
      try {
        const r = await fetch(router + '/api/trace-pointers', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${routerKey}` },
          body: JSON.stringify({ entry_id: entryId, agent: item.agent || 'claude-code', slice_sha256: item.slice_sha256 }), signal: AbortSignal.timeout(20_000) });
        const data = await r.json().catch(() => ({}));
        if (r.ok) { state.pointers[entryId] = { at: new Date().toISOString(), state: data.trace }; data.registered ? totals.pointers_registered++ : totals.pointers_already++; }
        // Another account's post, or one deleted: tried on three runs before it is left alone.
        else if (r.status === 404) state.pointers[entryId] = { skipped: 'not your post, or deleted', tries: (known?.tries || 0) + 1, at: new Date().toISOString() };
        else { totals.pointers_failed++; report.push({ entry: entryId, error: `Pointer not registered: ${data.error || `Router answered ${r.status}`}` }); if (r.status === 401) break; }
      } catch (err) { totals.pointers_failed++; report.push({ entry: entryId, error: `Pointer not registered: ${err.message}` }); break; }
    }
    await saveState();
  }

  // 3. Upload only what was named.
  const wanted = flag('--upload-all')
    ? Object.keys(state.index).filter(id => { const t = state.traces[id]; return !t || (t.skipped && (t.tries || 1) < 3); })
    : [...new Set(values('--upload'))];
  // Uploading without rules would mean nobody decided what must stay on the machine.
  if (wanted.length && !uploadRules) await stop(`Before the first upload, ${rulesText === null ? 'create' : 'add to'} ${rulesPath} the list of tools whose results must never be uploaded, for example { "never_upload_tools": ["mcp__diary__"] }. An empty list is allowed: { "never_upload_tools": [] }. Nothing was uploaded.`);
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
  const extraction = flag('--extraction-copy');
  let release = null;
  async function releaseKey() {
    if (release) return release;
    // As with the owner key: the key an extraction copy is wrapped to must be one the owner checked, not one Router reported.
    const status = await call('/api/insights/consent/status');
    if (!status.active) await stop(`--extraction-copy needs a current insights consent (${status.reason}). Nothing was uploaded.`);
    const pinned = value('--release-key') ? compressPublicKey(value('--release-key')) : state.enclave?.releaseKey;
    if (!pinned) await stop('The first extraction copy needs --release-key <the enclave key you checked with insights-owner.mjs enclave>. Nothing was uploaded.');
    if (state.enclave && state.enclave.releaseKey !== pinned) await stop(`The enclave key given differs from the one remembered in ${statePath}. Nothing was uploaded.`);
    if (compressPublicKey(status.release_key) !== pinned || compressPublicKey(status.policy.enclave.releaseKey) !== pinned)
      await stop('Router or your consent names an enclave key other than the one you checked. Nothing was uploaded.');
    if (!state.enclave) { state.enclave = { releaseKey: pinned, confirmedAt: new Date().toISOString() }; await saveState(); }
    return release = { publicKey: pinned, policyId: status.policy.policyId };
  }

  // findPosts over a whole log (or this machine's copy of it), read one line at a time. Of the lines, only the first
  // and those of the indexed slice are kept, at their own positions: all that sourceOf and buildTrace read. The rest
  // of the array is empty, and its length is the log's line count.
  async function readForUpload(path, item) {
    const fileName = basename(item.log), origin = originReader(fileName);
    await eachLine(path, line => { origin.push(line); return origin.done; });
    const finder = postFinder({ neverUpload, excludedSessions: excluded(), origin: origin.result() });
    const lines = [];
    const count = await eachLine(path, (line, i) => {
      if (i === 0 || (i >= item.first_line && i <= item.last_line)) lines[i] = line;
      finder.push(line, i);
    });
    lines.length = count;
    return { lines, found: finder.result() };
  }
  for (const entryId of wanted) {
    const item = state.index[entryId], known = state.traces[entryId];
    if (!item) { totals.failed++; report.push({ entry: entryId, error: 'No session log on this machine is indexed for that post. Try a larger --days.' }); continue; }
    if (known && !known.skipped) { totals.already_uploaded++; continue; }
    const line = { entry: entryId, agent: item.agent, session: item.session_id?.slice(0, 8), posted_at: item.posted_at };
    let built, small = null, fromCopy = false;
    try {
      // The original log, or this machine's copy of its lines once the agent has cleaned the original up.
      // Read one line at a time; only the first line and this post's slice are kept (see readForUpload).
      let read = await readForUpload(item.log, item).catch(err => { if (err.code !== 'ENOENT') throw err; return null; });
      const copy = state.copies[item.log];
      if (!read && copy) { read = await readForUpload(copy.file, item).catch(() => null); fromCopy = !!read; }
      let post, lines = read?.lines;
      if (read) {
        // Decide again whether this trace may be uploaded: an exclusion may have been learned since it was indexed.
        const fresh = read.found;
        post = fresh.posts.find(p => p.entryId === entryId);
        if (!post || post.firstLine !== item.first_line || post.lastLine !== item.last_line || sliceHash(lines, post) !== item.slice_sha256) throw new Error('The session log changed since this post was indexed.');
        post.withheld ||= item.withheld || (isExcluded(fresh.parentSessionId) ? VIA_PARENT : null);
        if (post.withheld && !item.withheld) item.withheld = post.withheld;
      } else if (item.withheld) {
        // A withheld record holds no log lines, so it can be made from the index alone. Withheld posts are never copied.
        post = { entryId, agent: item.agent, firstLine: item.first_line, lastLine: item.last_line, previousEntryId: item.previous_entry_id,
          sessionId: item.session_id, postedAt: item.posted_at, withheld: item.withheld };
        lines = [];
      } else throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      const where = lines.length ? sourceOf(lines, post) : { cwd: null, git_branch: null, agent_version: null };
      built = buildTrace({ post, lines, source: { log: basename(item.log), ...where }, extraSecrets: [routerKey].filter(Boolean), maxBytes: (await ownerKey()).maxBytes - 64 * 1024 });
      if (extraction && !built.summary.withheld)
        small = buildTrace({ post, lines, source: { log: basename(item.log), ...where }, extraSecrets: [routerKey].filter(Boolean), maxBytes: EXTRACTION_MAX_BYTES });
    } catch (err) { totals.failed++; report.push({ ...line, error: err.code === 'ENOENT' ? 'The session log is no longer on this machine, and no copy of it was kept.' : err.message }); continue; }
    Object.assign(line, { records: built.summary.records, bytes: built.plaintext.length, withheld: built.summary.withheld, secrets_removed: built.summary.secrets_removed ?? 0, shortened_to: built.summary.shortened_to });
    if (built.summary.withheld) totals.withheld++;
    const o = await ownerKey();
    const sealed = sealFull(built.plaintext, { ownerDid: o.did, entryId }, o.publicKey);
    let derived;
    if (small) {
      const r = await releaseKey();
      const s = sealDerived(small.plaintext, { ownerDid: o.did, entryId }, o.publicKey, r.publicKey);
      derived = { meta: s.meta, data: s.ciphertext.toString('base64'), policy_id: r.policyId };
    }
    try {
      const stored = await call('/api/traces', { entry_id: entryId, full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') }, ...(derived ? { derived } : {}) });
      state.traces[entryId] = { sha256: stored.full_sha256, bytes: sealed.meta.bytes, at: new Date().toISOString(), withheld: built.summary.withheld || undefined,
        extraction_sha256: stored.derived_sha256 || undefined };
      totals.uploaded++; if (fromCopy) totals.uploaded_from_copy++; report.push({ ...line, uploaded: true, ...(fromCopy ? { from_copy: true } : {}) });
    } catch (err) {
      if (/already has its trace/.test(err.message)) { state.traces[entryId] = { existing: true, at: new Date().toISOString() }; totals.already_uploaded++; }
      // Tried on three runs before it is left alone: the post's group storage may only have been unreachable.
      else if (/not one of your posts/.test(err.message)) { state.traces[entryId] = { skipped: 'not your post, or deleted', tries: (known?.tries || 0) + 1, at: new Date().toISOString() }; totals.not_your_post++; }
      else { totals.failed++; report.push({ ...line, error: err.message }); if (err.status === 401 || err.status === 404) { await saveState(); break; } }
    }
    await saveState();
  }
  const pointing = pointersAsked && !pointersOff;
  const mode = wanted.length ? (pointing ? 'index, pointers and upload' : 'index and upload')
    : pointing ? 'index and pointers (post IDs, agent kind and fingerprints sent; no trace)' : 'index only (nothing sent)';
  console.log(JSON.stringify({ mode, router: wanted.length || pointing ? router : undefined, days, pointers: pointersAsked && pointersOff ? 'off in your rules; nothing registered' : undefined,
    ...totals, traces: report }, null, 1));
  if (totals.failed || totals.pointers_failed) process.exitCode = 1;
} finally { await unlock(); }
