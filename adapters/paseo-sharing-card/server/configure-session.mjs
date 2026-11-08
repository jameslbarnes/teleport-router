// Host-side setup only. Never pass a Router key in argv or a chat message.
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { privateDirectory } from './private-files.mjs';

const { values } = parseArgs({ options: {
  agent: { type: 'string' }, 'key-file': { type: 'string' }, 'test-base': { type: 'string' },
} });
const agentId = values.agent || process.env.PASEO_AGENT_ID;
if (!agentId || !/^[a-f0-9-]{36}$/.test(agentId) || !values['key-file']) {
  throw new Error('Pass --agent <conversation UUID> --key-file <protected plain-text key file>');
}
const base = values['test-base'] || 'https://router.teleport.computer';
const test = !!values['test-base'];
const url = new URL(base);
if (test && (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || base !== url.origin)) {
  throw new Error('Test mode requires an isolated loopback origin');
}
const key = (await readFile(values['key-file'], 'utf8')).trim();
if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Error('Key file is not a Router key');
const response = await fetch(`${base}/api/posting-rules`, {
  headers: { Authorization: `Bearer ${key}` }, redirect: 'error', signal: AbortSignal.timeout(10000),
});
if (!response.ok) throw new Error(`Router connection check failed (${response.status})`);
const directory = join(homedir(), '.paseo', 'router-sharing-card', 'sessions');
await privateDirectory(directory);
await writeFile(join(directory, `${agentId}.json`), JSON.stringify({
  agent_id: agentId, mode: test ? 'test' : 'production', base_url: base, key_file: resolve(values['key-file']),
  card: { version: 1, test, updated_at: Date.now(), receipts: [] },
}, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ configured: true, agent_id: agentId, mode: test ? 'test' : 'production' }));
