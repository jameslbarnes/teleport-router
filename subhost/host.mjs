// The sub-container host: a small program that shares Router's CVM and is the
// only thing in it, besides the two TLS ingress containers, that can ask dstack
// for keys and quotes.
//
// It does three jobs:
//   1. Router's keys. Router no longer mounts dstack's socket. The host gives it a
//      socket that answers exactly two requests: the two keys Router has always
//      used, at the same paths, so Router's TinyCloud identity and record key do
//      not change. Every other request is refused.
//   2. One sub-container. The host runs a container from a spec (a pinned image,
//      a command, a working directory and a few settings). The spec's hash is the
//      container's code hash. The container makes a key in memory and tells the
//      host its public key over a socket that only it can reach.
//   3. Binding quotes. On request, the host asks dstack for a TDX quote whose
//      report data is SHA-512 of {domain, app id, name, code hash, public key,
//      nonce}. Anyone can then check that this public key belongs to a container
//      running exactly that code, in this CVM, now.
//
// Node built-ins only: the compose file runs this file on the official node image,
// embedded as base64, so the deployed text of the host is part of the CVM's
// measured compose file. It starts only when SUBHOST_MAIN=1; importing it (for
// tests and for the grant script) only defines the helpers below.
import { createHash } from 'node:crypto';
import http from 'node:http';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';

export const BINDING_DOMAIN = 'teleport-router/subhost-binding/v1';

/** Router's two dstack keys, exactly as server/src/tinycloud-identity.ts asks for them. */
export const ROUTER_KEYS = Object.freeze([
  Object.freeze({ path: 'teleport-router/tinycloud/v1', purpose: 'secp256k1' }),
  Object.freeze({ path: 'teleport-router/record-encryption/v1', purpose: '' }),
]);

const NAME_RE = /^[a-z][a-z0-9-]{1,30}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._/-]{0,200}@sha256:[0-9a-f]{64}$/;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_RE = /^0x04[0-9a-f]{128}$/;
const APP_ID_RE = /^[0-9a-f]{40}$/;

/** Deterministic JSON: keys sorted, no whitespace, only plain JSON values. */
export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: numbers must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported value of type ${typeof value}`);
}

export const sha256Hex = data => createHash('sha256').update(data).digest('hex');

/** Checks a container spec and returns it with defaults filled in. Unknown fields are refused. */
export function validateSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('spec must be an object');
  const fields = new Set(['name', 'image', 'cmd', 'workdir', 'env', 'user']);
  for (const key of Object.keys(input)) if (!fields.has(key)) throw new Error(`spec has an unknown field: ${key}`);
  const { name, image, cmd, workdir, env = {}, user = 'node' } = input;
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('spec.name must be 2-31 lowercase letters, digits or hyphens');
  if (typeof image !== 'string' || !IMAGE_RE.test(image)) throw new Error('spec.image must be pinned by its sha256 digest');
  if (!Array.isArray(cmd) || cmd.length < 1 || cmd.length > 16 || cmd.some(a => typeof a !== 'string' || a.length > 65536))
    throw new Error('spec.cmd must be 1-16 strings');
  if (typeof workdir !== 'string' || !workdir.startsWith('/')) throw new Error('spec.workdir must be an absolute path');
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('spec.env must be an object');
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key) || key.startsWith('SUBHOST_')) throw new Error(`spec.env has a disallowed name: ${key}`);
    if (typeof value !== 'string' || value.length > 4096) throw new Error(`spec.env.${key} must be a short string`);
  }
  if (typeof user !== 'string' || !USER_RE.test(user) || user === 'root') throw new Error('spec.user must name a non-root user');
  return { name, image, cmd: [...cmd], workdir, env: { ...env }, user };
}

/** A container's code hash: SHA-256 of its spec as deterministic JSON. */
export const codeHash = spec => sha256Hex(canonicalJson(validateSpec(spec)));

/** The text whose SHA-512 is the quote's report data. Refuses malformed fields. */
export function bindingPreimage({ appId, name, codeHash: hash, publicKey, nonce }) {
  if (typeof appId !== 'string' || !APP_ID_RE.test(appId)) throw new Error('app id must be 40 lowercase hex characters');
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw new Error('invalid container name');
  if (typeof hash !== 'string' || !HEX64_RE.test(hash)) throw new Error('code hash must be 64 lowercase hex characters');
  if (typeof publicKey !== 'string' || !PUBLIC_KEY_RE.test(publicKey)) throw new Error('public key must be an uncompressed secp256k1 key (0x04 and 128 lowercase hex)');
  if (typeof nonce !== 'string' || !HEX64_RE.test(nonce)) throw new Error('nonce must be 64 lowercase hex characters');
  return canonicalJson({ domain: BINDING_DOMAIN, app_id: appId, name, code_hash: hash, public_key: publicKey, nonce });
}

/** 64 bytes, as 128 hex characters: what goes in the quote's report data. */
export const reportDataFor = preimage => createHash('sha512').update(preimage, 'utf8').digest('hex');

/**
 * Decides one request on Router's filtered socket. Only POST /GetKey for one of
 * Router's two keys passes, and only the path and purpose are forwarded.
 */
export function routerRequestDecision(method, url, bodyText) {
  if (method !== 'POST' || url !== '/GetKey') return { allow: false, reason: `${method} ${url} is not permitted` };
  let body;
  try { body = JSON.parse(bodyText || ''); } catch { return { allow: false, reason: 'body is not JSON' }; }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { allow: false, reason: 'body is not an object' };
  const path = body.path;
  const purpose = body.purpose ?? '';
  if (!ROUTER_KEYS.some(k => k.path === path && k.purpose === purpose)) return { allow: false, reason: 'key path is not permitted' };
  return { allow: true, body: JSON.stringify({ path, purpose }) };
}

/** Docker create-container body for the sub-container. No privileges, no host network. */
export function containerConfig(spec, { hash, runtime, probeDirOnHost }) {
  const env = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  env.push('SUBHOST_DIR=/run/subhost', 'HOME=/tmp');
  return {
    Image: spec.image,
    Cmd: spec.cmd,
    WorkingDir: spec.workdir,
    User: spec.user,
    Env: env,
    Labels: { 'computer.teleport.subhost.name': spec.name, 'computer.teleport.subhost.code-hash': hash },
    HostConfig: {
      Binds: [`${probeDirOnHost}:/run/subhost`],
      NetworkMode: 'bridge',
      Privileged: false,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ReadonlyRootfs: true,
      Tmpfs: { '/tmp': 'rw,noexec,nosuid,size=64m' },
      Memory: 384 * 1024 * 1024,
      MemorySwap: 384 * 1024 * 1024,
      NanoCpus: 500_000_000,
      PidsLimit: 128,
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
      ...(runtime === 'runsc' ? { Runtime: 'runsc' } : {}),
    },
  };
}

/** Allows `limit` calls per `windowMs`. */
export function rateLimiter(limit, windowMs, now = () => Date.now()) {
  let stamps = [];
  return () => {
    const t = now();
    stamps = stamps.filter(s => t - s < windowMs);
    if (stamps.length >= limit) return false;
    stamps.push(t);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Running inside the CVM.

function log(...parts) { console.log(new Date().toISOString(), 'subhost:', ...parts); }

function unixRequest(socketPath, method, path, body, { timeoutMs = 30_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
    const headers = data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) };
    const req = http.request({ socketPath, method, path, headers, timeout: timeoutMs }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { req.destroy(new Error('response too large')); return; }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function listenOnSocket(server, socketPath, mode) {
  rmSync(socketPath, { force: true });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => { chmodSync(socketPath, mode); resolve(); });
  });
}

export async function main(env = process.env) {
  const paths = {
    dstack: env.SUBHOST_DSTACK_SOCKET || '/var/run/dstack.sock',
    docker: env.SUBHOST_DOCKER_SOCKET || '/var/run/docker.sock',
    base: env.SUBHOST_BASE || '/var/run/subhost',
  };
  // What Docker mounts as the sub-container's /run/subhost. In the CVM the host
  // mounts the base directory at the same path, so this is just the probe folder.
  const probeSource = env.SUBHOST_PROBE_SOURCE || `${paths.base}/probe`;
  const port = Number(env.SUBHOST_PORT || 8091);
  const containerName = env.SUBHOST_CONTAINER_NAME || 'subhost-probe';
  const routerSocket = `${paths.base}/router/dstack.sock`;
  const probeDir = `${paths.base}/probe`;
  const hostSocket = `${probeDir}/host.sock`;
  const probeSocket = `${probeDir}/probe.sock`;

  const spec = validateSpec(JSON.parse(Buffer.from(env.SUBHOST_PROBE_SPEC || '', 'base64').toString('utf8')));
  const hash = codeHash(spec);
  log(`container ${spec.name}, code hash ${hash}`);

  const dstack = async (method, payload) => {
    const r = await unixRequest(paths.dstack, 'POST', `/${method}`, payload);
    if (r.status !== 200) throw new Error(`dstack ${method}: HTTP ${r.status}`);
    const value = JSON.parse(r.text);
    if (value && typeof value === 'object' && 'error' in value) throw new Error(`dstack ${method}: ${String(value.error).slice(0, 200)}`);
    return value;
  };
  const docker = (method, path, body, opts) => unixRequest(paths.docker, method, path, body, opts);

  // 1. Router's filtered socket, first, so Router can start even if the sub-container can't.
  mkdirSync(`${paths.base}/router`, { recursive: true });
  const routerServer = http.createServer(async (req, res) => {
    try {
      const decision = routerRequestDecision(req.method, req.url, await readBody(req, 16 * 1024));
      if (!decision.allow) { log('refused a Router request:', decision.reason); sendJson(res, 403, { error: 'not permitted' }); return; }
      const r = await unixRequest(paths.dstack, 'POST', '/GetKey', decision.body);
      // Content-Length, never chunked: the dstack SDK's Unix-socket client reads
      // exactly Content-Length bytes and treats a missing header as an empty body.
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(r.text) });
      res.end(r.text);
    } catch (err) {
      log('Router key request failed:', err.message);
      sendJson(res, 502, { error: 'dstack unavailable' });
    }
  });
  await listenOnSocket(routerServer, routerSocket, 0o666);
  log(`Router key socket ready at ${routerSocket}`);

  // 2. State of the one sub-container.
  const state = { generation: 0, containerId: null, status: 'starting', publicKey: null, startedAt: null, registeredAt: null, lastError: null, runtime: 'runc' };
  let info = null; // dstack Info: app id and the measured app-compose file

  mkdirSync(probeDir, { recursive: true });
  chmodSync(probeDir, 0o777); // only the host and the sub-container mount this directory
  const hostServer = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST' || req.url !== '/register') { sendJson(res, 404, { error: 'not found' }); return; }
      const body = JSON.parse(await readBody(req, 4096));
      if (state.status !== 'running') { sendJson(res, 409, { error: 'no container is running' }); return; }
      if (state.publicKey) { sendJson(res, 409, { error: 'this container already registered a key' }); return; }
      if (typeof body?.public_key !== 'string' || !PUBLIC_KEY_RE.test(body.public_key)) { sendJson(res, 400, { error: 'public_key must be 0x04 followed by 128 lowercase hex characters' }); return; }
      state.publicKey = body.public_key;
      state.registeredAt = new Date().toISOString();
      log(`container generation ${state.generation} registered its key`);
      sendJson(res, 200, { ok: true, generation: state.generation });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
  });
  await listenOnSocket(hostServer, hostSocket, 0o666);

  async function ensureImage(image) {
    if ((await docker('GET', `/images/${image}/json`)).status === 200) return;
    const at = image.lastIndexOf('@');
    const pull = await docker('POST', `/images/create?fromImage=${encodeURIComponent(image.slice(0, at))}&tag=${encodeURIComponent(image.slice(at + 1))}`, undefined, { timeoutMs: 15 * 60_000 });
    if (pull.status !== 200) throw new Error(`image pull failed: HTTP ${pull.status}`);
    for (const line of pull.text.split('\n')) {
      let event = {};
      try { event = JSON.parse(line); } catch { continue; }
      if (event.error || event.errorDetail) throw new Error(`image pull failed: ${String(event.error || event.errorDetail?.message).slice(0, 200)}`);
    }
    if ((await docker('GET', `/images/${image}/json`)).status !== 200) throw new Error('image missing after pull');
  }

  async function startContainer() {
    state.generation += 1;
    Object.assign(state, { status: 'starting', publicKey: null, registeredAt: null, containerId: null });
    const removed = await docker('DELETE', `/containers/${containerName}?force=true`);
    if (removed.status !== 204 && removed.status !== 404) throw new Error(`could not remove the old container: HTTP ${removed.status}`);
    rmSync(probeSocket, { force: true });
    await ensureImage(spec.image);
    const dockerInfo = await docker('GET', '/info');
    state.runtime = dockerInfo.status === 200 && JSON.parse(dockerInfo.text)?.Runtimes?.runsc ? 'runsc' : 'runc';
    const create = await docker('POST', `/containers/create?name=${containerName}`,
      containerConfig(spec, { hash, runtime: state.runtime, probeDirOnHost: probeSource }));
    if (create.status !== 201) throw new Error(`container create failed: HTTP ${create.status} ${create.text.slice(0, 200)}`);
    const { Id } = JSON.parse(create.text);
    // Running before the start call, so a fast container can register at once. If
    // the start fails, the supervisor finds the container stopped and tries again.
    Object.assign(state, { containerId: Id, status: 'running', startedAt: new Date().toISOString(), lastError: null });
    const start = await docker('POST', `/containers/${Id}/start`);
    if (start.status !== 204 && start.status !== 304) throw new Error(`container start failed: HTTP ${start.status} ${start.text.slice(0, 200)}`);
    log(`started container generation ${state.generation} (${state.runtime})`);
  }

  let nextStart = 0;
  async function supervise() {
    try {
      if (!info) {
        const i = await dstack('Info', {});
        const tcb = typeof i.tcb_info === 'string' ? JSON.parse(i.tcb_info) : i.tcb_info;
        info = { appId: String(i.app_id || '').replace(/^0x/, '').toLowerCase(), appCompose: tcb?.app_compose ?? null };
        log(`app id ${info.appId}`);
      }
      if (state.containerId) {
        const r = await docker('GET', `/containers/${state.containerId}/json`);
        const running = r.status === 200 && JSON.parse(r.text)?.State?.Running === true;
        if (running) return;
        log(`container generation ${state.generation} stopped`);
        Object.assign(state, { status: 'stopped', containerId: null, publicKey: null });
      }
      if (Date.now() < nextStart) return;
      nextStart = Date.now() + 60_000;
      await startContainer();
    } catch (err) {
      state.lastError = String(err.message).slice(0, 300);
      if (state.status === 'starting') state.status = 'failed';
      log('supervisor:', state.lastError);
    }
  }
  // 3. The public endpoint: status, binding quotes and a way to hand the container a grant.
  const quoteLimit = rateLimiter(10, 60_000);
  const useLimit = rateLimiter(10, 60_000);
  const publicServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://subhost.invalid');
      if (req.method === 'GET' && url.pathname === '/health') { sendJson(res, 200, { ok: true }); return; }
      if (req.method === 'GET' && url.pathname === '/') {
        sendJson(res, 200, {
          name: spec.name, code_hash: hash, app_id: info?.appId ?? null, runtime: state.runtime,
          container: { status: state.status, generation: state.generation, started_at: state.startedAt, key_registered: !!state.publicKey, last_error: state.lastError },
        });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bundle') {
        const nonce = url.searchParams.get('nonce') || '';
        if (!HEX64_RE.test(nonce)) { sendJson(res, 400, { error: 'nonce must be 64 lowercase hex characters' }); return; }
        if (!info?.appId || !info.appCompose) { sendJson(res, 503, { error: 'dstack info not available yet' }); return; }
        if (!state.publicKey) { sendJson(res, 409, { error: 'the container has not registered a key yet' }); return; }
        if (!quoteLimit()) { sendJson(res, 429, { error: 'too many requests' }); return; }
        const publicKey = state.publicKey;
        const generation = state.generation;
        const preimage = bindingPreimage({ appId: info.appId, name: spec.name, codeHash: hash, publicKey, nonce });
        const reportData = reportDataFor(preimage);
        const quote = await dstack('GetQuote', { report_data: reportData });
        if (state.generation !== generation || state.publicKey !== publicKey) { sendJson(res, 409, { error: 'the container restarted; ask again' }); return; }
        sendJson(res, 200, {
          version: 1,
          preimage,
          report_data: reportData,
          quote: String(quote.quote).replace(/^0x/, ''),
          event_log: typeof quote.event_log === 'string' ? JSON.parse(quote.event_log) : quote.event_log,
          app_compose: info.appCompose,
          spec,
          code_hash: hash,
          runtime: state.runtime,
          container: { public_key: publicKey, generation, started_at: state.startedAt, registered_at: state.registeredAt },
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/use') {
        if (!useLimit()) { sendJson(res, 429, { error: 'too many requests' }); return; }
        const body = await readBody(req, 64 * 1024);
        if (!state.publicKey) { sendJson(res, 409, { error: 'the container has not registered a key yet' }); return; }
        const r = await unixRequest(probeSocket, 'POST', '/use', body, { timeoutMs: 90_000, maxBytes: 64 * 1024 });
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(r.text), 'Cache-Control': 'no-store' });
        res.end(r.text);
        return;
      }
      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      log('request failed:', err.message);
      sendJson(res, 500, { error: 'request failed' });
    }
  });
  await new Promise(resolve => publicServer.listen(port, '0.0.0.0', resolve));
  log(`listening on port ${port}`);

  // The health check (and so Router's start) waits only for the key socket above.
  // The sub-container starts in the background; pulling its image can take minutes.
  let supervising = false;
  const tick = () => { if (supervising) return; supervising = true; supervise().finally(() => { supervising = false; }); };
  tick();
  const timer = setInterval(tick, 15_000);

  const close = async () => {
    clearInterval(timer);
    log('stopping; removing the sub-container');
    await docker('DELETE', `/containers/${containerName}?force=true`, undefined, { timeoutMs: 10_000 }).catch(() => {});
    await Promise.all([publicServer, hostServer, routerServer].map(s => new Promise(resolve => { s.closeAllConnections?.(); s.close(() => resolve()); })));
  };
  return { close, port: publicServer.address().port, state };
}

if (process.env.SUBHOST_MAIN === '1') {
  main().then(({ close }) => {
    const stop = () => close().finally(() => process.exit(0));
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }, err => { log('fatal:', err.stack || err.message); process.exit(1); });
}
