// One app run (docs/attested-trace-apps.md). This container has no network, no keys and no socket
// but its own. It takes one job, runs the app in QuickJS, answers, and exits; the host then removes
// the container. It never logs the trace, the code or the answer, and its logs are not kept.
//
// For an app that asks a model, each step of the run is one job in a fresh container: the app's
// function runs from the start with the model's replies so far, and answers or returns one prompt.
//
// The app runs on this process's own thread, not in a worker: the container is single-use, and an
// app the engine's own time and memory limits miss is stopped by the runner's deadline, after which
// the host removes the container. If the engine itself fails, the sealed error, which only the owner
// reads, says how much memory the container and the machine had, so the cause can be told apart.
import { createServer } from 'node:http';
import { chmodSync, readFileSync, rmSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import * as apps from '/app/server/dist/trace-app.js';
import { sandboxJobHandler } from '/app/server/dist/trace-run.js';

const mb = bytes => `${Math.round(Number(bytes) / 1048576)} MB`;
function memory() {
  const read = path => { try { return readFileSync(path, 'utf8').trim(); } catch { return null; } };
  const used = read('/sys/fs/cgroup/memory.current') ?? read('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  const max = read('/sys/fs/cgroup/memory.max') ?? read('/sys/fs/cgroup/memory/memory.limit_in_bytes');
  const events = (read('/sys/fs/cgroup/memory.events') || '').replace(/\s+/g, ' ');
  const container = used ? `container ${mb(used)} of ${max && max !== 'max' ? mb(max) : 'no limit'}${events ? ` (${events})` : ''}` : 'container memory unknown';
  return `${container}; machine ${mb(freemem())} free of ${mb(totalmem())}; this process ${mb(process.memoryUsage().rss)}`;
}

// An image built before model calls has only runApp, which takes no replies.
const runStep = apps.runAppStep ?? ((app, trace, info, limits) => apps.runApp(app, trace, info, limits));
const handle = sandboxJobHandler(async (app, trace, info, limits, replies) => {
  try {
    const result = await runStep(app, trace, info, limits, replies);
    return result.ok !== false || !/stopped the sandbox/.test(result.error) ? result : { ok: false, error: `${result.error} [${memory()}]` };
  } catch (err) {
    return { ok: false, error: `The sandbox could not start its engine: ${String(err?.message || err).slice(0, 200)} [${memory()}]` };
  }
});
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
