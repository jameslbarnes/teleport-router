// One app run (docs/attested-trace-apps.md). This container has no network, no keys and no socket
// but its own. It takes one job, runs the app in QuickJS inside a worker that it kills if the app
// overruns, answers, and exits; the host then removes the container. It never logs the trace, the
// code or the answer, and its logs are not kept.
import { createServer } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { sandboxJobHandler, workerExecutor } from '/app/server/dist/trace-run.js';

const handle = sandboxJobHandler(workerExecutor('file:///app/server/dist/trace-app.js'));
const socket = `${process.env.SUBHOST_DIR || '/run/sandbox'}/sandbox.sock`;
let taken = false;

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/job' || taken) { res.writeHead(409); res.end('{}'); return; }
  taken = true;
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 40 * 1024 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    let result;
    try { result = await handle(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
    catch { result = { ok: false, error: 'The sandbox was given a malformed job.' }; }
    const text = JSON.stringify(result);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text, () => setTimeout(() => process.exit(0), 50));
  });
});

rmSync(socket, { force: true });
server.listen(socket, () => chmodSync(socket, 0o666));
