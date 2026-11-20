import { afterAll, beforeAll, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { tinyCloudIdentity } from './tinycloud-identity.js';
import { derivePseudonym, generateSecretKey } from './identity.js';

const ownerKey = generateSecretKey();
let generation = 1;
const dstack = createServer(async (req, res) => {
  let body = '';
  for await (const part of req) body += part;
  const { path, purpose } = JSON.parse(body);
  const identity = path === 'teleport-router/tinycloud/v1' && purpose === 'secp256k1';
  const encryption = path === 'teleport-router/record-encryption/v1' && purpose === '';
  if (req.url !== '/GetKey' || (!identity && !encryption)) { res.writeHead(404).end(); return; }
  res.end(JSON.stringify({ key: Buffer.alloc(32, generation + (identity ? 0 : 32)).toString('hex'), signature_chain: [] }));
});

let dir: string, base: string, pin: string, queue: string, pending: string, originalDid: string;
let child: ChildProcess | undefined;
let env: NodeJS.ProcessEnv;
let client: Client | undefined;
async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return (server.address() as AddressInfo).port;
}
async function start(expectedStatus: number) {
  child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let errors = '';
  child.stderr!.on('data', data => { errors = (errors + String(data)).slice(-1200); });
  child.stdout!.resume();
  for (let i = 0; child.exitCode === null && i < 240; i++) {
    try {
      if ((await fetch(base + '/health')).status === expectedStatus) return;
    } catch { /* listener not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Router did not return HTTP ${expectedStatus}: ${errors}`);
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  child = undefined;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'router-keys-'));
  pin = join(dir, 'identity');
  queue = join(dir, 'waiting.json');
  const sdkPort = await listen(dstack);
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise<void>(resolve => portProbe.close(() => resolve()));
  base = 'http://127.0.0.1:' + port;
  env = { NODE_ENV: 'production', TINYCLOUD_AUTHORS: 'tinycloud', TINYCLOUD_KEY_SOURCE: 'dstack',
    DSTACK_ENDPOINT: 'http://127.0.0.1:' + sdkPort, TINYCLOUD_IDENTITY_PIN: pin,
    RECOVERY_FILE: queue, TRACE_STORAGE: 'off', PORT: String(port), LISTEN_HOST: '127.0.0.1', BASE_URL: base };
  for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE'])
    if (process.env[key]) env[key] = process.env[key];
  originalDid = (await tinyCloudIdentity(env)).did;
  pending = JSON.stringify({ entries: [{ id: 'waiting-example', pseudonym: derivePseudonym(ownerKey),
    content: 'synthetic waiting note', timestamp: Date.now(), publishAt: Date.now() + 3600000 }], conversations: [] });
  await writeFile(queue, pending);
});
afterAll(async () => {
  await client?.close();
  await stop();
  await new Promise<void>(resolve => dstack.close(() => resolve()));
  if (dir) await rm(dir, { recursive: true, force: true });
});

it('serves notebook reads on a real SDK rotation and resumes the original identity and waiting queue when its keys return', async () => {
  const originalPins = await Promise.all([pin, pin + '.encryption-v1'].map(p => readFile(p, 'utf8')));
  generation = 2;
  await start(503);
  const health = await fetch(base + '/health');
  expect(await health.json()).toMatchObject({ status: 'degraded', mode: 'read-only', reason: 'storage_key_mismatch' });
  for (const path of ['/api/entries', '/api/search?q=sample', '/e/waiting-example']) {
    const response = await fetch(base + path);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-router-mode')).toBe('read-only');
    if (path.startsWith('/e/')) expect(await response.text()).toContain('Router is read-only');
  }
  expect((await fetch(base + '/api/entry/waiting-example', { headers: { Authorization: 'Bearer ' + ownerKey } })).status).toBe(404);
  for (const [method, path] of [['GET', '/api/tinycloud/router'], ['GET', '/unsubscribe'],
    ['POST', '/api/entries'], ['POST', '/api/tinycloud/link'], ['POST', '/api/posting-rules'], ['DELETE', '/api/entries/id']]) {
    expect((await fetch(base + path, { method })).status).toBe(503);
  }
  client = new Client({ name: 'key-recovery-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/http'), { requestInit: { headers: { Authorization: 'Bearer ' + ownerKey } } }));
  expect((await client.listTools()).tools.map(t => t.name).sort()).toEqual(['router_get_entry', 'router_posting_rules', 'router_search']);
  expect((await client.callTool({ name: 'router_search', arguments: { query: 'sample' } })).isError).toBeFalsy();
  expect((await client.callTool({ name: 'router_posting_rules', arguments: { action: 'get' } })).isError).toBeFalsy();
  for (const [name, args] of [['router_write_entry', { content: 'held' }], ['router_posting_rules', { action: 'save' }]] as const)
    expect((await client.callTool({ name, arguments: args })).isError).toBe(true);
  await client.close(); client = undefined;
  await stop();
  expect(await readFile(queue, 'utf8')).toBe(pending);
  expect(await Promise.all([pin, pin + '.encryption-v1'].map(p => readFile(p, 'utf8')))).toEqual(originalPins);
  generation = 1;
  await start(200);
  expect(await (await fetch(base + '/api/tinycloud/router')).json()).toMatchObject({ did: originalDid, keySource: 'dstack' });
  const own = await fetch(base + '/api/entry/waiting-example', { headers: { Authorization: 'Bearer ' + ownerKey } });
  expect(await own.json()).toMatchObject({ id: 'waiting-example', content: 'synthetic waiting note' });
}, 60000);
