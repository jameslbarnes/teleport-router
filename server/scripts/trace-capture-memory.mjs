// The capture script with large session logs and a small heap, with synthetic data only.
//
// Writes about 150 MB of synthetic Claude Code and Codex session logs into a scratch folder: many records with long
// tool output, Router write tools named throughout (so lines are parsed, not only scanned), twenty posts spread through
// the Claude Code log with the last one near its end, and one Codex post at the end of the Codex log. The capture
// script then runs with its JavaScript heap capped at 256 MB, as the plugin's hook might on a machine with large logs:
// first index-only (nothing sent), then --pointers-only against a local Router in memory. Before the fix, holding
// each log whole (and reading the copy back once per post, all at once) ran the script past 4 GB on logs like these.
//
// Checks: both runs finish; every post is indexed with the right slice and fingerprint; each copy is read once per run, not once per post; the copy of each log is
// exactly its lines up to the last post; the pointer-only run registers the Claude Code posts and not the Codex one.
//
// Run from server/: npm run build && node scripts/trace-capture-memory.mjs
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { once } from 'node:events';

const run = promisify(execFile);
const cli = resolve('../plugins/teleport-router/scripts/capture-traces.mjs');
const HEAP_MB = 256;
const work = await mkdtemp(join(tmpdir(), 'router-trace-memory-synthetic-'));
const cleanEnv = home => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: join(home, '.codex'), ROUTER_KEY: '',
  CLAUDE_PLUGIN_OPTION_ROUTER_KEY: '', TELEPORT_ROUTER_URL: '' });
const TOOL = 'mcp__plugin_teleport-router_router__router_write_entry';

/** Writes lines to a file one at a time; returns the line count. */
async function writeLines(path, produce) {
  const out = createWriteStream(path);
  let n = 0;
  const put = async line => { n++; if (!out.write(line + '\n')) await once(out, 'drain'); };
  await produce(put);
  out.end(); await once(out, 'finish');
  return n;
}
// Text that looks like tool output: varied words, no secrets, compresses poorly enough to be realistic.
const filler = (seed, bytes) => {
  const words = ['const', 'return', 'await', 'function', 'import', 'export', 'value', 'result', 'path', 'node', 'server', 'trace', 'line', 'error', 'test', 'build'];
  let s = '', x = seed;
  while (s.length < bytes) { x = (x * 1103515245 + 12345) & 0x7fffffff; s += words[x % words.length] + (x % 7 === 0 ? '\n' : ' ') + (x % 13 === 0 ? `${x} ` : ''); }
  return s;
};

/** A Claude Code log of about `mb` megabytes, with a post after every 1/ids.length of it and some lines after the last. */
async function claudeLog(path, session, ids, mb) {
  let n = 0, used = 0;
  const t0 = Date.now();
  const rec = (type, message, extra = {}) => JSON.stringify({ type, uuid: `u${++n}`, parentUuid: `u${n - 1}`, sessionId: session, timestamp: new Date(t0 + n * 1000).toISOString(),
    cwd: '/work/memory', version: '0.0.0-synthetic', gitBranch: 'main', ...(message ? { message } : {}), ...extra });
  const posts = [];
  const lines = await writeLines(path, async put => {
    const per = (mb * 1024 * 1024) / ids.length;
    let line = 0;
    const emit = async s => { await put(s); used += s.length + 1; line++; };
    for (let p = 0; p < ids.length; p++) {
      const first = line;
      await emit(rec('user', { role: 'user', content: `MARKER-${p} please work on item ${p}` }));
      while (used < per * (p + 1) - 200_000) {
        const id = `t${n}`;
        // Tool output that mentions skill_ and channel_ (as real logs do), so these lines are parsed, not only scanned.
        await emit(rec('assistant', { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `grep -r skill_ channel_ src # ${n}` } }] }));
        await emit(rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: filler(n, 40_000 + (n % 5) * 20_000) }] }, { toolUseResult: { stdout: 'channel_ skill_' } }));
        await emit(rec('assistant', { role: 'assistant', content: [{ type: 'text', text: filler(n + 1, 2_000) }] }));
      }
      const use = `w${p}`;
      await emit(rec('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: use, name: TOOL, input: { content: `note ${p}` } }] }));
      await emit(rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: JSON.stringify({ receipt: { version: 1, entry_id: ids[p], state: 'pending' } }) }] }));
      posts.push({ id: ids[p], first, last: line - 1 });
    }
    // Work after the last post, which the copy must leave out.
    for (let k = 0; k < 20; k++) await emit(rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: `after${k}`, content: filler(k, 50_000) }] }));
  });
  return { posts, lines };
}

/** A Codex log of about `mb` megabytes with one Router post at its end. */
async function codexLog(path, id, mb) {
  const cx = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
  let used = 0, line = 0;
  const lines = await writeLines(path, async put => {
    const emit = async s => { await put(s); used += s.length + 1; line++; };
    await emit(cx('session_meta', { id: 'cx-memory-thread', cwd: '/work/codex', cli_version: '0.0.0-synthetic' }));
    await emit(cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'MARKER-CODEX post this' }] }));
    for (let k = 0; used < mb * 1024 * 1024; k++) {
      await emit(cx('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['rg', 'skill_', 'channel_'] }), call_id: `c${k}` }));
      await emit(cx('response_item', { type: 'function_call_output', call_id: `c${k}`, output: filler(k, 60_000) }));
      await emit(cx('event_msg', { type: 'exec_command_end', call_id: `c${k}`, stdout: filler(k + 1, 30_000) }));
    }
    await emit(cx('event_msg', { type: 'item_completed', thread_id: 'cx-memory-thread', item: { type: 'McpToolCall', server: 'router', tool: 'router_write_entry', status: 'completed',
      arguments: { content: 'codex note' }, result: { content: [{ type: 'text', text: `Saved.\nEntry ID: ${id}` }] } } }));
  });
  return { post: { id, first: 0, last: line - 1 }, lines };
}

// The test itself may hold a whole log (its heap is not capped); the script under test may not.
const linesOf = async path => (await readFile(path, 'utf8')).split('\n');
const sliceSha = (lines, first, last) => createHash('sha256').update(lines.slice(first, last + 1).join('\n')).digest('hex');

function startServer(port) {
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/http.js'], { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PORT: String(port), LISTEN_HOST: '127.0.0.1', BASE_URL: base, NODE_ENV: 'test', INSIGHTS_RELEASE: '', ANTHROPIC_API_KEY: '', TINYCLOUD_AUTHORS: '', TRACE_STORAGE: 'off',
    FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '', MODERATOR_URL: '', MODERATOR_API_KEY: '',
    TINYCLOUD_GROUPS: '', STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', SENDGRID_API_KEY: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' } });
  let logs = ''; for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + String(d)).slice(-6000); });
  const send = (path, body, key, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const post = async (path, body, key) => { const r = await send(path, body, key), j = await r.json(); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`); return j; };
  const pointer = async (id, key) => (await (await send(`/api/trace-pointers?entry=${encodeURIComponent(id)}`, null, key, 'GET')).json()).trace;
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(`Local Router exited ${server.exitCode}: ${logs.slice(-1500)}`);
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('Local Router did not start');
  };
  return { base, post, pointer, ready, stop: () => { if (!server.killed) server.kill(); } };
}

let A;
try {
  A = startServer(25000 + Math.floor(Math.random() * 2000));
  await A.ready();
  const secretKey = randomBytes(32).toString('base64url');
  await A.post('/api/identity/register', { secret_key: secretKey, handle: `mem${Date.now().toString(36).slice(-6)}` });
  const write = async content => { const w = await A.post('/api/entries', { secret_key: secretKey, content, posting_intent: 'user-requested' }); return (w.receipt || w).entry_id; };
  const claudeIds = [];
  for (let i = 0; i < 20; i++) claudeIds.push(await write(`Synthetic note ${i} from a large session.`));
  const codexId = await write('Synthetic note from a large Codex session.');

  const home = join(work, 'home'), projects = join(home, '.claude', 'projects', '-work-memory'), sessions = join(home, '.codex', 'sessions', '2026', '11', '26');
  await mkdir(projects, { recursive: true }); await mkdir(sessions, { recursive: true });
  const claudePath = join(projects, '1e1e1e1e-memory.jsonl'), codexPath = join(sessions, 'rollout-memory.jsonl');
  const claude = await claudeLog(claudePath, '1e1e1e1e-memory', claudeIds, 100);
  const codex = await codexLog(codexPath, codexId, 55);
  const total = (await stat(claudePath)).size + (await stat(codexPath)).size;
  assert(total > 150 * 1024 * 1024, `the synthetic logs are over 150 MB (${total} bytes)`);
  console.log(`PASS (setup) ${(total / 1048576).toFixed(0)} MB of synthetic logs: ${claude.lines} Claude Code lines with ${claudeIds.length} posts, ${codex.lines} Codex lines with 1 post`);

  const keyFile = join(work, 'router.key');
  await writeFile(keyFile, secretKey);
  const stateFile = join(home, '.router', 'traces', 'state.json');
  const capture = async (...args) => {
    const r = await run(process.execPath, [`--max-old-space-size=${HEAP_MB}`, cli, '--router', A.base, '--key-file', keyFile, '--state', stateFile,
      `--projects=${join(home, '.claude', 'projects')}`, `--projects=${join(home, '.codex', 'sessions')}`, ...args], { env: cleanEnv(home), maxBuffer: 16 * 1024 * 1024, timeout: 600_000 })
      .catch(e => { throw new Error(`capture exited ${e.code}: ${String(e.stderr).split('\n').filter(l => l && !/^\s*\d+: /.test(l)).slice(-6).join(' | ')}`); });
    return JSON.parse(r.stdout);
  };

  // Index only: nothing sent.
  const plain = await capture();
  assert.equal(plain.mode, 'index only (nothing sent)');
  assert.equal(plain.newly_indexed, claudeIds.length + 1, JSON.stringify(plain)); assert.equal(plain.copies_written, 2); assert.equal(plain.logs_too_large, 0);
  assert.equal(plain.copy_reads, 2, 'each new copy is read back once, for all of its posts');
  console.log(`PASS index-only run with a ${HEAP_MB} MB heap indexes all ${claudeIds.length + 1} posts and copies both logs`);

  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  let lines = await linesOf(claudePath);
  for (const p of claude.posts) {
    const item = state.index[p.id];
    assert(item, `post ${p.id} indexed`);
    assert.deepEqual([item.first_line, item.last_line, item.agent, item.tool], [p.first, p.last, 'claude-code', TOOL]);
    assert.equal(item.slice_sha256, sliceSha(lines, p.first, p.last), 'the fingerprint is the SHA-256 of the slice');
  }
  const cxItem = state.index[codexId];
  assert.deepEqual([cxItem.first_line, cxItem.last_line, cxItem.agent], [codex.post.first, codex.post.last, 'codex']);
  assert.equal(cxItem.slice_sha256, sliceSha(await linesOf(codexPath), codex.post.first, codex.post.last));
  console.log('PASS every post has the right slice and fingerprint, including the last post near the end of each log');

  const last = claude.posts.at(-1);
  assert.equal(state.copies[claudePath].lines, last.last + 1);
  assert(last.last + 1 < claude.lines, 'the Claude Code log goes on after its last post');
  assert(await readFile(state.copies[claudePath].file, 'utf8') === lines.slice(0, last.last + 1).join('\n') + '\n', 'the copy is the log up to its last post');
  lines = null;
  assert(await readFile(state.copies[codexPath].file, 'utf8') === await readFile(codexPath, 'utf8'), 'the Codex copy is the whole log, which ends with its post');
  console.log('PASS each copy is exactly its log\'s lines up to the last post');

  // The hook's mode, against the local Router.
  const pointed = await capture('--pointers-only');
  assert.equal(pointed.pointers_registered, claudeIds.length, JSON.stringify(pointed)); assert.equal(pointed.pointers_not_router_tool, 1); assert.equal(pointed.pointers_failed, 0);
  assert.equal(pointed.copy_reads, 2, "registering reads each log's copy once, not once per post");
  for (const id of claudeIds) assert.equal(await A.pointer(id, secretKey), 'held_locally');
  assert.equal(await A.pointer(codexId, secretKey), null, 'the Codex post gets no pointer from the automatic path');
  console.log(`PASS --pointers-only with a ${HEAP_MB} MB heap registers the ${claudeIds.length} Claude Code posts and not the Codex one`);
  console.log('\nALL PASSED (synthetic data)');
} catch (err) {
  console.error('FAILED:', err?.stack || err); process.exitCode = 1;
} finally {
  A?.stop();
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
