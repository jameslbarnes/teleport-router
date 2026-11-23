// The trace runner (docs/attested-trace-apps.md). It runs on a pinned Router image only to reuse
// Router's TinyCloud client and trace envelope code; none of Router itself runs here.
//
// It holds each run's key in memory, reads the trace with the owner's grant, and has each app run
// in a fresh sandbox container with no network, which it asks the sub-container host to start and
// remove. It answers the host on a socket only the two of them can reach, and never logs a trace,
// an app's code, an answer, a prompt, a model's reply or a requester's key.
//
// An app that declared a model has its prompts sent to an attested provider with the requester's own
// key (docs/trace-app-model-calls.md). REDPILL_RELEASES lists the RedPill gateway releases this runner
// accepts (comma-separated sha256 hashes); without it, runs that declare RedPill are refused at prepare.
// Tinfoil's client checks its release against Tinfoil's own public log.
import { createServer } from 'node:http';
import { chmodSync, rmSync } from 'node:fs';
import { runnerService, sandboxExecutor, tinyCloudTraceSource, traceRunner, unixPost } from '/app/server/dist/trace-run.js';

const dir = process.env.SUBHOST_DIR || '/run/subhost';
const sandboxes = process.env.SUBHOST_SANDBOXES || '/run/sandboxes';
const askHost = async (method, id) => {
  const r = await unixPost(`${dir}/host.sock`, `/sandbox/${id}`, undefined, { method, timeoutMs: 60_000 });
  if (r.status !== 200) throw new Error('the host did not start the sandbox');
};
const redpillReleases = (process.env.REDPILL_RELEASES || '').split(',').map(s => s.trim()).filter(Boolean);
// An image built before model calls has no providers module; its runner refuses every run that declares a model.
const providers = await import('/app/server/dist/trace-model-providers.js').catch(() => null);
/** A provider this runner cannot reach (RedPill with no accepted releases) has no connector, so its runs are refused before any grant. */
const connectorFor = provider => { try { return providers?.attestedConnector(provider, { redpillReleases }) ?? null; } catch { return null; } };
const service = runnerService(traceRunner({
  fetchTrace: tinyCloudTraceSource(),
  execute: sandboxExecutor({ askHost, socketFor: id => `${sandboxes}/${id}/sandbox.sock` }),
  connectorFor,
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
