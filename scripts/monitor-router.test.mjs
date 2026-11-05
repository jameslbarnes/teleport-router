import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advance, probe } from './monitor-router.mjs';
import { createServer } from 'node:http';

test('isolated failure stays quiet, sustained outage alerts once, recovery waits for two successes', () => {
  const good = [{ ok: true }], bad = [{ ok: false }];
  let s = advance({}, bad, 1);
  assert.equal(s.outbox, undefined);
  s = advance(s, good, 2);
  s = advance(s, bad, 3);
  s = advance(s, bad, 4);
  assert.equal(s.outbox, undefined);
  s = advance(s, bad, 5);
  s = advance(s, bad, 6);
  assert.deepEqual(s.outbox.map(e => e.type), ['outage']);
  s = advance(s, good, 7);
  assert.equal(s.outbox.length, 1);
  s = advance(s, good, 8);
  assert.deepEqual(s.outbox.map(e => e.type), ['outage', 'recovery']);
  assert.equal(s.incidentAt, null);
});

test('HTTP 200 alone is insufficient: health identity, HTML and feed shape must match', async () => {
  let broken = true;
  const server = createServer((req, res) => {
    res.end(broken ? 'upstream maintenance' : req.url === '/health'
      ? '{"status":"ok","service":"teleport-router"}' : req.url.startsWith('/api/entries')
        ? '{"entries":[]}' : '<html><body>Router</body></html>');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.ok((await probe(url, true)).every(c => !c.ok));
    broken = false;
    assert.ok((await probe(url, true)).every(c => c.ok));
  } finally { await new Promise(r => server.close(r)); }
});
