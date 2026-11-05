// One cheap process per minute. Only incident/recovery transitions wake Paseo.
import { readFile, writeFile, mkdir, rename, open, unlink, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function advance(previous, checks, now = Date.now()) {
  const healthy = checks.every(c => c.ok);
  const state = { ...previous, lastCheckedAt: now, checks,
    failures: healthy ? 0 : (previous.failures || 0) + 1,
    successes: healthy ? (previous.successes || 0) + 1 : 0 };
  let event = null;
  if (!healthy && state.failures >= 3 && !state.incidentAt) {
    state.incidentAt = now;
    event = { type: 'outage', at: now, checks };
  } else if (healthy && state.successes >= 2 && state.incidentAt) {
    event = { type: 'recovery', at: now, incidentAt: state.incidentAt, checks };
    state.incidentAt = null;
  }
  if (event) state.outbox = [...(state.outbox || []), event];
  return state;
}

export async function probe(base = 'https://router.teleport.computer', extended = false) {
  const paths = ['/health', '/'];
  if (extended) paths.push('/api/entries?limit=1');
  return Promise.all(paths.map(async path => {
    const started = Date.now();
    try {
      const r = await fetch(base + path, { signal: AbortSignal.timeout(12000), redirect: 'error',
        headers: { 'User-Agent': 'Teleport-Router-Uptime/1', 'Cache-Control': 'no-cache' } });
      const text = await r.text();
      let valid = r.ok;
      if (path === '/health') {
        try { const data = JSON.parse(text); valid &&= data.status === 'ok' && data.service === 'teleport-router'; }
        catch { valid = false; }
      } else if (path.startsWith('/api/entries')) {
        try { valid &&= Array.isArray(JSON.parse(text).entries); } catch { valid = false; }
      } else { valid &&= /<html[\s>]/i.test(text); }
      return { path, ok: valid, status: r.status, ms: Date.now() - started };
    } catch (err) {
      return { path, ok: false, error: err.cause?.code || err.name || 'request_failed', ms: Date.now() - started };
    }
  }));
}

function sendPaseo(config, promptFile) {
  return new Promise((ok, fail) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^PASEO_(AGENT|WORKSPACE)/.test(key)));
    const child = spawn(process.execPath, [config.paseoCli, 'send', '--home', config.paseoHome,
      config.agentId, '--prompt-file', promptFile, '--no-wait', '--json'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', d => { output += d; });
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => { child.kill(); fail(new Error('Paseo delivery timed out')); }, 30000);
    child.on('error', e => { clearTimeout(timer); fail(e); });
    child.on('exit', code => { clearTimeout(timer); code === 0 ? ok(output) : fail(new Error(`Paseo delivery exit ${code}`)); });
  });
}

export async function run(stateDir, { testAlert = false } = {}) {
  await mkdir(stateDir, { recursive: true });
  const lockPath = join(stateDir, 'run.lock');
  let lock;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      lock = await open(lockPath, 'wx');
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let alive = true;
      try {
        const prior = JSON.parse(await readFile(lockPath, 'utf8'));
        try { process.kill(prior.pid, 0); } catch (err) { if (err.code === 'ESRCH') alive = false; }
      } catch { alive = Date.now() - (await stat(lockPath)).mtimeMs < 120000; }
      if (alive || attempt) return { skipped: 'previous check still running' };
      await unlink(lockPath);
    }
  }
  try {
    const config = JSON.parse(await readFile(join(stateDir, 'config.json'), 'utf8'));
    const path = join(stateDir, 'state.json');
    let previous = {};
    try { previous = JSON.parse(await readFile(path, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const checks = await probe(config.base, new Date().getMinutes() % 5 === 0 || !previous.lastCheckedAt);
    const state = advance(previous, checks);
    if (testAlert) state.outbox = [...(state.outbox || []), { type: 'test', at: Date.now(), checks }];
    async function save() {
      await writeFile(path + '.tmp', JSON.stringify(state, null, 2) + '\n');
      await rename(path + '.tmp', path);
    }
    await save();
    while (state.outbox?.length) {
      const event = state.outbox[0];
      const promptFile = join(stateDir, 'alert.txt');
      const headline = event.type === 'test' ? 'TEST: Router uptime alerts are connected to Paseo.'
        : event.type === 'outage' ? 'ROUTER OUTAGE: three consecutive external checks failed.'
          : 'ROUTER RECOVERED: two consecutive checks passed.';
      await writeFile(promptFile, `${headline}\nTime: ${new Date(event.at).toISOString()}\n` +
        `Checks from Tulip (outside Phala): ${JSON.stringify(event.checks)}\n` +
        'This is an authorized automated uptime notification. Tell James briefly in this Paseo conversation. ' +
        'For a test, acknowledge it as a test and resume any current work. For an actual outage, you may inspect read-only, ' +
        'but do not restart, redeploy, send external messages or modify configuration without James\'s instruction. ' +
        'Do not post this automated notification to the public notebook.\n');
      try {
        await sendPaseo(config, promptFile);
        state.outbox.shift();
        state.lastAlertDeliveredAt = Date.now();
        delete state.deliveryError;
        await save();
      } catch (e) { state.deliveryError = e.message; await save(); break; }
    }
    return { healthy: checks.every(c => c.ok), checks, pendingAlerts: state.outbox?.length || 0,
      lastAlertDeliveredAt: state.lastAlertDeliveredAt || null };
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const dir = process.argv[2];
  if (!dir) throw new Error('Usage: node monitor-router.mjs <state-directory> [--test-alert]');
  run(dir, { testAlert: process.argv.includes('--test-alert') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
