// node --test subhost/subhost.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BINDING_DOMAIN, ROUTER_KEYS, bindingPreimage, canonicalJson, codeHash, containerConfig, main,
  rateLimiter, reportDataFor, routerRequestDecision, sha256Hex, validateSpec,
} from './host.mjs';
import { eventDigest, matchTemplate, parseQuote, replayRtmr, verifyBundle } from './verify.mjs';
import { BEGIN, END, probeSpec, subhostBlock, withBlock } from './embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const lf = s => s.replace(/\r\n/g, '\n');
const SPEC = { name: 'tinycloud-probe', image: `docker.io/x/y@sha256:${'a'.repeat(64)}`, cmd: ['node', '-e', '1'], workdir: '/app', env: { A: 'b' }, user: 'node' };
const KEY = `0x04${'ab'.repeat(64)}`;
const APP = 'db82f581256a3c9244c4d7129a67336990d08cdf';

test('canonical JSON sorts keys and refuses values JSON cannot carry', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'] }), '{"a":[true,null,"x"],"b":1}');
  assert.throws(() => canonicalJson({ a: undefined }));
  assert.throws(() => canonicalJson({ a: NaN }));
  assert.throws(() => canonicalJson(new Date()));
});

test('a spec must pin its image by digest and run as a non-root user', () => {
  assert.deepEqual(validateSpec(SPEC), SPEC);
  assert.equal(validateSpec({ ...SPEC, user: undefined }).user, 'node');
  for (const bad of [
    { ...SPEC, image: 'docker.io/x/y:latest' },
    { ...SPEC, user: 'root' },
    { ...SPEC, env: { SUBHOST_DIR: '/' } },
    { ...SPEC, workdir: 'app' },
    { ...SPEC, privileged: true },
    { ...SPEC, cmd: [] },
  ]) assert.throws(() => validateSpec(bad));
});

test('the code hash covers every part of the spec', () => {
  const h = codeHash(SPEC);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(codeHash({ ...SPEC, env: { A: 'b' } }), h);
  assert.notEqual(codeHash({ ...SPEC, cmd: ['node', '-e', '2'] }), h);
  assert.notEqual(codeHash({ ...SPEC, image: `docker.io/x/y@sha256:${'b'.repeat(64)}` }), h);
  assert.notEqual(codeHash({ ...SPEC, env: { A: 'c' } }), h);
});

test('the binding text names the domain, app, code, key and nonce, and nothing loose', () => {
  const nonce = 'cd'.repeat(32);
  const pre = bindingPreimage({ appId: APP, name: 'tinycloud-probe', codeHash: codeHash(SPEC), publicKey: KEY, nonce });
  assert.deepEqual(JSON.parse(pre), { app_id: APP, code_hash: codeHash(SPEC), domain: BINDING_DOMAIN, name: 'tinycloud-probe', nonce, public_key: KEY });
  assert.match(reportDataFor(pre), /^[0-9a-f]{128}$/);
  assert.throws(() => bindingPreimage({ appId: APP, name: 'tinycloud-probe', codeHash: codeHash(SPEC), publicKey: `0x02${'ab'.repeat(32)}`, nonce }));
  assert.throws(() => bindingPreimage({ appId: APP, name: 'tinycloud-probe', codeHash: codeHash(SPEC), publicKey: KEY, nonce: 'short' }));
  assert.throws(() => bindingPreimage({ appId: 'ZZ', name: 'tinycloud-probe', codeHash: codeHash(SPEC), publicKey: KEY, nonce }));
});

test("Router's socket answers only Router's two key requests", () => {
  for (const k of ROUTER_KEYS) {
    const d = routerRequestDecision('POST', '/GetKey', JSON.stringify({ ...k, extra: 'dropped' }));
    assert.equal(d.allow, true);
    assert.deepEqual(JSON.parse(d.body), { path: k.path, purpose: k.purpose });
  }
  // The SDK omits nothing today, but a missing purpose means ''.
  assert.equal(routerRequestDecision('POST', '/GetKey', JSON.stringify({ path: 'teleport-router/record-encryption/v1' })).allow, true);
  for (const [method, url, body] of [
    ['POST', '/GetQuote', JSON.stringify({ report_data: '00' })],
    ['POST', '/Info', '{}'],
    ['POST', '/GetTlsKey', '{}'],
    ['POST', '/EmitEvent', '{}'],
    ['GET', '/GetKey', JSON.stringify(ROUTER_KEYS[0])],
    ['POST', '/GetKey', JSON.stringify({ path: 'teleport-router/tinycloud/v1', purpose: '' })],
    ['POST', '/GetKey', JSON.stringify({ path: '/tee-daemon/projects/tinycloud-probe', purpose: '' })],
    ['POST', '/GetKey?x=1', JSON.stringify(ROUTER_KEYS[0])],
    ['POST', '/GetKey', 'not json'],
    ['POST', '/GetKey', '[]'],
  ]) assert.equal(routerRequestDecision(method, url, body).allow, false, `${method} ${url} ${body}`);
});

test('the sub-container gets no privileges and only its own directory', () => {
  const c = containerConfig(validateSpec(SPEC), { hash: codeHash(SPEC), runtime: 'runc', probeDirOnHost: '/var/run/subhost/probe' });
  assert.deepEqual(c.HostConfig.Binds, ['/var/run/subhost/probe:/run/subhost']);
  assert.equal(c.HostConfig.Privileged, false);
  assert.deepEqual(c.HostConfig.CapDrop, ['ALL']);
  assert.equal(c.HostConfig.NetworkMode, 'bridge');
  assert.equal(c.HostConfig.Runtime, undefined);
  assert.equal(c.User, 'node');
  assert.equal(containerConfig(validateSpec(SPEC), { hash: 'h', runtime: 'runsc', probeDirOnHost: '/p' }).HostConfig.Runtime, 'runsc');
});

test('rate limiter', () => {
  let now = 0;
  const allow = rateLimiter(2, 1000, () => now);
  assert.equal(allow(), true); assert.equal(allow(), true); assert.equal(allow(), false);
  now = 1000;
  assert.equal(allow(), true);
});

// Router's CVM attestation archived by CI on Nov 11 (public in this repo).
const evidence = JSON.parse(readFileSync(join(ROOT, 'evidences/2026-11-11/attestation.json'), 'utf8'));
const realQuote = evidence.app_certificates.map(c => c.quote).find(q => typeof q === 'string' && q.length > 1000).replace(/^0x/, '');

test('quote parsing, event digests and RTMR3 replay agree with a real Router quote', () => {
  const tcb = evidence.tcb_info;
  const q = parseQuote(realQuote);
  for (const f of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']) assert.equal(q[f], tcb[f], f);
  for (const e of tcb.event_log.filter(x => x.imr === 3)) assert.equal(eventDigest(e), e.digest, e.event);
  assert.equal(replayRtmr(tcb.event_log, 3), q.rtmr3);
  const composeHash = tcb.event_log.find(e => e.event === 'compose-hash').event_payload;
  assert.equal(q.mrConfigId, `01${composeHash}${'0'.repeat(30)}`);
  const approved = JSON.parse(readFileSync(join(ROOT, 'subhost/approved.json'), 'utf8'));
  assert.ok(approved.os.some(o => o.mrtd === q.mrtd && o.rtmr0 === q.rtmr0 && o.rtmr1 === q.rtmr1 && o.rtmr2 === q.rtmr2));
});

test('the template match lets only the four deploy values vary', () => {
  const template = 'a: x:${GIT_SHA}@${IMAGE_DIGEST}\nb: ${GIT_SHA}\nc: ${AGENT_IMAGE_DIGEST} ${DISCORD_IMAGE_DIGEST}\n';
  const d = `sha256:${'1'.repeat(64)}`;
  const deployed = `a: x:abc1234@${d}\nb: abc1234\nc: ${d} ${d}\n`;
  assert.deepEqual(matchTemplate(template, deployed), { GIT_SHA: 'abc1234', IMAGE_DIGEST: d, AGENT_IMAGE_DIGEST: d, DISCORD_IMAGE_DIGEST: d });
  assert.deepEqual(matchTemplate(template.replace(/\n/g, '\r\n'), deployed).GIT_SHA, 'abc1234');
  assert.throws(() => matchTemplate(template, deployed.replace('b: abc1234', 'b: abc9999')));
  assert.throws(() => matchTemplate(template, `${deployed}d: extra\n`));
  assert.throws(() => matchTemplate(template, deployed.replace(d, 'latest')));
  assert.throws(() => matchTemplate(template, deployed.replace('abc1234@', 'abc1234\n  privileged: true\n@')));
  assert.throws(() => matchTemplate('x: ${HOME}\n', 'x: /root\n'));
});

test('the template match handles the real template, which embeds the host program', () => {
  const template = readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8');
  const values = { GIT_SHA: 'abcdef0', IMAGE_DIGEST: `sha256:${'1'.repeat(64)}`, AGENT_IMAGE_DIGEST: `sha256:${'2'.repeat(64)}`, DISCORD_IMAGE_DIGEST: `sha256:${'3'.repeat(64)}` };
  const filled = lf(template).replace(/\$\{([A-Z_]+)\}/g, (_, name) => values[name]);
  assert.ok(filled.length > 20000, 'the template carries the host program');
  assert.deepEqual(matchTemplate(template, filled), values);
  assert.throws(() => matchTemplate(template, filled.replace('- SUBHOST_MAIN=1', '- SUBHOST_MAIN=1\n      - EXTRA=1')));
  assert.throws(() => matchTemplate(template, filled.replace('/var/run/subhost/router:/var/run/dstack-filtered:ro', '/var/run:/var/run/dstack-filtered:ro')));
  assert.throws(() => matchTemplate(template, filled.replace(/base64,[A-Za-z0-9]/, m => `${m}A`)), 'one changed byte of the host program');
});

test('the compose template: socket mounts are exactly as intended and the embedded block is current', () => {
  const text = lf(readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8'));
  assert.equal(lf(withBlock(text, subhostBlock(ROOT))), text, 'run node subhost/embed.mjs');
  const services = text.slice(0, text.indexOf('\nvolumes:')).split(/\n(?=  [a-z0-9_-]+:\n)/).slice(1);
  const mounts = Object.fromEntries(services.map(b => [b.match(/^  ([a-z0-9_-]+):/)[1],
    [...b.matchAll(/^\s+- "?(\/[^\s:"]*)/gm)].map(m => m[1]).filter(p => p.startsWith('/var') || p === '/' || p.startsWith('/run') || p.startsWith('/proc') || p.startsWith('/sys'))]));
  assert.deepEqual(mounts.router, ['/var/run/subhost/router']);
  assert.deepEqual(mounts.subhost, ['/var/run/dstack.sock', '/var/run/docker.sock', '/var/run/subhost']);
  for (const name of Object.keys(mounts)) {
    if (['router', 'subhost', 'dstack-ingress', 'hermes-ingress'].includes(name)) continue;
    assert.deepEqual(mounts[name], [], `${name} must not mount host paths under /var, /run, /proc or /sys`);
  }
  assert.deepEqual(mounts['dstack-ingress'], ['/var/run/dstack.sock']);
  assert.deepEqual(mounts['hermes-ingress'], ['/var/run/dstack.sock']);
  assert.ok(!/privileged|cap_add|devices:|pid: *host|network_mode: *host|ipc: *host|userns_mode|volumes_from/.test(text));
  const block = text.slice(text.indexOf(BEGIN), text.indexOf(END));
  assert.ok(!block.includes('$'), 'the subhost service must not take values from the deploy environment');
  assert.match(text, /- DSTACK_ENDPOINT=\/var\/run\/dstack-filtered\/dstack\.sock/);
});

// A synthetic quote and event log that verifyBundle should accept, then variations it must refuse.
function syntheticBundle({ template, deployedCompose, nonce, spec, publicKey = KEY, appId = APP, allowedEnvs }) {
  const manifest = allowedEnvs ? { allowed_envs: allowedEnvs, runner: 'docker-compose' } : { runner: 'docker-compose' };
  const appCompose = canonicalJson({ ...manifest, docker_compose_file: deployedCompose, pre_launch_script: 'echo hi' });
  const composeHash = sha256Hex(appCompose);
  const ev = (event, payload) => { const e = { imr: 3, event_type: 134217729, event, event_payload: payload }; return { ...e, digest: eventDigest(e) }; };
  const events = [ev('app-id', appId), ev('compose-hash', composeHash), ev('os-image-hash', 'ee'.repeat(32))];
  const hash = codeHash(spec);
  const preimage = bindingPreimage({ appId, name: spec.name, codeHash: hash, publicKey, nonce });
  const quote = Buffer.alloc(632);
  quote.writeUInt16LE(4, 0); quote.writeUInt32LE(0x81, 4);
  Buffer.from(`01${composeHash}${'0'.repeat(30)}`, 'hex').copy(quote, 232);
  Buffer.from(replayRtmr(events, 3), 'hex').copy(quote, 520);
  Buffer.from(reportDataFor(preimage), 'hex').copy(quote, 568);
  const approved = { app_ids: [appId], manifests: [manifest], pre_launch_script_sha256: [sha256Hex('echo hi')], os: [{ os_image_hash: 'ee'.repeat(32), mrtd: '00'.repeat(48), rtmr0: '00'.repeat(48), rtmr1: '00'.repeat(48), rtmr2: '00'.repeat(48) }] };
  return { bundle: { version: 1, preimage, report_data: reportDataFor(preimage), quote: quote.toString('hex'), event_log: events, app_compose: appCompose, spec, code_hash: hash, runtime: 'runc', container: { public_key: publicKey } }, expected: { nonce, spec, template, approved } };
}

test('verifyBundle accepts a consistent bundle and refuses each kind of mismatch', () => {
  const nonce = randomBytes(32).toString('hex');
  const template = 'services:\n  router:\n    image: r:${GIT_SHA}@${IMAGE_DIGEST}\n';
  const deployed = `services:\n  router:\n    image: r:abcdef0@sha256:${'2'.repeat(64)}\n`;
  const { bundle, expected } = syntheticBundle({ template, deployedCompose: deployed, nonce, spec: SPEC });
  const facts = verifyBundle(bundle, expected);
  assert.equal(facts.codeHash, codeHash(SPEC));
  assert.equal(facts.routerVersions.GIT_SHA, 'abcdef0');
  assert.equal(facts.mrConfigCarriesCompose, true);

  const refuse = (mutate, why) => { const b = structuredClone(bundle); const e = structuredClone(expected); mutate(b, e); assert.throws(() => verifyBundle(b, e), undefined, why); };
  refuse((b, e) => { e.nonce = randomBytes(32).toString('hex'); }, 'stale nonce');
  refuse((b, e) => { e.spec = { ...SPEC, cmd: ['node', '-e', '2'] }; }, 'different approved code');
  refuse(b => { b.container.public_key = `0x04${'cd'.repeat(64)}`; }, 'another key');
  refuse(b => { b.spec = { ...SPEC, env: { A: 'other' } }; }, 'running spec differs');
  refuse(b => { b.app_compose = b.app_compose.replace('echo hi', 'echo ho'); }, 'compose not the measured one');
  refuse(b => { b.event_log[2].event_payload = 'ff'.repeat(32); }, 'event edited after digest');
  refuse((b, e) => { e.approved.os = []; }, 'unapproved OS');
  refuse((b, e) => { e.approved.pre_launch_script_sha256 = []; }, 'unapproved pre-launch script');
  refuse((b, e) => { e.template = 'services:\n  router:\n    image: r:${GIT_SHA}@${IMAGE_DIGEST}\n    privileged: true\n'; }, 'template differs');
  refuse(b => { const q = Buffer.from(b.quote, 'hex'); q[600] ^= 1; b.quote = q.toString('hex'); }, 'report data altered');
  refuse((b, e) => { e.approved.app_ids = ['0'.repeat(40)]; }, 'another CVM');

  // A manifest that adds a secret name, or any manifest naming a shell-start variable, is refused.
  const withEnvs = names => { const c = syntheticBundle({ template, deployedCompose: deployed, nonce, spec: SPEC, allowedEnvs: names }); return c; };
  const extra = withEnvs(['NEW_SECRET']);
  assert.throws(() => verifyBundle(extra.bundle, { ...extra.expected, approved: { ...extra.expected.approved, manifests: [{ runner: 'docker-compose' }] } }), /deploy manifest/);
  const risky = withEnvs(['BASH_ENV']);
  assert.throws(() => verifyBundle(risky.bundle, risky.expected), /BASH_ENV/);
  const fine = withEnvs(['NEW_SECRET']);
  assert.equal(verifyBundle(fine.bundle, fine.expected).appId, APP);

  // A different compose file is refused even when re-measured consistently.
  const other = syntheticBundle({ template, deployedCompose: `${deployed}  extra:\n    image: x\n`, nonce, spec: SPEC });
  assert.throws(() => verifyBundle(other.bundle, other.expected), /approved template/);
});

test('the embedded container spec is probe.base.json plus probe.mjs', () => {
  const spec = probeSpec(ROOT);
  assert.equal(spec.cmd[3], lf(readFileSync(join(ROOT, 'subhost/probe.mjs'), 'utf8')));
  assert.match(spec.image, /@sha256:[0-9a-f]{64}$/);
});

// The host itself, against stand-ins for dstack's and Docker's sockets. Unix
// sockets: Linux and macOS only (CI runs this).
test('host: Router key filter, key registration, binding quote and grant hand-off', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subhost-'));
  const servers = [];
  const listen = (path, handler) => new Promise(resolve => { const s = http.createServer(handler); servers.push(s); s.listen(path, resolve); });
  const body = req => new Promise(resolve => { let t = ''; req.on('data', c => { t += c; }); req.on('end', () => resolve(t)); });
  const json = (res, status, v) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
  const dstackCalls = [];
  await listen(join(dir, 'dstack.sock'), async (req, res) => {
    const payload = JSON.parse((await body(req)) || '{}');
    dstackCalls.push([req.url, payload]);
    if (req.url === '/GetKey') return json(res, 200, { key: createHash('sha256').update(payload.path).digest('hex'), signature_chain: [] });
    if (req.url === '/Info') return json(res, 200, { app_id: APP, tcb_info: JSON.stringify({ app_compose: '{"runner":"docker-compose"}' }) });
    if (req.url === '/GetQuote') {
      const q = Buffer.alloc(632); q.writeUInt16LE(4, 0); q.writeUInt32LE(0x81, 4);
      Buffer.from(payload.report_data, 'hex').copy(q, 568);
      return json(res, 200, { quote: q.toString('hex'), event_log: '[]' });
    }
    json(res, 404, {});
  });
  let created = null;
  await listen(join(dir, 'docker.sock'), async (req, res) => {
    const text = await body(req);
    if (req.method === 'GET' && req.url.startsWith('/images/')) return json(res, 200, {});
    if (req.method === 'DELETE') { res.writeHead(404); return res.end(); }
    if (req.url === '/info') return json(res, 200, { Runtimes: { runc: {} } });
    if (req.url.startsWith('/containers/create')) { created = JSON.parse(text); return json(res, 201, { Id: 'c1' }); }
    if (req.url === '/containers/c1/start') { res.writeHead(204); return res.end(); }
    if (req.url === '/containers/c1/json') return json(res, 200, { State: { Running: true } });
    json(res, 404, {});
  });
  const spec = validateSpec(SPEC);
  const host = await main({
    SUBHOST_DSTACK_SOCKET: join(dir, 'dstack.sock'), SUBHOST_DOCKER_SOCKET: join(dir, 'docker.sock'),
    SUBHOST_BASE: join(dir, 'base'), SUBHOST_PORT: '0', SUBHOST_PROBE_SPEC: Buffer.from(JSON.stringify(spec)).toString('base64'),
  });
  const unix = (path, method, url, payload) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath: path, method, path: url, headers: { 'Content-Type': 'application/json' } }, res => { let t = ''; res.on('data', c => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, body: t })); });
    req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
  const base = `http://127.0.0.1:${host.port}`;
  try {
    // The health check answers before the sub-container exists; it starts in the background.
    assert.equal((await fetch(`${base}/health`)).status, 200);
    for (let i = 0; i < 100 && !(created && host.state.status === 'running'); i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(host.state.status, 'running');
    assert.equal(created.HostConfig.Privileged, false);
    assert.deepEqual(created.HostConfig.Binds, [`${join(dir, 'base')}/probe:/run/subhost`]);

    const routerSock = join(dir, 'base', 'router', 'dstack.sock');
    const key = await unix(routerSock, 'POST', '/GetKey', { path: 'teleport-router/tinycloud/v1', purpose: 'secp256k1' });
    assert.equal(key.status, 200);
    assert.equal(JSON.parse(key.body).key, createHash('sha256').update('teleport-router/tinycloud/v1').digest('hex'));
    assert.equal((await unix(routerSock, 'POST', '/GetQuote', { report_data: '00' })).status, 403);
    assert.equal((await unix(routerSock, 'POST', '/GetKey', { path: 'something/else', purpose: '' })).status, 403);
    assert.ok(!dstackCalls.some(([url, p]) => url === '/GetKey' && p.path === 'something/else'));

    // Router's own dstack client, unchanged, through the filtered socket (when server deps are installed, as in CI).
    let sdk = null;
    try { sdk = await import('../server/node_modules/@phala/dstack-sdk/dist/node/index.js'); } catch { /* not installed here */ }
    if (sdk?.DstackClient) {
      const client = new sdk.DstackClient(routerSock);
      for (const { path, purpose } of ROUTER_KEYS) {
        const got = await client.getKey(path, purpose);
        assert.equal(Buffer.from(got.key).toString('hex'), createHash('sha256').update(path).digest('hex'), path);
      }
      await assert.rejects(client.getQuote('00'));
      await assert.rejects(client.getKey('teleport-router/other/v1', ''));
    }

    assert.equal((await fetch(`${base}/bundle?nonce=${'00'.repeat(32)}`)).status, 409, 'no key registered yet');
    const hostSock = join(dir, 'base', 'probe', 'host.sock');
    assert.equal((await unix(hostSock, 'POST', '/register', { public_key: 'nope' })).status, 400);
    assert.equal((await unix(hostSock, 'POST', '/register', { public_key: KEY })).status, 200);
    assert.equal((await unix(hostSock, 'POST', '/register', { public_key: KEY })).status, 409, 'one key per container');

    const nonce = randomBytes(32).toString('hex');
    const bundle = await (await fetch(`${base}/bundle?nonce=${nonce}`)).json();
    assert.equal(bundle.preimage, bindingPreimage({ appId: APP, name: spec.name, codeHash: codeHash(spec), publicKey: KEY, nonce }));
    assert.equal(parseQuote(bundle.quote).reportData, reportDataFor(bundle.preimage));
    assert.equal((await fetch(`${base}/bundle?nonce=XYZ`)).status, 400);

    await listen(join(dir, 'base', 'probe', 'probe.sock'), async (req, res) => json(res, 200, { ok: true, echoed: JSON.parse(await body(req)).path }));
    const used = await (await fetch(`${base}/use`, { method: 'POST', body: JSON.stringify({ delegation: 'x', path: 'hello.txt' }) })).json();
    assert.deepEqual(used, { ok: true, echoed: 'hello.txt' });
  } finally {
    await host.close();
    for (const s of servers) { s.closeAllConnections?.(); s.close(); }
    rmSync(dir, { recursive: true, force: true });
  }
});
