// node --test insights-enclave/gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { checkModelRequest, createGate, UPSTREAM } from './gate.mjs';
import { COMPOSE, embeddedGate, gateBlock, withBlock } from './embed.mjs';

const MODEL = 'model-under-test';
const good = { model: MODEL, max_tokens: 4200, system: 'You check one log.', messages: [{ role: 'user', content: 'Proposed rule…' }] };
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('only one kind of request may leave: one system text and one user text for the named model', () => {
  assert.deepEqual(JSON.parse(checkModelRequest(JSON.stringify(good), MODEL)), good);
  const bad = [
    { ...good, model: 'another-model' },
    { ...good, tools: [{ name: 'web_fetch' }] },
    { ...good, metadata: { user_id: 'smuggled' } },
    { ...good, stream: true },
    { ...good, max_tokens: 100000 },
    { ...good, system: [{ type: 'text', text: 'x' }] },
    { ...good, messages: [...good.messages, { role: 'assistant', content: 'x' }] },
    { ...good, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://elsewhere.example' } }] }] },
    { ...good, messages: [{ role: 'user', content: 'x', name: 'y' }] },
    { model: MODEL, max_tokens: 10, messages: good.messages },
  ];
  for (const body of bad) assert.throws(() => checkModelRequest(JSON.stringify(body), MODEL), JSON.stringify(body).slice(0, 80));
  assert.throws(() => checkModelRequest('not json', MODEL));
});

test('the gate passes that request to one address with the key, and refuses every other path, method and body', async () => {
  const sent = [];
  const gate = createGate({ model: MODEL, apiKey: 'key-for-test', appUrl: 'http://app:3100',
    send: async (url, init) => { sent.push({ url, init }); return new Response(JSON.stringify({ content: [{ type: 'text', text: '{}' }] }), { status: 200 }); } });
  const port = await listen(gate.outbound);
  const out = `http://127.0.0.1:${port}`;
  try {
    const ok = await fetch(`${out}/v1/messages`, { method: 'POST', body: JSON.stringify(good), headers: { 'x-api-key': 'from-the-program', 'anthropic-beta': 'files-api' } });
    assert.equal(ok.status, 200);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, UPSTREAM);
    assert.equal(UPSTREAM, 'https://api.anthropic.com/v1/messages');
    // Only the gate's own headers go out: its key, never one the program supplied, and no feature switches.
    assert.deepEqual(sent[0].init.headers, { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': 'key-for-test' });
    assert.equal(sent[0].init.redirect, 'error');
    assert.deepEqual(JSON.parse(sent[0].init.body), good);

    for (const [method, path, body] of [
      ['POST', '/v1/files', JSON.stringify(good)], ['POST', '/v1/messages/batches', JSON.stringify(good)], ['POST', '/v1/messages?beta=true', JSON.stringify(good)],
      ['GET', '/v1/messages', undefined], ['POST', '/', JSON.stringify(good)], ['POST', '//evil.example/v1/messages', JSON.stringify(good)],
      ['POST', '/v1/messages', JSON.stringify({ ...good, tools: [] })], ['POST', '/v1/messages', 'x'.repeat(9 * 1024 * 1024)],
    ]) {
      const res = await fetch(out + path, { method, body }).catch(() => ({ status: 413 }));   // an oversized upload may be cut off mid-send
      assert.ok([403, 413].includes(res.status), `${method} ${path} → ${res.status}`);
    }
    assert.equal(sent.length, 1, 'nothing else went out');
  } finally { gate.outbound.close(); }
});

test('the gate passes the enclave\'s five requests in, and nothing else', async () => {
  const seen = [];
  const app = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => { seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body }); res.writeHead(req.url === '/runs/missing' ? 404 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ path: req.url })); });
  });
  const appPort = await listen(app);
  const gate = createGate({ model: MODEL, apiKey: 'k', appUrl: `http://localhost:${appPort}` });
  const port = await listen(gate.inbound);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/info`)).json(), { path: '/info' });
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/runs/missing`)).status, 404);
    const run = await fetch(`${base}/run`, { method: 'POST', headers: { Authorization: 'Bearer link-secret' }, body: '{"run":"r1"}' });
    assert.equal(run.status, 200);
    assert.deepEqual(seen.at(-1), { method: 'POST', url: '/run', auth: 'Bearer link-secret', body: '{"run":"r1"}' });
    assert.equal((await fetch(`${base}/decide`, { method: 'POST', body: '{}' })).status, 200);
    const before = seen.length;
    for (const [method, path] of [['GET', '/'], ['GET', '/run'], ['POST', '/info'], ['GET', '/v1/messages'], ['POST', '/debug'], ['DELETE', '/runs/r1']])
      assert.equal((await fetch(base + path, { method, body: method === 'GET' ? undefined : '{}' })).status, 404, `${method} ${path}`);
    assert.equal(seen.length, before);
  } finally { gate.inbound.close(); app.close(); }
});

test('the compose file carries this exact gate, and keeps the program off the internet', () => {
  const compose = readFileSync(new URL(`../${COMPOSE}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(withBlock(compose, gateBlock()), compose, 'run node insights-enclave/embed.mjs');
  assert.equal(embeddedGate(compose), readFileSync(new URL('./gate.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n'));
  const program = compose.slice(compose.indexOf('  insights-enclave:'), compose.indexOf('  # BEGIN gate'));
  assert.match(program, /networks:\n      - sealed\n/);
  assert.doesNotMatch(program, /- default|ports:|ANTHROPIC_API_KEY|network_mode|extra_hosts/);
  assert.match(program, /INSIGHTS_MODEL_URL=http:\/\/gate:8089/);
  assert.match(compose, /networks:\n(?:  #.*\n)*  sealed:\n    internal: true\n/);
  // The two places the model is named agree.
  assert.equal(compose.match(/INSIGHTS_MODEL=([\w.-]+)/g).length, 2);
  assert.equal(new Set(compose.match(/INSIGHTS_MODEL=([\w.-]+)/g)).size, 1);
});
