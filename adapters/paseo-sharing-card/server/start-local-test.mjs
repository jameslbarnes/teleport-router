// Starts only a disposable, loopback-only Router. Never use a production key here.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, open, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateDirectory } from './private-files.mjs';

const agentId = process.argv[2];
if (!agentId || !/^[a-f0-9-]{36}$/.test(agentId)) throw new Error('Pass the test conversation UUID');
const directory = join(homedir(), '.paseo', 'router-card-test');
const sessions = join(homedir(), '.paseo', 'router-sharing-card', 'sessions');
const sessionFile = join(sessions, `${agentId}.json`);
try { await access(sessionFile); throw new Error('Conversation already configured; preserve its posts'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const base = 'http://127.0.0.1:18571';
try { await fetch(base + '/health'); throw new Error('Port 18571 is already in use; preserve the running test'); }
catch (error) { if (error.message?.includes('already in use')) throw error; }
await mkdir(directory, { recursive: true });
const log = await open(join(directory, 'router.log'), 'a');
const child = spawn(process.execPath, [fileURLToPath(new URL('../../../server/dist/http.js', import.meta.url))], {
  cwd: directory, detached: true, windowsHide: true, stdio: ['ignore', log.fd, log.fd],
  env: {
    ...process.env, PORT: '18571', BASE_URL: base, LISTEN_HOST: '127.0.0.1', STAGED_STORAGE: 'memory',
    STAGING_DELAY_MS: '3600000', RECOVERY_FILE: join(directory, 'recovery.json'),
    FIREBASE_SERVICE_ACCOUNT_BASE64: '', FIREBASE_SERVICE_ACCOUNT: '', GOOGLE_APPLICATION_CREDENTIALS: '',
    TINYCLOUD_AUTHORS: '', TINYCLOUD_GROUPS: 'memory', MODERATOR_URL: '', MATRIX_SERVER_URL: '',
    TELEGRAM_BOT_TOKEN: '', ANTHROPIC_API_KEY: '', SENDGRID_API_KEY: '', RESEND_API_KEY: '',
  },
});
child.unref(); await log.close();
await writeFile(join(directory, 'process.json'), JSON.stringify({ pid: child.pid, base, started_at: Date.now() }));
let ready = false;
for (let attempt = 0; attempt < 100; attempt++) {
  try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 200));
}
if (!ready) throw new Error('Test Router did not start; inspect the private router.log');
const key = randomBytes(32).toString('base64url');
const api = async (path, body) => {
  const response = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Test setup failed (${response.status})`);
  return response.json();
};
await api('/api/identity/register', { secret_key: key, handle: 'card_test' });
const created = await api('/api/entries', {
  secret_key: key, posting_intent: 'automatic', to: [],
  content: 'TEST: This disposable post lets you try deleting directly from a sharing card in this conversation.',
});
if (!created.receipt?.notification_required) throw new Error('Expected a gated test receipt');
const card = { version: 1, test: true, updated_at: Date.now(), receipts: [created.receipt] };
await privateDirectory(sessions);
await writeFile(sessionFile, JSON.stringify({ agent_id: agentId, mode: 'test', base_url: base, router_key: key, card }, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ready: true, pid: child.pid, entry_id: created.receipt.entry_id, state: created.receipt.state }));
