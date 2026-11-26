// Trace pointers, end to end, with a synthetic person and synthetic session logs only.
//
// Part A, a local Router in memory with no storage service at all: the capture script and the plugin's hook
// register pointers with only a Router key (no rules file, no storage key, no linked storage); a second run
// sends nothing; "pointers": false sends nothing; the script keeps its own copy of the log lines.
// Part B, a local Router with real hosted TinyCloud storage (as scripts/trace-capture-e2e.mjs): the original
// session log is deleted, another account asks to run an app on the pointer-only post, and the owner tool's
// `run` uploads the trace from the script's copy and then runs the app (simulated attestation, local only).
// Part B is skipped, and says so, when TinyCloud cannot be reached or SKIP_TINYCLOUD=1.
//
// Run from server/: npm run build && node scripts/trace-pointer-e2e.mjs
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const cli = resolve('../plugins/teleport-router/scripts/capture-traces.mjs');
const hook = resolve('../plugins/teleport-router/hooks/register-pointers.mjs');
const ownerTool = resolve('scripts/trace-app-owner.mjs');
const work = await mkdtemp(join(tmpdir(), 'router-trace-pointer-synthetic-'));
const privateKey = () => `0x${randomBytes(32).toString('hex')}`;
// Never read the real machine's logs or keys: every default location points into the scratch folder.
const cleanEnv = home => ({ ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: join(home, '.codex'), ROUTER_KEY: '',
  CLAUDE_PLUGIN_OPTION_ROUTER_KEY: '', TELEPORT_ROUTER_URL: '' });

function startServer(port, extra) {
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/http.js'], { cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env,
    PORT: String(port), LISTEN_HOST: '127.0.0.1', BASE_URL: base, NODE_ENV: 'test', INSIGHTS_RELEASE: '', ANTHROPIC_API_KEY: '',
    FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '', MODERATOR_URL: '', MODERATOR_API_KEY: '',
    TINYCLOUD_GROUPS: '', STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', SENDGRID_API_KEY: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', ...extra } });
  let logs = ''; for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + String(d)).slice(-6000); });
  const send = (path, body, key, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const post = async (path, body, key) => { const r = await send(path, body, key), j = await r.json(); if (!r.ok) throw new Error(`${path}: HTTP ${r.status}${j.error ? ` (${String(j.error).slice(0, 250)})` : ''}`); return j; };
  const pointer = async (id, key) => { const r = await send(`/api/trace-pointers?entry=${encodeURIComponent(id)}`, null, key, 'GET'); return { status: r.status, body: await r.json() }; };
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(`Local Router exited ${server.exitCode}: ${logs.slice(-1500)}`);
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('Local Router did not start');
  };
  return { base, server, send, post, pointer, ready, logs: () => logs, stop: () => { if (!server.killed) server.kill(); } };
}

/** Two posts in one synthetic Claude Code session log, with a marker phrase in each slice. */
function claudeLog(session, ids, words = ["ALPHA", "BETA"], tools = []) {
  let n = 0;
  const rec = (type, message, extra = {}) => JSON.stringify({ type, uuid: `u${++n}`, sessionId: session, timestamp: new Date(Date.now() + n * 1000).toISOString(), cwd: '/work/pointers', version: '0.0.0-synthetic', ...(message ? { message } : {}), ...extra });
  const tool = 'mcp__plugin_teleport-router_router__router_write_entry';
  const use = (id, name, input) => rec('assistant', { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
  const result = (id, content) => rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] });
  const lines = [];
  ids.forEach((id, i) => lines.push(rec('user', { role: 'user', content: `MARKER-${words[i]} work item ${i}` }), use(`w${i}`, tools[i] || tool, { entry: `note ${i}` }),
    result(`w${i}`, JSON.stringify({ receipt: { version: 1, entry_id: id, state: 'pending' } }))));
  return lines.join('\n') + '\n';
}

const cleanup = [];
try {
  // ── Part A ────────────────────────────────────────────────────────────────────────────
  const A = startServer(21000 + Math.floor(Math.random() * 2000), { TINYCLOUD_AUTHORS: '', TRACE_STORAGE: 'off' });
  cleanup.push(A.stop);
  await A.ready();
  const handle = `ptr${Date.now().toString(36).slice(-6)}`, secretKey = randomBytes(32).toString('base64url');
  await A.post('/api/identity/register', { secret_key: secretKey, handle });
  const write = async content => { const w = await A.post('/api/entries', { secret_key: secretKey, content, posting_intent: 'user-requested' }); return (w.receipt || w).entry_id; };
  const ids = [await write('First synthetic note.'), await write('Second synthetic note.')];
  const home = join(work, 'home-a'), projects = join(home, '.claude', 'projects', '-work-pointers');
  await mkdir(projects, { recursive: true });
  const session = '1a1a1a1a-synthetic', logPath = join(projects, `${session}.jsonl`);
  await writeFile(logPath, claudeLog(session, ids));
  const keyFile = join(work, 'router.key'); await writeFile(keyFile, secretKey);
  const stateFile = join(home, '.router', 'traces', 'state.json');
  const capture = async (...args) => JSON.parse((await run(process.execPath, [cli, '--router', A.base, '--key-file', keyFile, '--projects', join(home, '.claude', 'projects'), '--state', stateFile, ...args], { env: cleanEnv(home) })).stdout);

  // The plain run still sends nothing, but keeps the copy.
  const plain = await capture();
  assert.equal(plain.mode, 'index only (nothing sent)'); assert.equal(plain.newly_indexed, 2); assert.equal(plain.copies_written, 1); assert.equal(plain.pointers_registered, 0);
  for (const id of ids) assert.equal((await A.pointer(id, secretKey)).body.trace, null, 'Nothing registered without --pointers');
  console.log('PASS without --pointers the script indexes and copies, and Router hears nothing');

  // No rules file, no storage key, no linked storage.
  await assert.rejects(stat(join(home, '.router', 'traces', 'rules.json')));
  const first = await capture('--pointers');
  assert.equal(first.pointers_registered, 2, JSON.stringify(first)); assert.equal(first.pointers_failed, 0);
  const state = JSON.parse(await readFile(stateFile, 'utf8'));
  for (const id of ids) {
    const seen = await A.pointer(id, secretKey);
    assert.equal(seen.status, 200); assert.equal(seen.body.trace, 'held_locally'); assert.equal(seen.body.agent, 'claude-code');
    assert.equal(seen.body.slice_sha256, state.index[id].slice_sha256, 'The pointer carries the index\'s fingerprint');
  }
  console.log('PASS --pointers registers a pointer per post with only a Router key: no rules file, no storage key, no linked storage');

  // What Router received is the ID, the agent kind and the fingerprint; nothing of the slice.
  for (const id of ids) assert.equal((await A.pointer(id)).status, 404, 'A waiting note\'s pointer is hidden from everyone but its author');
  const again = await capture('--pointers');
  assert.equal(again.pointers_registered, 0); assert.equal(again.pointers_already, 0); assert.equal(again.newly_indexed, 0); assert.equal(again.copies_written, 0);
  const forced = JSON.parse(await readFile(stateFile, 'utf8')); forced.pointers = {}; await writeFile(stateFile, JSON.stringify(forced));
  const resent = await capture('--pointers');
  assert.equal(resent.pointers_registered, 0); assert.equal(resent.pointers_already, 2, 'Registering again is a no-op on Router');
  console.log('PASS a second run sends nothing, and a repeated registration changes nothing');

  // The copy holds exactly the log's lines up to the last post, readable by the owner only.
  const copy = state.copies[logPath];
  assert(copy, 'A copy is recorded for the log');
  assert.equal(await readFile(copy.file, 'utf8'), await readFile(logPath, 'utf8'));
  if (process.platform !== 'win32') { assert.equal((await stat(copy.file)).mode & 0o777, 0o600); assert.equal((await stat(dirname(copy.file))).mode & 0o777, 0o700); }
  console.log(`PASS the script keeps its own copy of the log lines${process.platform === 'win32' ? ' (file modes not checked on Windows)' : ', mode 600 in a 700 folder'}`);

  // "pointers": false: indexing and copying go on, Router hears nothing. Such a file alone does not allow uploads.
  const third = await write('Third synthetic note.');
  await writeFile(join(projects, '2b2b2b2b-synthetic.jsonl'), claudeLog('2b2b2b2b-synthetic', [third], ['GAMMA']));
  await writeFile(join(home, '.router', 'traces', 'rules.json'), JSON.stringify({ pointers: false }));
  const off = await capture('--pointers');
  assert.equal(off.newly_indexed, 1); assert.equal(off.pointers_registered, 0); assert.match(off.pointers, /off in your rules/);
  assert.equal((await A.pointer(third, secretKey)).body.trace, null);
  const noUpload = await run(process.execPath, [cli, '--router', A.base, '--key-file', keyFile, '--projects', join(home, '.claude', 'projects'), '--state', stateFile, '--upload', third], { env: cleanEnv(home) }).then(() => null, e => e);
  assert(noUpload && /Before the first upload, add to/.test(noUpload.stderr), 'A rules file that only turns pointers off does not allow uploads');
  console.log('PASS "pointers": false registers nothing; it does not count as upload rules');

  // The plugin's hook. It never names a Router address, so a hook run would go to Router itself; here its plan
  // (the capture script's arguments) is checked, and the script is then run with that plan against this server.
  await rm(join(home, '.router', 'traces', 'rules.json'));
  const { plan, checkedLog } = await import(pathToFileURL(hook).href);
  const roots = [join(home, '.claude', 'projects')];
  const runPlan = async args => JSON.parse((await run(process.execPath, [cli, '--router', A.base, '--key-file', keyFile, '--state', stateFile, ...args], { env: cleanEnv(home) })).stdout);
  const fourth = await write('Fourth synthetic note, posted in the hooked session.');
  const hookLog = join(projects, '3c3c3c3c-synthetic.jsonl');
  await writeFile(hookLog, claudeLog('3c3c3c3c-synthetic', [fourth], ['DELTA']));
  const postPlan = await plan('post', { transcript_path: hookLog, tool_use_id: 'w0' }, { roots, waitMs: 2000 });
  assert.deepEqual(postPlan, ['--pointers-only', `--log=${await realpath(hookLog)}`]);
  const hooked = await runPlan(postPlan);
  assert.equal(hooked.pointers_registered, 1); assert.equal((await A.pointer(fourth, secretKey)).body.trace, 'held_locally', 'The PostToolUse plan registered the new post');
  const fifth = await write('Fifth synthetic note, found at the next session start.');
  await writeFile(join(projects, '4d4d4d4d-synthetic.jsonl'), claudeLog('4d4d4d4d-synthetic', [fifth], ['EPSILON']));
  const startPlan = await plan('start', { transcript_path: hookLog }, { roots });
  assert.equal(startPlan[0], '--pointers-only'); assert(startPlan.includes(`--projects=${await realpath(projects)}`));
  await runPlan(startPlan);
  assert.equal((await A.pointer(fifth, secretKey)).body.trace, 'held_locally', 'The SessionStart plan caught a post the other hook missed');
  for (const p of [postPlan, startPlan]) assert(!p.some(a => a.startsWith('--router')), 'The hook never names a Router address');
  console.log('PASS the hook\'s plans (always --pointers-only, never --router) register pointers');

  // Hook input is checked; flag-shaped values stay values; pointer-only refuses everything else.
  const outside = join(work, 'outside.jsonl'); await writeFile(outside, claudeLog('5f5f5f5f-outside', [fourth], ['ZETA']));
  const flagShaped = join(projects, '--upload.jsonl'); await writeFile(flagShaped, claudeLog('6a6a6a6a-flag', [fourth], ['ETA']));
  for (const [path, why] of [[outside, 'outside the session folders'], [join(projects, 'missing.jsonl'), 'missing'], [projects, 'a folder'],
    ['relative/log.jsonl', 'relative'], ['--upload', 'flag-shaped and relative'], [42, 'not a string']]) {
    assert.equal(await checkedLog(path, roots), null, `refused: ${why}`);
    assert.deepEqual(await plan('post', { transcript_path: path, tool_use_id: 'w0' }, { roots, waitMs: 0 }), ['--pointers-only', `--projects=${roots[0]}`, '--days', '1'], `falls back to a scan of Claude Code's folders: ${why}`);
    assert.deepEqual(await plan('start', { transcript_path: path }, { roots }), ['--pointers-only', `--projects=${roots[0]}`], `start falls back to a scan of Claude Code's folders: ${why}`);
  }
  let linked = false;
  try { await symlink(outside, join(projects, 'link.jsonl')); linked = true; } catch { /* links need extra rights on Windows */ }
  if (linked) {
    assert.equal(await checkedLog(join(projects, 'link.jsonl'), roots), null, 'a link out of the session folders is refused');
    const scan = await runPlan(['--pointers-only', '--projects', projects]);
    assert(!JSON.stringify(scan).includes('5f5f5f5f'), 'the scanner does not follow a link');
    await rm(join(projects, 'link.jsonl'));
  }
  const flagPlan = await plan('post', { transcript_path: flagShaped, tool_use_id: 'w0' }, { roots, waitMs: 1000 });
  assert.deepEqual(flagPlan, ['--pointers-only', `--log=${await realpath(flagShaped)}`]);
  const flagRun = await runPlan(flagPlan);
  assert.equal(flagRun.uploaded, 0); assert.equal(flagRun.failed, 0); assert.doesNotMatch(flagRun.mode, /upload/);
  const refusedRun = (...args) => run(process.execPath, [cli, '--router', A.base, '--key-file', keyFile, '--state', stateFile, ...args], { env: cleanEnv(home) }).then(() => null, e => e);
  for (const args of [['--log', '--upload', fourth], ['--pointers-only', '--upload', fourth], ['--pointers-only', '--upload-all'], ['--pointers-only', '--open', fourth],
    ['--pointers-only', '--extraction-copy'], ['stray-argument'], ['--no-such-option']]) {
    const e = await refusedRun(...args);
    assert(e && e.code === 1 && /Nothing was read or sent/.test(e.stderr), `refused: ${args.join(' ')}`);
  }
  console.log(`PASS hook input outside the session folders${linked ? ' (links included)' : ' (links not tested: no right to make one here)'} falls back to a scan of Claude Code's folders; values are never read as options; --pointers-only refuses everything but pointers`);

  // No environment variable redirects the key. With nothing to send, the run reports the address it would use.
  const emptyHome = join(work, 'home-empty'); await mkdir(join(emptyHome, '.claude', 'projects'), { recursive: true });
  const redirected = JSON.parse((await run(process.execPath, [cli, '--pointers', '--key-file', keyFile, '--state', join(emptyHome, 'state.json')],
    { env: { ...cleanEnv(emptyHome), TELEPORT_ROUTER_URL: A.base, ROUTER_URL: A.base } })).stdout);
  assert.equal(redirected.router, 'https://router.teleport.computer'); assert.equal(redirected.pointers_registered, 0);
  console.log('PASS the Router address comes only from --router or the default, never from the environment');

  // The hook process itself: quiet, never fails, does nothing without a key; with a key and a bad path it scans
  // the (here empty) default folders, so nothing is sent.
  const runHook = (env, mode, input) => new Promise((done, failed) => {
    const child = spawn(process.execPath, [hook, mode], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = ''; child.stdout.on('data', d => { out += d; }); child.stderr.on('data', d => { out += d; });
    child.on('error', failed); child.on('close', code => done({ code, out }));
    child.stdin.end(JSON.stringify(input));
  });
  for (const [env, mode, input] of [[cleanEnv(home), 'start', {}], [{ ...cleanEnv(emptyHome), CLAUDE_PLUGIN_OPTION_ROUTER_KEY: secretKey }, 'post', { transcript_path: outside, tool_use_id: 'w0' }],
    [{ ...cleanEnv(emptyHome), CLAUDE_PLUGIN_OPTION_ROUTER_KEY: secretKey }, 'start', { transcript_path: '--upload' }]]) {
    const r = await runHook(env, mode, input);
    assert.equal(r.code, 0); assert.equal(r.out, '', 'The hook prints nothing and exits cleanly');
  }
  console.log('PASS the hook process is quiet, never fails, and does nothing without a key');

  // A plugin folder reached through a link (a symlink, or a junction on Windows) must still run the hook: Node resolves
  // links in import.meta.url but not in argv. Before 0.6.2 such a hook silently did nothing.
  {
    const { isEntry } = await import(pathToFileURL(hook).href);
    const linkDir = join(await mkdtemp(join(tmpdir(), 'hook-link-')), 'hooks');
    let made = true;
    await symlink(dirname(hook), linkDir, process.platform === 'win32' ? 'junction' : 'dir').catch(() => { made = false; });
    if (made) {
      assert.equal(isEntry(join(linkDir, 'register-pointers.mjs'), hook), true, 'Run through a linked folder, the hook knows it was run directly');
      assert.equal(isEntry(join(linkDir, 'session-start.md'), hook), false, 'Another file is not the hook');
    }
    assert.equal(isEntry(hook, hook), true);
    assert.equal(isEntry(undefined, hook), false);
    assert.equal(isEntry(join(home, 'no-such-file.mjs'), hook), false);
    console.log(`PASS the hook runs when its folder is reached through a link${made ? '' : ' (link not tested: no right to make one here)'}`);
  }

  // No pointer for a post whose copy could not be written; the next run writes the copy, then registers.
  const sixth = await write('Sixth synthetic note, whose copy cannot be written at first.');
  await writeFile(join(projects, '7b7b7b7b-synthetic.jsonl'), claudeLog('7b7b7b7b-synthetic', [sixth], ['THETA']));
  const copies = join(home, '.router', 'traces', 'copies');
  await rm(copies, { recursive: true, force: true }); await writeFile(copies, 'not a folder');
  const blocked = await capture('--pointers');
  assert(blocked.pointers_without_copy >= 1, JSON.stringify(blocked)); assert.equal((await A.pointer(sixth, secretKey)).body.trace, null, 'No pointer without a usable copy');
  await rm(copies);
  const unblocked = await capture('--pointers');
  assert(unblocked.copies_written >= 1); assert.equal((await A.pointer(sixth, secretKey)).body.trace, 'held_locally');
  console.log('PASS a pointer is registered only once the local copy is written and read back');

  // The owner tool stops when it cannot tell whether approving would upload a trace (this server keeps no traces).
  const reader = { key: randomBytes(32).toString('base64url') };
  await A.post('/api/identity/register', { secret_key: reader.key, handle: `rdr${Date.now().toString(36).slice(-6)}` });
  const ownNote = await (await A.send('/api/entry/' + ids[0], null, secretKey, 'GET')).json();
  if (ownNote.sharingReceipt?.state === 'awaiting_notice') await A.post('/api/entries/' + ids[0] + '/notice', { evidence_kind: 'agent_reported', notice_id: ownNote.sharingReceipt.notice_id,
    notice_sha256: ownNote.sharingReceipt.notice_sha256, conversation_ref: 'synthetic-pointer-test/receipt-a' }, secretKey);
  await A.post('/api/entries/' + ids[0] + '/publish', {}, secretKey);
  const askA = await A.post('/api/trace-access', { action: 'request', entry_id: ids[0], app: { code: "function analyze(trace) { return 'x' }", purpose: 'Test' },
    answer_public_key: (await import('ethers')).Wallet.createRandom().signingKey.compressedPublicKey }, reader.key).catch(e => e);
  if (!(askA instanceof Error)) {
    const unsure = await run(process.execPath, [ownerTool, 'show', askA.request_id, '--router', A.base, '--router-key-file', keyFile, '--simulated'], { env: cleanEnv(home) }).then(() => null, e => e);
    assert(unsure && /Could not tell whether this note's trace is already in your storage/.test(unsure.stderr), 'show stops instead of leaving out the notice');
    console.log('PASS the owner tool stops when it cannot tell whether approving would upload a trace');
  } else console.log(`NOTE owner-tool unknown-state check skipped on this server: ${askA.message}`);

  // The automatic path registers only posts made by this plugin's own Router server in Claude Code.
  const LOOKALIKE = 'mcp__another-server__router_write_entry';
  const codexRoot = join(home, '.codex', 'sessions');
  // A log where another server's look-alike write tool names one post, and this plugin's tool names another.
  const [lookPost, realPost] = [await write('A post a look-alike tool claims.'), await write('A post written with the Router plugin.')];
  const mixedLog = join(projects, '8c8c8c8c-mixed.jsonl');
  await writeFile(mixedLog, claudeLog('8c8c8c8c-mixed', [lookPost, realPost], ['IOTA', 'KAPPA'], [LOOKALIKE]));
  const mixedPlan = await plan('start', { transcript_path: mixedLog }, { roots });
  assert(!mixedPlan.some(a => a.includes(codexRoot)), "The session-start plan does not read Codex's sessions folder");
  const mixed = await runPlan(mixedPlan);
  assert.equal((await A.pointer(realPost, secretKey)).body.trace, 'held_locally', 'The plugin tool\'s post is registered');
  assert.equal((await A.pointer(lookPost, secretKey)).body.trace, null, 'The look-alike tool\'s post is not');
  assert(mixed.pointers_not_router_tool >= 1, JSON.stringify(mixed));
  // An index entry made earlier (a plain run, which sends nothing) from a look-alike tool is not registered by the automatic path either.
  const olderLook = await write('A post a look-alike tool claimed before pointers were turned on.');
  const olderLog = join(projects, '9d9d9d9d-older.jsonl');
  await writeFile(olderLog, claudeLog('9d9d9d9d-older', [olderLook], ['LAMBDA'], [LOOKALIKE]));
  const indexedFirst = await capture();
  assert.equal(indexedFirst.mode, 'index only (nothing sent)');
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).index[olderLook].tool, LOOKALIKE);
  await runPlan(await plan('start', { transcript_path: olderLog }, { roots }));
  await runPlan(['--pointers-only']);
  assert.equal((await A.pointer(olderLook, secretKey)).body.trace, null, 'An earlier index entry from a look-alike tool is not registered at session start');
  // Codex names its servers as each person configured them, so the automatic path leaves Codex posts alone.
  const codexPost = await write('A post written from Codex.');
  await mkdir(join(codexRoot, '2026'), { recursive: true });
  const cx = (type, payload) => JSON.stringify({ timestamp: new Date().toISOString(), type, payload });
  await writeFile(join(codexRoot, '2026', 'rollout-pointer.jsonl'), [cx('session_meta', { id: 'cx-thread', cwd: '/work/codex' }),
    cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'MARKER-MU post this' }] }),
    cx('event_msg', { type: 'item_completed', thread_id: 'cx-thread', item: { type: 'McpToolCall', server: 'router', tool: 'router_write_entry', status: 'completed',
      result: { content: [{ type: 'text', text: `Saved.\nEntry ID: ${codexPost}` }] } } })].join('\n') + '\n');
  // A hook input naming a real log under Codex's sessions folder is not used: the hook falls back to Claude Code's folders.
  const codexFile = join(codexRoot, '2026', 'rollout-pointer.jsonl');
  assert.equal(await checkedLog(codexFile, roots), null, 'a log under the Codex root is refused');
  assert.deepEqual(await plan('start', { transcript_path: codexFile }, { roots }), ['--pointers-only', `--projects=${roots[0]}`], 'start with a Codex log scans Claude Code\'s folders only');
  assert.deepEqual(await plan('post', { transcript_path: codexFile, tool_use_id: 'w0' }, { roots, waitMs: 0 }), ['--pointers-only', `--projects=${roots[0]}`, '--days', '1']);
  for (const p of [await plan('start', { transcript_path: codexFile }), await plan('post', { transcript_path: codexFile, tool_use_id: 'w0' }, { waitMs: 0 })])
    assert(!p.some(a => a.includes(codexRoot) || /[\\/]\.codex[\\/]/.test(a)), 'with its default folders the hook never names a Codex folder');
  await runPlan(['--pointers-only', '--projects', codexRoot]);
  assert.equal((await A.pointer(codexPost, secretKey)).body.trace, null, 'The automatic path does not register Codex posts');
  // The manual command keeps its behaviour and registers it.
  await runPlan(['--pointers', '--projects', codexRoot]);
  assert.equal((await A.pointer(codexPost, secretKey)).body.trace, 'held_locally', 'The manual --pointers command registers a Codex post');
  console.log('PASS the automatic path registers only this plugin\'s Router posts: not a look-alike tool\'s, not an earlier index entry from one, not Codex\'s');
  A.stop();

  // ── Part B ────────────────────────────────────────────────────────────────────────────
  const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
  const reachable = process.env.SKIP_TINYCLOUD !== '1' && await fetch(host, { signal: AbortSignal.timeout(15000) }).then(() => true, () => false);
  if (!reachable) {
    console.log(`SKIP part B: TinyCloud at ${host} ${process.env.SKIP_TINYCLOUD === '1' ? 'skipped by SKIP_TINYCLOUD=1' : 'could not be reached'}; upload on approval not tested`);
  } else {
    const { Wallet } = await import('ethers');
    const { TinyCloudNode } = await import('@tinycloud/node-sdk');
    const { linkOwner, request, confirmOwnerRecovery } = await import('./tinycloud-link-lib.mjs');
    const { openFull, readTrace } = await import('../../plugins/teleport-router/scripts/trace-lib.mjs');
    const B = startServer(23000 + Math.floor(Math.random() * 2000), { TRACE_STORAGE: '', TINYCLOUD_AUTHORS: 'tinycloud', TINYCLOUD_KEY_SOURCE: 'test-key',
      TINYCLOUD_ROUTER_KEY: privateKey(), TINYCLOUD_HOST: host, TINYCLOUD_LEASE_MS: '5000', RECOVERY_FILE: join(work, 'pending.json'), TRACE_APPS: 'local-simulated' });
    cleanup.push(B.stop);
    await B.ready();
    const routerInfo = await request(B.base, '/api/tinycloud/router');
    const suffix = Date.now().toString(36).slice(-5), owner = { handle: `pto${suffix}`, key: randomBytes(32).toString('base64url') };
    await B.post('/api/identity/register', { secret_key: owner.key, handle: owner.handle });
    const ids = [];
    for (const content of ['A note whose trace stays on the machine.', 'A second note in the same session.']) {
      const w = await B.post('/api/entries', { secret_key: owner.key, content, posting_intent: 'user-requested' }); ids.push((w.receipt || w).entry_id);
    }
    const homeB = join(work, 'home-b'), projectsB = join(homeB, '.claude', 'projects', '-work-pointers'), logB = join(projectsB, '5e5e5e5e-synthetic.jsonl');
    await mkdir(projectsB, { recursive: true });
    await writeFile(logB, claudeLog('5e5e5e5e-synthetic', ids));
    const keyFileB = join(work, 'router-b.key'); await writeFile(keyFileB, owner.key);
    const stateB = join(homeB, '.router', 'traces', 'state.json');
    const captureB = async (...args) => JSON.parse((await run(process.execPath, [cli, '--router', B.base, '--key-file', keyFileB, '--projects', join(homeB, '.claude', 'projects'), '--state', stateB, ...args], { env: cleanEnv(homeB) })).stdout);
    assert.equal((await captureB('--pointers')).pointers_registered, 2, 'Pointers registered before any storage is linked');

    // Now the owner links storage, writes rules, and the agent cleans up its session log.
    const ownerKey = privateKey(), wallet = new Wallet(ownerKey);
    const node = new TinyCloudNode({ privateKey: ownerKey, host, prefix: 'router-test', autoCreateSpace: true, enablePublicSpace: false, sessionExpirationMs: 366 * 86400000 });
    await node.signIn();
    const grant = await node.createDelegation({ delegateDID: routerInfo.did, path: routerInfo.folder, actions: routerInfo.actions, expiryMs: 365 * 86400000, includePublicSpace: false });
    const linked = await linkOwner({ base: B.base, secretKey: owner.key, signMessage: m => wallet.signMessage(m), confirmRecovery: p => confirmOwnerRecovery(ownerKey, p), grant });
    assert(linked.linked && linked.available);
    await writeFile(join(homeB, '.router', 'traces', 'rules.json'), JSON.stringify({ never_upload_tools: [] }));
    await rm(logB);
    const ownerKeyFile = join(work, 'owner.key'); await writeFile(ownerKeyFile, ownerKey);
    console.log('PASS (setup) storage linked after the pointers; the original session log deleted');

    // Publish, and have another account ask to run an app on the pointer-only post.
    const own = await (await B.send('/api/entry/' + ids[0], null, owner.key, 'GET')).json();
    const notice = own.sharingReceipt;
    if (notice?.state === 'awaiting_notice') await B.post('/api/entries/' + ids[0] + '/notice', { secret_key: owner.key, evidence_kind: 'agent_reported', notice_id: notice.notice_id, notice_sha256: notice.notice_sha256, conversation_ref: 'synthetic-pointer-test/receipt' }, owner.key);
    await B.post('/api/entries/' + ids[0] + '/publish', { secret_key: owner.key }, owner.key);
    const asker = { key: randomBytes(32).toString('base64url'), wallet: Wallet.createRandom() };
    await B.post('/api/identity/register', { secret_key: asker.key, handle: `ptq${suffix}` });
    assert.equal((await B.pointer(ids[0], asker.key)).body.trace, 'held_locally', 'A reader of the published post sees that its trace is held locally');
    const app = { code: "function analyze(trace) { return trace.includes('MARKER-ALPHA') && !trace.includes('MARKER-BETA') ? 'first slice' : 'other' }", purpose: 'Say which slice this is' };
    const asked = await B.post('/api/trace-access', { action: 'request', entry_id: ids[0], app, answer_public_key: asker.wallet.signingKey.compressedPublicKey }, asker.key);
    assert.equal(asked.state, 'pending', 'A request can be made against a post that has only a pointer');
    const early = await B.send('/api/trace-access', { action: 'prepare', request_id: asked.request_id, revision: asked.revision, nonce: 'a'.repeat(64) }, owner.key);
    assert.equal(early.status, 409); assert.match((await early.json()).error, /still on your machine/);

    const ownerCli = (...args) => run(process.execPath, [ownerTool, ...args, '--router', B.base, '--router-key-file', keyFileB, '--owner-key-file', ownerKeyFile,
      '--tinycloud-host', host, '--space', 'router-test', '--records', join(work, 'trace-apps'), '--capture-state', stateB, '--capture-projects', join(homeB, '.claude', 'projects'), '--simulated'],
      { timeout: 300000, env: cleanEnv(homeB) });
    const stored = async () => (await B.send('/api/traces/metadata', { entry_id: ids[0] }, owner.key)).status;
    const shown = (await ownerCli('show', asked.request_id)).stdout;
    const pin = shown.match(/--pin ([a-f0-9]{64})/)?.[1];
    assert(pin && /Approving this run uploads it for the first time/.test(shown), 'show says approving would upload the trace for the first time');

    // A withdrawn request gets nothing uploaded, even with --yes.
    const other = { key: randomBytes(32).toString('base64url'), wallet: Wallet.createRandom() };
    await B.post('/api/identity/register', { secret_key: other.key, handle: `ptw${suffix}` });
    const gone = await B.post('/api/trace-access', { action: 'request', entry_id: ids[0], app, answer_public_key: other.wallet.signingKey.compressedPublicKey }, other.key);
    const gonePin = (await ownerCli('show', gone.request_id)).stdout.match(/--pin ([a-f0-9]{64})/)?.[1];
    await B.post('/api/trace-access', { action: 'withdraw', request_id: gone.request_id }, other.key);
    const refusedGone = await ownerCli('run', gone.request_id, '--pin', gonePin, '--yes').then(() => null, e => e);
    assert(refusedGone && /Nothing was uploaded or run: This request is no longer open/.test(refusedGone.stderr), String(refusedGone?.stderr));
    assert.equal(await stored(), 404, 'Nothing was uploaded for a withdrawn request');
    // Without --yes, run says it would upload and does nothing.
    const dry = (await ownerCli('run', asked.request_id, '--pin', pin)).stdout;
    assert(/Approving this run uploads it for the first time/.test(dry) && /Run the same command with --yes/.test(dry), dry);
    assert.equal(await stored(), 404, 'Nothing was uploaded without --yes');
    assert.equal((await B.pointer(ids[0], asker.key)).body.trace, 'held_locally');
    console.log('PASS show and run say when approving uploads a trace for the first time; nothing is uploaded without --yes or for a withdrawn request');
    const ran = (await ownerCli('run', asked.request_id, '--pin', pin, '--yes')).stdout;
    assert(/uploaded from this machine's copy of the session log/.test(ran), ran);
    assert(ran.includes('  > first slice'), 'The app ran on the uploaded trace: ' + ran.slice(-800));
    assert.equal((await B.pointer(ids[0], asker.key)).body.trace, 'uploaded', 'The pointer now says uploaded');
    console.log('PASS approving a run on a pointer-only post uploads the trace from the local copy, then runs the app');

    // The upload is the ordinary one: ciphertext in the owner's storage that the owner's key opens.
    const got = await B.post('/api/traces/get', { entry_id: ids[0] }, owner.key);
    const trace = readTrace(openFull(got.meta, Buffer.from(got.data, 'base64'), { ownerDid: got.owner_did, entryId: ids[0] }, ownerKey));
    assert.equal(trace.entry_id, ids[0]); assert(JSON.stringify(trace.records).includes('MARKER-ALPHA'));
    // A pointer never downgrades an upload.
    const re = await B.send('/api/trace-pointers', { entry_id: ids[0], agent: 'claude-code', slice_sha256: 'd'.repeat(64) }, owner.key);
    assert.equal((await re.json()).trace, 'uploaded');
    // The second post's trace can still be built from the copy by a plain upload.
    const second = await captureB('--upload', ids[1], '--owner-key-file', ownerKeyFile);
    assert.equal(second.uploaded, 1); assert.equal(second.uploaded_from_copy, 1);
    assert.equal((await B.pointer(ids[1], owner.key)).body.trace, 'uploaded');
    console.log('PASS the owner opens the uploaded trace; a later pointer does not downgrade it; a plain upload also works from the copy');
    B.stop();
  }
  console.log('\nALL PASSED (synthetic data)');
} catch (err) {
  console.error('FAILED:', err?.stack || err); process.exitCode = 1;
} finally {
  for (const stop of cleanup) try { stop(); } catch {}
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
