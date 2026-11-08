import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';

// /api/search is public. Entries addressed to people or groups must come back
// only to their author and recipients, exactly as in the feed.
const port = 15000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const word = `zq${tag}marker`;
const author = { key: generateSecretKey(), handle: `auth${tag}` };
const recipient = { key: generateSecretKey(), handle: `recp${tag}` };
const outsider = { key: generateSecretKey(), handle: `outs${tag}` };
const group = `club-${tag}`;
const texts = {
  public: `Public note ${word}`,
  direct: `Direct note ${word}`,
  group: `Group note ${word}`,
};
let child: ChildProcess;

async function api(path: string, body?: unknown) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function search(key?: string): Promise<string[]> {
  const res = await api(`/api/search?q=${word}&limit=10${key ? `&key=${key}` : ''}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { results: { content: string }[] };
  return body.results.map(e => e.content).sort();
}

describe('/api/search visibility', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: '', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`Isolated search test server did not start (exit ${child.exitCode}): ${startupOutput}`);

    for (const user of [author, recipient, outsider]) {
      const res = await api('/api/identity/register', { secret_key: user.key, handle: user.handle });
      expect(res.ok).toBe(true);
    }
    const created = await api('/api/channels', { secret_key: author.key, id: group, name: 'Private test group', visibility: 'private', join_rule: 'invite', storage: 'router' });
    expect(created.ok).toBe(true);

    for (const [content, to] of [[texts.public, []], [texts.direct, [`@${recipient.handle}`]], [texts.group, [`#${group}`]]] as const) {
      const res = await api('/api/entries', { secret_key: author.key, content, to, posting_intent: 'user-requested' });
      expect(res.ok).toBe(true);
    }
  }, 35000);

  afterAll(() => { child?.kill(); });

  it('returns only public entries without a key or to someone not addressed', async () => {
    expect(await search()).toEqual([texts.public]);
    expect(await search(outsider.key)).toEqual([texts.public]);
  });

  it('returns a direct entry to its recipient, but not the group entry', async () => {
    expect(await search(recipient.key)).toEqual([texts.direct, texts.public].sort());
  });

  it('returns every entry to its author', async () => {
    expect(await search(author.key)).toEqual([texts.direct, texts.group, texts.public].sort());
  });
});
