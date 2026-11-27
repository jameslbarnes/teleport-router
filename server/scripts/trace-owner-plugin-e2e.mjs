// Standalone plugin-bundle end-to-end test for trace-app-owner.mjs:
// Copies ONLY plugins/teleport-router/scripts/{trace-app-owner.mjs,capture-traces.mjs,trace-lib.mjs}
// into an isolated temp directory with NO repo checkout and NO node_modules, then exercises:
//   - encrypted Router recovery file (--recovery-file + password, no raw hex key files)
//   - automatic rules.json initialization during interactive `review`
//   - interactive `review` end-to-end (show -> run -> upload from local copy -> release)
//   - CLAUDE_PLUGIN_OPTION_ROUTER_KEY env fallback for `inbox` / `show` / `withhold`
//
// Run from server/: npm run build && node ../scripts/build-trace-owner.mjs && node scripts/trace-owner-plugin-e2e.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { confirmOwnerRecovery as confirmBrowserRecovery, encryptBackup } from '../../browser/src/recovery.mjs';
import { sealAgentGrant } from '../../browser/src/pair-seal.mjs';
import { prepareAgentTraces, registerAgentKey } from '../../browser/src/trace-agent-keys.mjs';

const PLUGIN_SCRIPTS = resolve('../plugins/teleport-router/scripts');
const work = await mkdtemp(join(tmpdir(), 'router-plugin-owner-e2e-'));
const isolated = join(work, 'standalone-plugin');
await mkdir(isolated, { recursive: true });
for (const f of ['trace-app-owner.mjs', 'tinycloud_web_sdk_rs_bg.wasm', 'capture-traces.mjs', 'trace-lib.mjs']) {
  await copyFile(join(PLUGIN_SCRIPTS, f), join(isolated, f));
}
const bundledOwner = join(isolated, 'trace-app-owner.mjs');
const bundledCapture = join(isolated, 'capture-traces.mjs');

const privateKey = () => `0x${randomBytes(32).toString('hex')}`;
const cleanEnv = (home, extra = {}) => ({
  ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: join(home, '.codex'),
  ROUTER_KEY: '', CLAUDE_PLUGIN_OPTION_ROUTER_KEY: '', TELEPORT_ROUTER_URL: '', ...extra,
});

function runProc(args, { cwd = isolated, env, input = null, timeout = 300000 } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); rejectP(new Error(`Timed out: ${args.join(' ')}\n${stdout}\n${stderr}`)); }, timeout);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); rejectP(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolveP({ stdout, stderr, code });
      else rejectP(Object.assign(new Error(`Exit ${code}: ${stderr || stdout}`), { code, stdout, stderr }));
    });
    if (input !== null) child.stdin.write(input);
    child.stdin.end();
  });
}

function startServer(port, extra) {
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['dist/http.js'], {
    cwd: process.cwd(), shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), LISTEN_HOST: '127.0.0.1', BASE_URL: base, NODE_ENV: 'test',
      INSIGHTS_RELEASE: '', ANTHROPIC_API_KEY: '', FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '',
      GOOGLE_APPLICATION_CREDENTIALS: '', MODERATOR_URL: '', MODERATOR_API_KEY: '', TINYCLOUD_GROUPS: '',
      STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', SENDGRID_API_KEY: '', TELEGRAM_BOT_TOKEN: '',
      MATRIX_HOMESERVER_URL: '', ...extra,
    },
  });
  let logs = '';
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + String(d)).slice(-6000); });
  const send = (path, body, key, method = 'POST') => fetch(base + path, {
    method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000),
  });
  const post = async (path, body, key) => {
    const r = await send(path, body, key), j = await r.json();
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status} ${j.error || ''}`);
    return j;
  };
  const ready = async () => {
    for (let i = 0; i < 200; i++) {
      try { if ((await fetch(`${base}/health`)).ok) return; } catch {}
      if (server.exitCode !== null) throw new Error(`Server exited ${server.exitCode}: ${logs.slice(-1500)}`);
      await new Promise(r => setTimeout(r, 250));
    }
    throw new Error('Server did not start');
  };
  return { base, send, post, ready, stop: () => { if (!server.killed) server.kill(); } };
}

function claudeLog(session, id, marker) {
  const rec = (type, message) => JSON.stringify({
    type, uuid: randomBytes(4).toString('hex'), sessionId: session,
    timestamp: new Date().toISOString(), cwd: '/work/plugin-test', version: '0.0.0-synthetic', message,
  });
  return [
    rec('user', { role: 'user', content: `MARKER-${marker} hello` }),
    rec('assistant', { role: 'assistant', content: [{ type: 'tool_use', id: 'w0', name: 'mcp__plugin_teleport-router_router__router_write_entry', input: { entry: 'note' } }] }),
    rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'w0', content: JSON.stringify({ receipt: { version: 1, entry_id: id, state: 'pending' } }) }] }),
  ].join('\n') + '\n';
}

const cleanup = [];
try {
  // Part 1: Pure local test (no TinyCloud needed) — proves standalone bundle runs with CLAUDE_PLUGIN_OPTION_ROUTER_KEY & recovery file.
  const A = startServer(25000 + Math.floor(Math.random() * 1500), { TINYCLOUD_AUTHORS: '', TRACE_STORAGE: 'off' });
  cleanup.push(A.stop);
  await A.ready();
  const suffix = Date.now().toString(36).slice(-5);
  const handle = `plg${suffix}`, routerKey = randomBytes(32).toString('base64url'), storageKey = privateKey();
  await A.post('/api/identity/register', { secret_key: routerKey, handle });
  const password = 'correct horse battery staple';
  const recoveryFile = join(work, `router-recovery-${handle}.json`);
  await writeFile(recoveryFile, JSON.stringify(await encryptBackup({
    format: 'router-account', version: 1, handle, routerKey, tinycloudKey: storageKey, origin: A.base,
  }, password)));

  const homeA = join(work, 'home-a');
  // 1a. inbox works using CLAUDE_PLUGIN_OPTION_ROUTER_KEY with no --router-key-file and no --recovery-file
  const envInbox = await runProc([bundledOwner, 'inbox', '--router', A.base], {
    env: cleanEnv(homeA, { CLAUDE_PLUGIN_OPTION_ROUTER_KEY: routerKey }),
  });
  assert.match(envInbox.stdout, /No requests are waiting/);

  // 1b. inbox works using --recovery-file + --password-stdin with no Router key env or key file
  const recInbox = await runProc([bundledOwner, 'inbox', '--router', A.base, '--recovery-file', recoveryFile, '--password-stdin'], {
    env: cleanEnv(homeA), input: `${password}\n`,
  });
  assert.match(recInbox.stdout, /No requests are waiting/);
  console.log('PASS standalone plugin bundle works outside the repo with CLAUDE_PLUGIN_OPTION_ROUTER_KEY and --recovery-file');
  A.stop();

  // Part 2: Full interactive `review` flow with real hosted TinyCloud (recovery file, no raw key files, auto rules.json init, upload from local copy, run, release).
  const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
  const reachable = process.env.SKIP_TINYCLOUD !== '1' && await fetch(host, { signal: AbortSignal.timeout(15000) }).then(() => true, () => false);
  if (!reachable) {
    if (process.env.PLAYWRIGHT_MODULE && process.env.SKIP_TINYCLOUD !== '1') throw Error('Browser pairing needs a reachable TinyCloud node.');
    console.log(`SKIP part 2: TinyCloud at ${host} unavailable or skipped`);
  } else {
    const { Wallet } = await import('ethers');
    const { TinyCloudNode } = await import('@tinycloud/node-sdk');
    const { linkOwner, request, confirmOwnerRecovery } = await import('./tinycloud-link-lib.mjs');

    const B = startServer(26500 + Math.floor(Math.random() * 1500), {
      TRACE_STORAGE: '', TINYCLOUD_AUTHORS: 'tinycloud', TINYCLOUD_KEY_SOURCE: 'test-key',
      TINYCLOUD_ROUTER_KEY: privateKey(), TINYCLOUD_HOST: host, TINYCLOUD_LEASE_MS: '5000',
      RECOVERY_FILE: join(work, 'pending.json'), TRACE_APPS: 'local-simulated',
    });
    cleanup.push(B.stop);
    await B.ready();
    const routerInfo = await request(B.base, '/api/tinycloud/router');
    const owner = { handle: `plo${suffix}`, key: randomBytes(32).toString('base64url') };
    await B.post('/api/identity/register', { secret_key: owner.key, handle: owner.handle });
    const w = await B.post('/api/entries', { secret_key: owner.key, content: 'A note reviewed with the bundled plugin tool.', posting_intent: 'user-requested' });
    const entryId = (w.receipt || w).entry_id;

    const homeB = join(work, 'home-b');
    const projectsB = join(homeB, '.claude', 'projects', '-work-plugin');
    await mkdir(projectsB, { recursive: true });
    const logB = join(projectsB, '7f7f7f7f-synthetic.jsonl');
    await writeFile(logB, claudeLog('7f7f7f7f-synthetic', entryId, 'PLUGIN_UX'));
    const stateB = join(homeB, '.router', 'traces', 'state.json');

    // Register pointer with the bundled capture script (using ROUTER_KEY env, no key file), then delete original log.
    const cap = await runProc([bundledCapture, '--router', B.base, '--projects', join(homeB, '.claude', 'projects'), '--state', stateB, '--pointers-only'], {
      env: cleanEnv(homeB, { CLAUDE_PLUGIN_OPTION_ROUTER_KEY: owner.key }),
    });
    assert.equal(JSON.parse(cap.stdout).pointers_registered, 1);
    await rm(logB);

    // Link TinyCloud storage and create ONLY an encrypted recovery file (no raw hex key files on disk, no rules.json yet!).
    const ownerKey = privateKey(), wallet = new Wallet(ownerKey);
    const node = new TinyCloudNode({ privateKey: ownerKey, host, prefix: 'router-test', autoCreateSpace: true, enablePublicSpace: false, sessionExpirationMs: 366 * 86400000 });
    await node.signIn();
    const grant = await node.createDelegation({ delegateDID: routerInfo.did, path: routerInfo.folder, actions: routerInfo.actions, expiryMs: 365 * 86400000, includePublicSpace: false });
    const linked = await linkOwner({ base: B.base, secretKey: owner.key, signMessage: m => wallet.signMessage(m), confirmRecovery: p => confirmOwnerRecovery(ownerKey, p), grant });
    assert(linked.linked && linked.available);

    const recB = join(work, `router-recovery-${owner.handle}.json`);
    await writeFile(recB, JSON.stringify(await encryptBackup({
      format: 'router-account', version: 1, handle: owner.handle, routerKey: owner.key, tinycloudKey: ownerKey, origin: B.base,
    }, password)));

    // Publish and send a trace-app request from another account (custody answer, no requester key needed).
    const own = await (await B.send('/api/entry/' + entryId, null, owner.key, 'GET')).json();
    const notice = own.sharingReceipt;
    if (notice?.state === 'awaiting_notice') {
      await B.post('/api/entries/' + entryId + '/notice', {
        secret_key: owner.key, evidence_kind: 'agent_reported', notice_id: notice.notice_id,
        notice_sha256: notice.notice_sha256, conversation_ref: 'synthetic-plugin-e2e/receipt',
      }, owner.key);
    }
    await B.post('/api/entries/' + entryId + '/publish', { secret_key: owner.key }, owner.key);
    const asker = { handle: `plq${suffix}`, key: randomBytes(32).toString('base64url') };
    await B.post('/api/identity/register', { secret_key: asker.key, handle: asker.handle });
    const app = { code: "function analyze(trace) { return trace.includes('MARKER-PLUGIN_UX') ? 'plugin-ux-ok' : 'missing'; }", purpose: 'Verify standalone plugin approval' };
    const asked = await B.post('/api/trace-access', { action: 'request', entry_id: entryId, app }, asker.key);
    assert.equal(asked.state, 'pending');

    // Run interactive `review` from the isolated plugin folder with ONLY --recovery-file (no raw key files, no rules.json):
    // Piped responses:
    //   1. Recovery password (to unlock recovery file for routerKey + tinycloudKey)
    //   2. 'r' (run the app)
    //   3. 'y' (confirm first-time upload)
    //   4. ''  (no never_upload_tools -> creates rules.json automatically)
    //   5. 'r' (release the answer to requester)
    const reviewed = await runProc([
      bundledOwner, 'review', '--router', B.base, '--recovery-file', recB,
      '--tinycloud-host', host, '--space', 'router-test',
      '--records', join(work, 'trace-apps'), '--capture-state', stateB,
      '--capture-projects', join(homeB, '.claude', 'projects'), '--simulated',
    ], {
      env: cleanEnv(homeB),
      input: `${password}\nr\ny\n\nr\n`,
    });

    assert.match(reviewed.stdout, /saved .*rules\.json/, reviewed.stdout);
    assert.match(reviewed.stdout, /uploaded from this machine's copy of the session log/, reviewed.stdout);
    assert.match(reviewed.stdout, /> plugin-ux-ok/, reviewed.stdout);
    assert.match(reviewed.stdout, /Released\. Receipt/, reviewed.stdout);

    // Verify rules.json was created cleanly and requester received the released answer.
    const createdRules = JSON.parse(await readFile(join(homeB, '.router', 'traces', 'rules.json'), 'utf8'));
    assert.deepEqual(createdRules, { never_upload_tools: [] });
    const status = await B.post('/api/trace-access', { action: 'status', request_id: asked.request_id }, asker.key);
    assert.equal(status.state, 'released');
    assert.equal(status.answer_text, 'plugin-ux-ok');
    console.log('PASS interactive `review` with --recovery-file created rules.json, uploaded from local copy, ran app, and released answer');

    // Part 2b: Agent-driven flow after one-time `setup --recovery-file`:
    // Once the user runs `setup` once, their agent runs `inbox`, `show`, `run --pin`, `release` with ZERO key flags or passwords!
    const homeAgent = join(work, 'home-agent');
    const stateAgent = join(homeAgent, '.router', 'traces', 'state.json');
    const setupOut = await runProc([
      bundledOwner, 'setup', '--recovery-file', recB, '--password-stdin', '--init-rules', '--capture-state', stateAgent,
    ], { env: cleanEnv(homeAgent), input: `${password}\n` });
    assert.match(setupOut.stdout, /saved owner-only keys/);
    assert.match(setupOut.stdout, /Ready\. Your agent can now run/);

    const asker2 = { handle: `pla${suffix}`, key: randomBytes(32).toString('base64url') };
    await B.post('/api/identity/register', { secret_key: asker2.key, handle: asker2.handle });
    const asked2 = await B.post('/api/trace-access', {
      action: 'request', entry_id: entryId,
      app: { code: "function analyze(trace) { return trace.includes('MARKER-PLUGIN_UX') ? 'agent-driven-ok' : 'missing'; }", purpose: 'Verify zero-flag agent approval' },
    }, asker2.key);

    const agentBase = ['--router', B.base, '--tinycloud-host', host, '--space', 'router-test',
      '--records', join(work, 'trace-apps-agent'), '--capture-state', stateAgent, '--simulated'];
    const agentInbox = await runProc([bundledOwner, 'inbox', ...agentBase], { env: cleanEnv(homeAgent) });
    assert(agentInbox.stdout.includes(asked2.request_id), agentInbox.stdout);
    const agentShow = await runProc([bundledOwner, 'show', asked2.request_id, ...agentBase], { env: cleanEnv(homeAgent) });
    const agentPin = agentShow.stdout.match(/--pin ([a-f0-9]{64})/)?.[1];
    assert(agentPin, agentShow.stdout);
    const agentRun = await runProc([bundledOwner, 'run', asked2.request_id, '--pin', agentPin, ...agentBase], { env: cleanEnv(homeAgent) });
    assert.match(agentRun.stdout, /> agent-driven-ok/);
    const agentRel = await runProc([bundledOwner, 'release', asked2.request_id, ...agentBase], { env: cleanEnv(homeAgent) });
    assert.match(agentRel.stdout, /Released\. Receipt/);
    const status2 = await B.post('/api/trace-access', { action: 'status', request_id: asked2.request_id }, asker2.key);
    assert.equal(status2.state, 'released');
    assert.equal(status2.answer_text, 'agent-driven-ok');
    console.log('PASS agent-driven flow after one-time `setup`: inbox -> show -> run -> release with ZERO key flags or passwords');

    // A real browser drives the same page a recovery-backed owner uses. Its key material
    // starts in a saved, encrypted backup. The paired tool runs in a separate home.
    if (process.env.PLAYWRIGHT_MODULE) {
      const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
      const state = join(homeB, '.router', 'traces', 'state.json');
      const args = ['--router', B.base, '--capture-state', state, '--records', join(homeB, 'reviews'),
        '--capture-projects', join(homeB, '.claude', 'projects'), '--simulated'];
      const ownerCmd = async (cmd, input) => (await runProc([bundledOwner, ...cmd, ...args], { env: cleanEnv(homeB), input })).stdout;
      const before = await B.post('/api/traces/metadata', { entry_id: entryId }, owner.key);
      assert(before.full.wraps.owner && !before.full.wraps.agent);
      const localAgent = new Client({ name: 'trace-pair-test', version: '1' });
      const endpoint = new URL('/mcp/http', B.base);
      endpoint.searchParams.set('key', owner.key);
      await localAgent.connect(new StreamableHTTPClientTransport(endpoint));
      const traceTool = async args => {
        const reply = await localAgent.callTool({ name: 'router_trace_access', arguments: args });
        if (reply.isError) throw Error('Trace tool: ' + reply.content[0].text);
        return reply.structuredContent;
      };
      const init = JSON.parse(await ownerCmd(['pair-init']));
      const pair = await traceTool({ action: 'pair_start_v2', key_version: init.key_version, agent_public_key: init.agent_public_key });
      assert.equal(pair.key_version, 2);
      assert.equal(pair.verify_code, init.verify_code);
      const browser = await chromium.launch({ headless: true, args: ['--disable-gpu'] });
      try {
        const page = await browser.newPage({ storageState: { cookies: [], origins: [{ origin: B.base, localStorage: [
          { name: 'router_key', value: owner.key }, { name: 'router_recovery:' + owner.handle, value: await readFile(recB, 'utf8') },
        ] }] } });
        await page.goto(pair.url);
        await page.getByText('Verification code: ' + init.verify_code, { exact: false }).waitFor();
        await page.locator('#requests input[type=password]').fill(password);
        await page.getByRole('button', { name: 'Allow', exact: true }).click();
        try { await page.getByRole('heading', { name: 'Agent authorized', exact: true }).waitFor({ timeout: 90000 }); }
        catch { throw Error('Browser pairing did not finish: ' + await page.locator('#status').innerText()); }
      } finally { await browser.close(); }
      const picked = await traceTool({ action: 'pair_poll', pair_token: pair.pair_token });
      await localAgent.close();
      await ownerCmd(['pair-finish', '--pair-id', picked.pair_id, '--owner-did', pair.owner_did], JSON.stringify(picked));
      const localWire = await readFile(join(homeB, '.router', 'traces', 'agent-grant.json'), 'utf8');
      assert(!localWire.toLowerCase().includes(ownerKey.slice(2).toLowerCase()), 'account private key reached the paired machine');
      const localGrant = JSON.parse(localWire);
      assert.equal(localGrant.accountPublicKey, wallet.signingKey.compressedPublicKey);
      const browserKeys = await registerAgentKey(node, ownerKey);
      assert(localGrant.traceKey === browserKeys.traceKey, 'paired file contains the dedicated trace key');
      assert.deepEqual(await B.post('/api/traces/metadata', { entry_id: entryId }, owner.key), before);

      const fresh = await B.post('/api/entries', { secret_key: owner.key, content: 'Second trace for the paired browser test.', posting_intent: 'user-requested' });
      const nextId = fresh.receipt.entry_id;
      const nextLog = join(projectsB, '7f7f7f7f-fresh.jsonl');
      await writeFile(nextLog, claudeLog('7f7f7f7f-fresh', nextId, 'NEW_PAIR'));
      await runProc([bundledCapture, '--router', B.base, '--state', state, '--log', nextLog, '--pointers-only'], {
        env: cleanEnv(homeB, { ROUTER_KEY: owner.key }),
      });
      await rm(nextLog);
      if (fresh.receipt.notification_required) await B.post('/api/entries/' + nextId + '/notice', {
        secret_key: owner.key, evidence_kind: 'agent_reported', notice_id: fresh.receipt.notice_id,
        notice_sha256: fresh.receipt.notice_sha256, conversation_ref: 'synthetic-plugin-e2e/fresh',
      }, owner.key);
      await B.post('/api/entries/' + nextId + '/publish', {}, owner.key);
      for (const [id, marker] of [[entryId, 'PLUGIN_UX'], [nextId, 'NEW_PAIR']]) {
        const asked = await B.post('/api/trace-access', { action: 'request', entry_id: id, app: {
          purpose: 'Verify the synthetic word in the paired browser test.',
          code: "function analyze(trace) { return /MARKER-([A-Z_]+) hello/.exec(trace)?.[1] || 'missing'; }",
        } }, asker.key);
        const shown = await ownerCmd(['show', asked.request_id]);
        const pin = shown.match(/--pin ([a-f0-9]{64})/)?.[1]; assert(pin);
        const run = await ownerCmd(['run', asked.request_id, '--pin', pin, '--yes']);
        assert(run.includes('  > ' + marker), run);
        const waiting = await B.post('/api/trace-access', { action: 'status', request_id: asked.request_id }, asker.key);
        assert.equal(waiting.state, 'pending'); assert.equal(waiting.answer_text, undefined);
        await ownerCmd(['release', asked.request_id]);
        const received = await B.post('/api/trace-access', { action: 'status', request_id: asked.request_id }, asker.key);
        assert.equal(received.state, 'released'); assert.equal(received.answer_text, marker);
      }
      const uploaded = await B.post('/api/traces/metadata', { entry_id: nextId }, owner.key);
      assert(uploaded.full.wraps.agent && uploaded.full.wraps.owner);
      const rotated = await registerAgentKey(node, ownerKey, true);
      assert(rotated.traceKey !== localGrant.traceKey);
      assert((await registerAgentKey(node, ownerKey)).traceKey === rotated.traceKey);
      console.log('PASS saved-backup browser pairing: old and new trace answers received after release; account private key absent from local grant.');
    }

    // Part 2c: Option 2 — Browser-authorized scoped local agent (OpenKey-style: separate traceKey, owner master key NEVER given to CLI!).
    const ownerC = { handle: `plc${suffix}`, key: randomBytes(32).toString('base64url') };
    await B.post('/api/identity/register', { secret_key: ownerC.key, handle: ownerC.handle });
    const wC = await B.post('/api/entries', { secret_key: ownerC.key, content: 'A note approved by a browser-authorized scoped agent.', posting_intent: 'user-requested' });
    const entryIdC = (wC.receipt || wC).entry_id;

    const homeC = join(work, 'home-delegated');
    const projectsC = join(homeC, '.claude', 'projects', '-work-delegated');
    await mkdir(projectsC, { recursive: true });
    const logC = join(projectsC, '8a8a8a8a-synthetic.jsonl');
    await writeFile(logC, claudeLog('8a8a8a8a-synthetic', entryIdC, 'DELEGATED_OK'));
    const stateC = join(homeC, '.router', 'traces', 'state.json');

    // Register pointer and delete original log (trace is held locally only).
    const capC = await runProc([bundledCapture, '--router', B.base, '--projects', join(homeC, '.claude', 'projects'), '--state', stateC, '--pointers-only'], {
      env: cleanEnv(homeC, { CLAUDE_PLUGIN_OPTION_ROUTER_KEY: ownerC.key }),
    });
    assert.equal(JSON.parse(capC.stdout).pointers_registered, 1);
    await rm(logC);

    // Owner links TinyCloud storage with master key `masterKeyC` (never leaves owner/browser!) and separate `traceKeyC` (as OpenKey does!).
    const masterKeyC = privateKey(), masterWalletC = new Wallet(masterKeyC);
    const traceKeyC = privateKey(), tracePubC = new Wallet(traceKeyC).signingKey.compressedPublicKey;
    const nodeC = new TinyCloudNode({ privateKey: masterKeyC, host, prefix: 'router-del', autoCreateSpace: true, enablePublicSpace: false, sessionExpirationMs: 366 * 86400000 });
    await nodeC.signIn();
    const { delegation: grantC } = await nodeC.delegateTo(routerInfo.did, [{ service: 'tinycloud.kv', space: nodeC.spaceId, path: routerInfo.folder, actions: routerInfo.actions }], { expiry: 365 * 86400000, requireActivation: true });
    const encSym = 'stub-encrypted-sym-key';
    const networkRecoveryStub = {
      publicKey: tracePubC,
      envelope: {
        v: 2,
        networkId: `urn:tinycloud:encryption:${nodeC.did}:default`,
        keyPath: 'apps/' + new URL(B.base).hostname.split('.').reverse().join('.') + '/recovery',
        alg: 'x25519-aes256gcm/v1',
        keyVersion: 1,
        encryptedSymmetricKey: encSym,
        encryptedSymmetricKeyHash: createHash('sha256').update(JSON.stringify(encSym)).digest('hex'),
        ciphertext: 'stub-ciphertext',
      },
    };
    const linkedC = await linkOwner({
      base: B.base, secretKey: ownerC.key,
      signMessage: m => masterWalletC.signMessage(m),
      confirmRecovery: p => confirmBrowserRecovery(traceKeyC, p),
      grant: grantC,
      networkRecovery: networkRecoveryStub,
    });
    assert(linkedC.linked && linkedC.available);

    // Publish note & send trace-app request.
    const ownC = await (await B.send('/api/entry/' + entryIdC, null, ownerC.key, 'GET')).json();
    if (ownC.sharingReceipt?.state === 'awaiting_notice') {
      await B.post('/api/entries/' + entryIdC + '/notice', {
        secret_key: ownerC.key, evidence_kind: 'agent_reported', notice_id: ownC.sharingReceipt.notice_id,
        notice_sha256: ownC.sharingReceipt.notice_sha256, conversation_ref: 'synthetic-delegated/receipt',
      }, ownerC.key);
    }
    await B.post('/api/entries/' + entryIdC + '/publish', { secret_key: ownerC.key }, ownerC.key);
    const askedC = await B.post('/api/trace-access', {
      action: 'request', entry_id: entryIdC,
      app: { code: "function analyze(trace) { return trace.includes('MARKER-DELEGATED_OK') ? 'scoped-delegation-works' : 'missing'; }", purpose: 'Verify browser-authorized scoped agent' },
    }, asker2.key);

    // Step 1: Agent runs `pair-init` (ZERO keys!)
    const initOut = JSON.parse((await runProc([bundledOwner, 'pair-init', '--capture-state', stateC], { env: cleanEnv(homeC) })).stdout);
    assert(initOut.agent_public_key && initOut.agent_did && initOut.verify_code);

    // Step 2: Agent calls pair_start (via Router API / MCP)
    const pairStart = await B.post('/api/trace-agent/pair/start', { key_version: initOut.key_version, agent_public_key: initOut.agent_public_key }, ownerC.key);
    assert.equal(pairStart.verify_code, initOut.verify_code);

    // Step 3: Browser reads pair/info, verifies mode=openkey, delegates ONLY router/traces/ (get), seals to agent_public_key, and completes!
    const pairInfo = await B.post('/api/trace-agent/pair/info', { key_version: 2, token: pairStart.pair_token }, ownerC.key);
    assert.equal(pairInfo.storage.mode, 'openkey');
    assert.equal(pairInfo.storage.owner_public_key, tracePubC);
    const dedicated = await registerAgentKey(nodeC, traceKeyC);
    assert.deepEqual(await prepareAgentTraces((path, body) => B.post(path, body, ownerC.key), nodeC, traceKeyC, dedicated), []);
    const { serializeDelegation } = await import('@tinycloud/node-sdk');
    const { delegation: scopedParent } = await nodeC.delegateTo(
      pairInfo.agent_did,
      [{ service: 'tinycloud.kv', space: nodeC.spaceId, path: 'router/traces/', actions: ['get'] }],
      { expiry: 365 * 86400000, requireActivation: true },
    );
    const sealedHandoff = await sealAgentGrant({
      v: 2, handle: ownerC.handle, routerKey: ownerC.key, traceKey: dedicated.traceKey, accountPublicKey: tracePubC,
      delegation: serializeDelegation(scopedParent), ownerDid: nodeC.did, space: nodeC.spaceId, host,
    }, { pairId: pairInfo.pair_id, ownerDid: nodeC.did, agentPublicKey: pairInfo.agent_public_key });
    await B.post('/api/trace-agent/pair/complete', { key_version: 2, token: pairStart.pair_token, sealed: sealedHandoff }, ownerC.key);

    // Step 4: Agent polls (gets opaque ciphertext only!) and pipes it to `pair-finish`!
    const polled = await B.post('/api/trace-agent/pair/poll', { token: pairStart.pair_token }, ownerC.key);
    assert.equal(polled.status, 'completed');
    const finOut = await runProc([
      bundledOwner, 'pair-finish', '--pair-id', polled.pair_id, '--owner-did', pairStart.owner_did, '--capture-state', stateC,
    ], { env: cleanEnv(homeC), input: JSON.stringify(polled) });
    assert.match(finOut.stdout, /authorized local agent for/);
    const storedGrant = await readFile(join(homeC, '.router', 'traces', 'agent-grant.json'), 'utf8');
    assert(!storedGrant.includes(masterKeyC.slice(2)) && !storedGrant.includes(traceKeyC.slice(2)));

    // Step 5: Agent saves rules.json (after asking user in chat) and runs show -> run --yes -> release with ZERO master key, ZERO key flags!
    await runProc([bundledOwner, 'rules', '--capture-state', stateC], { env: cleanEnv(homeC) });
    const delBase = ['--router', B.base, '--records', join(work, 'trace-apps-del'), '--capture-state', stateC,
      '--capture-projects', join(homeC, '.claude', 'projects'), '--simulated'];
    const delShow = await runProc([bundledOwner, 'show', askedC.request_id, ...delBase], { env: cleanEnv(homeC) });
    const delPin = delShow.stdout.match(/--pin ([a-f0-9]{64})/)?.[1];
    assert(delPin, delShow.stdout);
    const delRun = await runProc([bundledOwner, 'run', askedC.request_id, '--pin', delPin, '--yes', ...delBase], { env: cleanEnv(homeC) });
    assert.match(delRun.stdout, /uploaded from this machine's copy of the session log/);
    assert.match(delRun.stdout, /> scoped-delegation-works/);
    const delRel = await runProc([bundledOwner, 'release', askedC.request_id, ...delBase], { env: cleanEnv(homeC) });
    assert.match(delRel.stdout, /Released\. Receipt/);

    const statusC = await B.post('/api/trace-access', { action: 'status', request_id: askedC.request_id }, asker2.key);
    assert.equal(statusC.state, 'released');
    assert.equal(statusC.answer_text, 'scoped-delegation-works');
    await nodeC.signOut?.();
    console.log('PASS browser-authorized scoped agent (OpenKey-style): uploaded from local copy, minted 10m sub-delegation, ran app & released without ever holding owner master key!');
    B.stop();
  }
  console.log('\nALL PASSED (standalone plugin bundle)');
} catch (err) {
  console.error('FAILED:', err?.stack || err);
  process.exitCode = 1;
} finally {
  for (const stop of cleanup) try { stop(); } catch {}
  await rm(work, { recursive: true, force: true }).catch(() => {});
}
