// The trace runner (docs/attested-trace-apps.md). It runs on a pinned Router image only to reuse
// Router's TinyCloud client and trace envelope code; none of Router itself runs here.
//
// It holds each run's key in memory, reads the trace with the owner's grant, and has each app run
// in a fresh sandbox container with no network, which it asks the sub-container host to start and
// remove. It answers the host on a socket only the two of them can reach, and never logs a trace,
// an app's code or an answer.
import { createServer } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { runnerService, sandboxExecutor, tinyCloudTraceSource, traceRunner, unixPost } from '/app/server/dist/trace-run.js';

const dir = process.env.SUBHOST_DIR || '/run/subhost';
const sandboxes = process.env.SUBHOST_SANDBOXES || '/run/sandboxes';
const askHost = async (method, id) => {
  const r = await unixPost(`${dir}/host.sock`, `/sandbox/${id}`, undefined, { method, timeoutMs: 60_000 });
  if (r.status !== 200) throw new Error('the host did not start the sandbox');
};
const service = runnerService(traceRunner({
  fetchTrace: tinyCloudTraceSource(),
  execute: sandboxExecutor({ askHost, socketFor: id => `${sandboxes}/${id}/sandbox.sock` }),
}));

const server = createServer((req, res) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => { size += c.length; if (size > 256 * 1024) req.destroy(); else chunks.push(c); });
  req.on('end', async () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* answered below as not found or malformed */ }
    const { status, value } = req.method === 'POST' ? await service(req.url, body) : { status: 405, value: { error: 'method not allowed' } };
    const text = JSON.stringify(value);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  });
});

const socket = `${dir}/runner.sock`;
rmSync(socket, { force: true });
server.listen(socket, () => { chmodSync(socket, 0o600); console.log('trace runner ready'); });
