import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

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

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function publish(notice: any, key: string) {
  if (notice.notification_required) {
    expect((await api(`/api/entries/${notice.entry_id}/notice`, {
      notice_id: notice.notice_id, notice_sha256: notice.notice_sha256,
      evidence_kind: 'agent_reported', conversation_ref: 'synthetic-permission-test:notice',
    }, key)).ok).toBe(true);
  }
  expect((await api(`/api/entries/${notice.entry_id}/publish`, {}, key)).ok).toBe(true);
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
      await publish((await res.json()).receipt, author.key);
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

  it('derives sparks only from public writing, including when called by the private author', async () => {
    const topic = `sparks${tag}`;
    const clients: Client[] = [];
    try {
      for (const user of [author, recipient, outsider]) {
        const client = new Client({ name: 'spark-visibility-test', version: '1' });
        await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${user.key}`)));
        clients.push(client);
      }
      const write = async (client: Client, key: string, to: string[]) => {
        const result = await client.callTool({ name: 'router_write_entry', arguments: {
          client: 'code', entry: `Writing about ${topic}`, search_keywords: [topic], topic_hints: [topic],
          sensitivity_check: 'Synthetic isolated permission test', posting_intent: 'user-requested', to,
        } });
        expect(result.isError).not.toBe(true);
        await publish((result.structuredContent as any).receipt, key);
      };
      for (const to of [[`@${recipient.handle}`], [`#${group}`]]) {
        await write(clients[0], author.key, to);
      }
      await write(clients[1], recipient.key, []);
      await write(clients[2], outsider.key, []);
      // Public destination alone does not make an unannounced waiting post public.
      expect((await clients[0].callTool({ name: 'router_write_entry', arguments: {
        client: 'code', entry: `Pending ${topic}`, search_keywords: [topic], topic_hints: [topic], to: [],
        sensitivity_check: 'Synthetic isolated test', posting_intent: 'user-requested',
      } })).isError).not.toBe(true);
      for (const client of clients) {
        const result = await client.callTool({ name: 'router_search_sparks', arguments: { query: topic } });
        expect(result.isError).not.toBe(true);
        const text = JSON.stringify(result.content);
        expect(text).toContain(`@${recipient.handle}`);
        expect(text).toContain(`@${outsider.handle}`);
        expect(text).not.toContain(`@${author.handle}`);
      }
      const webSparks = await api(`/api/sparks?key=${recipient.key}`).then(r => r.json());
      expect(JSON.stringify(webSparks)).toContain(outsider.handle);
      expect(JSON.stringify(webSparks)).not.toContain(author.handle);
      for (const handle of [recipient.handle, author.handle]) {
        const result = await clients[2].callTool({ name: 'router_search_sparks', arguments: { handle } });
        expect(result.isError).not.toBe(true);
        const text = JSON.stringify(result.content);
        expect(text).not.toContain(`@${author.handle}`);
        if (handle === recipient.handle) expect(text).toContain(`@${outsider.handle}`);
        else expect(text).toContain('No sparks found');
      }
    } finally {
      await Promise.all(clients.map(client => client.close()));
    }
  });
});
