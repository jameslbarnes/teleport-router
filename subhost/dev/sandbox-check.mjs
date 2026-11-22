// Runs trace apps in the pinned sandbox image exactly as the sub-container host starts it in
// production: the same create-container body (sandboxConfig in host.mjs) and the embedded
// sandbox.mjs, against the real Docker daemon, one container per app. Linux with Docker only
// (CI's subhost end-to-end job runs it):  node subhost/dev/sandbox-check.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codeHash, sandboxConfig } from '../host.mjs';
import { sandboxSpec } from '../embed.mjs';

const call = (socketPath, method, path, body, timeoutMs = 120_000) => new Promise((resolve, reject) => {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ socketPath, method, path, timeout: timeoutMs,
    headers: data === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } }, res => {
    let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, text }));
  });
  req.on('timeout', () => req.destroy(new Error('timed out'))); req.on('error', reject); req.end(data);
});
const docker = (method, path, body, timeoutMs) => call('/var/run/docker.sock', method, path, body, timeoutMs);

const spec = sandboxSpec();
if (!spec) { console.log('No pinned sandbox image in this checkout; nothing to check.'); process.exit(0); }
const at = spec.image.lastIndexOf('@');
const pulled = await docker('POST', `/images/create?fromImage=${encodeURIComponent(spec.image.slice(0, at))}&tag=${encodeURIComponent(spec.image.slice(at + 1))}`, undefined, 15 * 60_000);
assert.equal(pulled.status, 200, `pull ${spec.image}`);

async function runApp(name, code, trace) {
  const dir = mkdtempSync(join(tmpdir(), 'sandbox-check-'));
  chmodSync(dir, 0o777);
  const container = `sandbox-check-${randomBytes(4).toString('hex')}`;
  try {
    const created = await docker('POST', `/containers/create?name=${container}`, sandboxConfig(spec, { hash: codeHash(spec), runtime: 'runc', dirOnHost: dir }));
    assert.equal(created.status, 201, `create: ${created.text.slice(0, 200)}`);
    assert.ok([204, 304].includes((await docker('POST', `/containers/${container}/start`)).status), 'start');
    const socket = join(dir, 'sandbox.sock');
    for (let i = 0; i < 300 && !existsSync(socket); i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(existsSync(socket), `${name}: the sandbox opened its socket`);
    const reply = await call(socket, 'POST', '/job', { app: { code }, trace, info: { entry_id: 'check', bytes: Buffer.byteLength(trace) }, limits: { answerBytes: 8192 } }, 60_000);
    const result = JSON.parse(reply.text);
    console.log(`${name}: ${JSON.stringify(result)}`);
    return result;
  } finally {
    await docker('DELETE', `/containers/${container}?force=true`).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const trace = JSON.stringify({ v: 1, kind: 'router-post-trace', records: [{ type: 'user', message: { role: 'user', content: 'the polling loop runs every second' } }] });
assert.deepEqual(await runApp('an ordinary app',
  "function analyze(trace) { const t = JSON.parse(trace); return 'records: ' + t.records.length + '; mentions polling: ' + trace.includes('polling') }", trace),
  { ok: true, answer: 'records: 1; mentions polling: true' });
assert.match((await runApp('an endless loop', 'function analyze() { for (;;) {} }', trace)).error, /ran out of time/);
assert.deepEqual(await runApp('an app reaching for the network', 'function analyze() { return typeof fetch + " " + typeof require + " " + typeof process }', trace),
  { ok: true, answer: 'undefined undefined undefined' });
console.log('PASS the pinned sandbox image runs apps with the production container settings, stops an endless loop and offers no network');
