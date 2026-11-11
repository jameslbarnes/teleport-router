// The sub-container. It runs on a pinned Router image only to reuse Router's
// TinyCloud client code; none of Router itself runs here.
//
// On start it makes a key that exists only in this process, tells the host its
// public key, and waits. When it is handed a TinyCloud grant addressed to that
// key, it reads one file with it and answers with the file's size and SHA-256,
// never the contents.
import { createServer, request } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { tinyCloudGroups } from '/app/server/dist/tinycloud-group-store.js';

const dir = process.env.SUBHOST_DIR || '/run/subhost';
const wallet = Wallet.createRandom();
const did = `did:pkh:eip155:1:${wallet.address}`;
const tinycloud = tinyCloudGroups({ privateKey: wallet.privateKey, host: process.env.TINYCLOUD_HOST });

function post(socketPath, path, value) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(value);
    const req = request({ socketPath, method: 'POST', path, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 10_000 }, res => {
      let text = '';
      res.on('data', c => { text += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(JSON.parse(text)) : reject(new Error(`HTTP ${res.statusCode} ${text.slice(0, 200)}`))));
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

const reply = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/use') { reply(res, 404, { error: 'not found' }); return; }
  let text = '';
  req.on('data', c => { text += c; if (text.length > 64 * 1024) req.destroy(); });
  req.on('end', async () => {
    try {
      const { delegation, path } = JSON.parse(text);
      if (typeof delegation !== 'string' || !delegation) throw new Error('delegation must be a serialized TinyCloud grant');
      if (typeof path !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(path)) throw new Error('path must be one file name');
      const store = await tinycloud.accessFor(delegation);
      const value = await store.get(path);
      if (value === null) { reply(res, 200, { ok: false, did, error: 'not found' }); return; }
      reply(res, 200, { ok: true, did, path, bytes: Buffer.byteLength(value), sha256: createHash('sha256').update(value).digest('hex') });
    } catch (err) {
      const message = String(err?.message || err);
      // Router's client words a withdrawn grant for groups; say it plainly here.
      const withdrawn = /revoked|expired/i.test(message);
      reply(res, 200, { ok: false, did, error: withdrawn ? 'the grant was revoked or has expired' : message.slice(0, 300) });
    }
  });
});

const socket = `${dir}/probe.sock`;
rmSync(socket, { force: true });
server.listen(socket, async () => {
  chmodSync(socket, 0o600);
  // Retry briefly; if the host still can't take the key, exit so it starts a fresh container (and key).
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await post(`${dir}/host.sock`, '/register', { public_key: wallet.signingKey.publicKey });
      console.log(`probe: registered ${did}`);
      return;
    } catch (err) {
      if (/HTTP 409 .*already registered/.test(err.message)) { console.error('probe: the host already holds a key for this container'); break; }
      if (attempt === 10) console.error(`probe: could not register: ${err.message}`);
      else await new Promise(r => setTimeout(r, 1000));
    }
  }
  process.exit(1);
});
