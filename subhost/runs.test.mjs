// Trace app runs in the sub-container host (docs/attested-trace-apps.md).
// node --test subhost/runs.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RUN_DOMAIN, bindingPreimage, canonicalJson, codeHash, main, reportDataFor, runBindingPreimage, runnerConfig, runnersCodeHash,
  runsRequestCheck, sandboxConfig, sha256Hex, validateSpec,
} from './host.mjs';
import { eventDigest, parseQuote, replayRtmr, verifyRunBundle } from './verify.mjs';
import { runnerSpec, sandboxSpec, subhostBlock } from './embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const image = `docker.io/x/router@sha256:${'a'.repeat(64)}`;
const RUNNER = validateSpec({ name: 'trace-runner', image, cmd: ['node', '-e', 'runner'], workdir: '/app/server', env: { NODE_ENV: 'production' }, user: 'node' });
const SANDBOX = validateSpec({ name: 'trace-sandbox', image, cmd: ['node', '-e', 'sandbox'], workdir: '/app/server', env: {}, user: 'node' });
const KEY = `0x04${'ab'.repeat(64)}`;
const APP = 'db82f581256a3c9244c4d7129a67336990d08cdf';
const RUN = 'cd'.repeat(32);

test('a run binding names its own domain, the runners, the run, the key and the nonce', () => {
  const nonce = randomBytes(32).toString('hex');
  const text = runBindingPreimage({ appId: APP, name: 'trace-runner', codeHash: runnersCodeHash(RUNNER, SANDBOX), runHash: RUN, publicKey: KEY, nonce });
  assert.deepEqual(Object.keys(JSON.parse(text)), ['app_id', 'code_hash', 'domain', 'name', 'nonce', 'public_key', 'run_hash']);
  assert.equal(JSON.parse(text).domain, RUN_DOMAIN);
  assert.notEqual(text, bindingPreimage({ appId: APP, name: 'trace-runner', codeHash: runnersCodeHash(RUNNER, SANDBOX), publicKey: KEY, nonce }));
  for (const bad of [{ runHash: 'x' }, { publicKey: '0x02' + 'ab'.repeat(32) }, { nonce: 'XYZ' }, { appId: 'nope' }])
    assert.throws(() => runBindingPreimage({ appId: APP, name: 'trace-runner', codeHash: RUN, runHash: RUN, publicKey: KEY, nonce, ...bad }));
});

test('the runners\' code hash covers both the runner and the sandbox', () => {
  const h = runnersCodeHash(RUNNER, SANDBOX);
  assert.notEqual(runnersCodeHash({ ...RUNNER, cmd: ['node', '-e', 'other'] }, SANDBOX), h);
  assert.notEqual(runnersCodeHash(RUNNER, { ...SANDBOX, env: { X: '1' } }), h);
  assert.equal(h, sha256Hex(canonicalJson({ runner: codeHash(RUNNER), sandbox: codeHash(SANDBOX) })));
});

test('a sandbox gets no network, no privileges, no kept logs and only its own directory', () => {
  const c = sandboxConfig(SANDBOX, { hash: 'h', runtime: 'runc', dirOnHost: '/var/run/subhost/sandboxes/abc' });
  assert.equal(c.NetworkDisabled, true);
  assert.equal(c.HostConfig.NetworkMode, 'none');
  assert.deepEqual(c.HostConfig.Binds, ['/var/run/subhost/sandboxes/abc:/run/sandbox']);
  assert.equal(c.HostConfig.Privileged, false);
  assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
  assert.equal(c.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(c.HostConfig.LogConfig, { Type: 'none' });
  assert.equal(c.User, 'node');
  assert.equal(sandboxConfig(SANDBOX, { hash: 'h', runtime: 'runsc', dirOnHost: '/d' }).HostConfig.Runtime, 'runsc');
  const r = runnerConfig(RUNNER, { hash: 'h', runtime: 'runc', dirOnHost: '/var/run/subhost/runner', sandboxesOnHost: '/var/run/subhost/sandboxes' });
  assert.deepEqual(r.HostConfig.Binds, ['/var/run/subhost/runner:/run/subhost', '/var/run/subhost/sandboxes:/run/sandboxes']);
  assert.deepEqual(r.HostConfig.LogConfig, { Type: 'none' });
  assert.ok(!JSON.stringify(r).includes('dstack'), 'the runner never sees dstack');
});

test('Router\'s runs socket takes only well-formed prepare and run requests', () => {
  const nonce = '00'.repeat(32);
  assert.equal(runsRequestCheck('/prepare', { nonce, description: { run_id: 'r1' }, code: 'x' }), null);
  assert.equal(runsRequestCheck('/run', { run_id: 'r1', delegation: 'd', wrap: {}, host: 'h' }), null);
  for (const [path, body] of [['/prepare', { nonce: 'x', description: { run_id: 'r1' }, code: 'x' }], ['/prepare', { nonce, description: [], code: 'x' }],
    ['/prepare', { nonce, description: { run_id: 'a b' }, code: 'x' }], ['/prepare', { nonce, description: { run_id: 'r1' }, code: '' }],
    ['/run', { run_id: '', delegation: 'd', wrap: {}, host: 'h' }], ['/run', { run_id: 'r1', delegation: 'd'.repeat(90001), wrap: {}, host: 'h' }],
    ['/run', { run_id: 'r1', delegation: 'd', host: 'h' }], ['/GetKey', { path: 'x' }], ['/prepare', null]])
    assert.notEqual(runsRequestCheck(path, body), null, `${path} ${JSON.stringify(body)?.slice(0, 60)}`);
});

// A synthetic run bundle that verifyRunBundle should accept, then variations it must refuse.
function syntheticRunBundle({ nonce, runHash = RUN, publicKey = KEY }) {
  const template = 'services:\n  router:\n    image: r:${GIT_SHA}@${IMAGE_DIGEST}\n';
  const deployed = `services:\n  router:\n    image: r:abcdef0@sha256:${'2'.repeat(64)}\n`;
  const manifest = { runner: 'docker-compose' };
  const appCompose = canonicalJson({ ...manifest, docker_compose_file: deployed, pre_launch_script: 'echo hi' });
  const composeHash = sha256Hex(appCompose);
  const ev = (event, payload) => { const e = { imr: 3, event_type: 134217729, event, event_payload: payload }; return { ...e, digest: eventDigest(e) }; };
  const events = [ev('app-id', APP), ev('compose-hash', composeHash), ev('os-image-hash', 'ee'.repeat(32))];
  const hash = runnersCodeHash(RUNNER, SANDBOX);
  const preimage = runBindingPreimage({ appId: APP, name: RUNNER.name, codeHash: hash, runHash, publicKey, nonce });
  const quote = Buffer.alloc(632);
  quote.writeUInt16LE(4, 0); quote.writeUInt32LE(0x81, 4);
  Buffer.from(`01${composeHash}${'0'.repeat(30)}`, 'hex').copy(quote, 232);
  Buffer.from(replayRtmr(events, 3), 'hex').copy(quote, 520);
  Buffer.from(reportDataFor(preimage), 'hex').copy(quote, 568);
  const approved = { app_ids: [APP], manifests: [manifest], pre_launch_script_sha256: [sha256Hex('echo hi')], os: [{ os_image_hash: 'ee'.repeat(32), mrtd: '00'.repeat(48), rtmr0: '00'.repeat(48), rtmr1: '00'.repeat(48), rtmr2: '00'.repeat(48) }] };
  return {
    bundle: { version: 1, simulated: false, preimage, report_data: reportDataFor(preimage), quote: quote.toString('hex'), event_log: events, app_compose: appCompose,
      runner_spec: RUNNER, sandbox_spec: SANDBOX, code_hash: hash, runtime: 'runc' },
    expected: { nonce, runHash: RUN, publicKey: KEY, runnerSpec: RUNNER, sandboxSpec: SANDBOX, template, approved },
  };
}

test('verifyRunBundle accepts a consistent run bundle and refuses each kind of mismatch', () => {
  const nonce = randomBytes(32).toString('hex');
  const { bundle, expected } = syntheticRunBundle({ nonce });
  const facts = verifyRunBundle(bundle, expected);
  assert.equal(facts.codeHash, runnersCodeHash(RUNNER, SANDBOX));
  assert.equal(facts.reportData, parseQuote(bundle.quote).reportData);
  assert.deepEqual(facts.runner, { appId: APP, name: 'trace-runner', codeHash: facts.codeHash });
  const refuse = (mutate, why) => { const b = structuredClone(bundle); const e = structuredClone(expected); mutate(b, e); assert.throws(() => verifyRunBundle(b, e), undefined, why); };
  refuse((b, e) => { e.nonce = randomBytes(32).toString('hex'); }, 'stale nonce');
  refuse((b, e) => { e.runHash = 'ef'.repeat(32); }, 'another run');
  refuse((b, e) => { e.publicKey = `0x04${'cd'.repeat(64)}`; }, 'another key');
  refuse(b => { b.runner_spec = { ...RUNNER, cmd: ['node', '-e', 'evil'] }; }, 'runner differs');
  refuse(b => { b.sandbox_spec = { ...SANDBOX, cmd: ['node', '-e', 'evil'] }; }, 'sandbox differs');
  refuse((b, e) => { e.sandboxSpec = { ...SANDBOX, env: { NETWORK: 'on' } }; }, 'checkout approves another sandbox');
  refuse(b => { const q = Buffer.from(b.quote, 'hex'); q[600] ^= 1; b.quote = q.toString('hex'); }, 'report data altered');
  refuse((b, e) => { e.approved.app_ids = ['0'.repeat(40)]; }, 'another CVM');
  // A probe binding for the same key and nonce never passes as a run binding.
  refuse(b => { b.preimage = bindingPreimage({ appId: APP, name: RUNNER.name, codeHash: b.code_hash, publicKey: KEY, nonce }); }, 'probe binding');
});

test('the runner and sandbox are in the compose file only while their image is pinned', () => {
  assert.match(runnerSpec(ROOT).image, /@sha256:[0-9a-f]{64}$/, 'this checkout pins the runner image');
  assert.equal(runnerSpec(ROOT).image, sandboxSpec(ROOT).image);
  assert.ok(subhostBlock(ROOT).includes('SUBHOST_RUNNER_SPEC') && subhostBlock(ROOT).includes('SUBHOST_SANDBOX_SPEC'));
  const root = mkdtempSync(join(tmpdir(), 'subhost-embed-'));
  try {
    mkdirSync(join(root, 'subhost'));
    for (const f of ['host.mjs', 'probe.mjs', 'probe.base.json', 'runner.mjs', 'sandbox.mjs', 'runner.base.json', 'sandbox.base.json']) cpSync(join(ROOT, 'subhost', f), join(root, 'subhost', f));
    for (const name of ['runner', 'sandbox']) writeFileSync(join(root, 'subhost', `${name}.base.json`), JSON.stringify({ name: `trace-${name}`, image: 'PENDING', workdir: '/app/server', env: {}, user: 'node' }));
    assert.equal(runnerSpec(root), null);
    assert.ok(!subhostBlock(root).includes('SUBHOST_RUNNER_SPEC'));
    for (const name of ['runner', 'sandbox']) writeFileSync(join(root, 'subhost', `${name}.base.json`), JSON.stringify({ name: `trace-${name}`, image, workdir: '/app/server', env: {}, user: 'node' }));
    const block = subhostBlock(root);
    const env = name => JSON.parse(Buffer.from(block.match(new RegExp(`- ${name}=([A-Za-z0-9+/=]+)`))[1], 'base64').toString('utf8'));
    assert.equal(env('SUBHOST_RUNNER_SPEC').cmd[3].includes('runnerService'), true);
    assert.equal(env('SUBHOST_SANDBOX_SPEC').cmd[3].includes('sandboxJobHandler'), true);
    assert.deepEqual(env('SUBHOST_RUNNER_SPEC'), runnerSpec(root));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// The host with runs enabled, against stand-ins for dstack, Docker and the runner. Unix sockets: Linux and macOS (CI runs this).
test('host: Router prepares and runs through the runner; each run gets its own sandbox', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subhost-runs-'));
  const servers = [];
  const listen = (path, handler) => new Promise(resolve => { const s = http.createServer(handler); servers.push(s); s.listen(path, resolve); });
  const body = req => new Promise(resolve => { let t = ''; req.on('data', c => { t += c; }); req.on('end', () => resolve(t)); });
  const json = (res, status, v) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  await listen(join(dir, 'dstack.sock'), async (req, res) => {
    const payload = JSON.parse((await body(req)) || '{}');
    if (req.url === '/Info') return json(res, 200, { app_id: APP, tcb_info: JSON.stringify({ app_compose: '{"runner":"docker-compose"}' }) });
    if (req.url === '/GetQuote') { const q = Buffer.alloc(632); q.writeUInt16LE(4, 0); q.writeUInt32LE(0x81, 4); Buffer.from(payload.report_data, 'hex').copy(q, 568); return json(res, 200, { quote: q.toString('hex'), event_log: '[]' }); }
    json(res, 404, {});
  });
  const created = [];
  const removed = [];
  await listen(join(dir, 'docker.sock'), async (req, res) => {
    const text = await body(req);
    if (req.method === 'GET' && req.url.startsWith('/images/')) return json(res, 200, {});
    if (req.method === 'DELETE') { removed.push(req.url); res.writeHead(204); return res.end(); }
    if (req.url === '/info') return json(res, 200, { Runtimes: { runc: {} } });
    if (req.url.startsWith('/containers/create')) { const name = new URL(req.url, 'http://x').searchParams.get('name'); created.push({ name, config: JSON.parse(text) }); return json(res, 201, { Id: name }); }
    if (/^\/containers\/[^/]+\/start$/.test(req.url)) { res.writeHead(204); return res.end(); }
    if (/^\/containers\/[^/]+\/json$/.test(req.url)) return json(res, 200, { State: { Running: true } });
    json(res, 404, {});
  });
  const b64 = spec => Buffer.from(JSON.stringify(spec)).toString('base64');
  const host = await main({
    SUBHOST_DSTACK_SOCKET: join(dir, 'dstack.sock'), SUBHOST_DOCKER_SOCKET: join(dir, 'docker.sock'), SUBHOST_BASE: join(dir, 'base'), SUBHOST_PORT: '0',
    SUBHOST_PROBE_SPEC: b64({ name: 'tinycloud-probe', image, cmd: ['node', '-e', '1'], workdir: '/app', env: {}, user: 'node' }),
    SUBHOST_RUNNER_SPEC: b64(RUNNER), SUBHOST_SANDBOX_SPEC: b64(SANDBOX),
  });
  const unix = (path, method, url, payload) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path, method, path: url, headers: { 'Content-Type': 'application/json' } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); });
    req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  try {
    for (let i = 0; i < 200 && !(host.runs.state.status === 'running' && host.state.status === 'running'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(host.runs.state.status, 'running');
    const runner = created.find(c => c.name === 'subhost-runner').config;
    assert.deepEqual(runner.HostConfig.Binds, [`${join(dir, 'base')}/runner:/run/subhost`, `${join(dir, 'base')}/sandboxes:/run/sandboxes`]);
    // The runner's side, standing in for runner.mjs.
    const description = { run_id: 'run-1', v: 1, anything: 'the runner checks it' };
    await listen(join(dir, 'base', 'runner', 'runner.sock'), async (req, res) => {
      const p = JSON.parse(await body(req));
      if (req.url === '/prepare') return json(res, 200, { run_id: p.description.run_id, run_hash: sha256Hex(canonicalJson(p.description)), public_key: KEY });
      json(res, 200, { run_id: p.run_id, sealed: { meta: {}, data: 'sealed' } });
    });
    const runs = join(dir, 'base', 'router', 'runs.sock');
    const nonce = randomBytes(32).toString('hex');
    const prepared = await unix(runs, 'POST', '/prepare', { description, code: 'function analyze() { return "" }', nonce });
    assert.equal(prepared.status, 200, prepared.body);
    const p = JSON.parse(prepared.body);
    const expected = runBindingPreimage({ appId: APP, name: 'trace-runner', codeHash: runnersCodeHash(RUNNER, SANDBOX), runHash: sha256Hex(canonicalJson(description)), publicKey: KEY, nonce });
    assert.equal(p.bundle.preimage, expected);
    assert.equal(parseQuote(p.bundle.quote).reportData, reportDataFor(expected));
    assert.deepEqual(p.runner, { appId: APP, name: 'trace-runner', codeHash: runnersCodeHash(RUNNER, SANDBOX) });
    assert.equal((await unix(runs, 'POST', '/prepare', { description, code: 'x', nonce: 'bad' })).status, 400);
    assert.equal((await unix(runs, 'POST', '/GetKey', { path: 'teleport-router/tinycloud/v1' })).status, 404);
    const ran = await unix(runs, 'POST', '/run', { run_id: 'run-1', delegation: 'd', wrap: {}, host: 'h' });
    assert.deepEqual(JSON.parse(ran.body), { run_id: 'run-1', sealed: { meta: {}, data: 'sealed' } });
    // The runner asks for a sandbox; it gets no network and only its own directory, and is removed after.
    const hostSock = join(dir, 'base', 'runner', 'host.sock');
    const id = randomBytes(16).toString('hex');
    assert.equal((await unix(hostSock, 'POST', `/sandbox/${id}`)).status, 200);
    const sandbox = created.find(c => c.name === `subhost-sandbox-${id}`).config;
    assert.equal(sandbox.HostConfig.NetworkMode, 'none');
    assert.deepEqual(sandbox.HostConfig.Binds, [`${join(dir, 'base')}/sandboxes/${id}:/run/sandbox`]);
    assert.equal((await unix(hostSock, 'POST', `/sandbox/${id}`)).status, 503, 'one container per sandbox id');
    assert.equal((await unix(hostSock, 'POST', '/sandbox/../../etc')).status, 404);
    assert.equal((await unix(hostSock, 'DELETE', `/sandbox/${id}`)).status, 200);
    assert.ok(removed.some(u => u.includes(`subhost-sandbox-${id}`)));
    const status = await (await fetch(`http://127.0.0.1:${host.port}/`)).json();
    assert.equal(status.runs.code_hash, runnersCodeHash(RUNNER, SANDBOX));
  } finally {
    await host.close();
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    rmSync(dir, { recursive: true, force: true });
  }
});
