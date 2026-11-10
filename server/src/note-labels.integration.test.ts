import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// A note can carry a repository and tags. The label feed (/api/entries?repo=…&tag=…) is public:
// it must return only published public notes, and only the author may change a note's labels.
const port = 20000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const run = Date.now().toString(36).slice(-6);
const repo = `acme/widget-${run}`;
const author = { key: generateSecretKey(), handle: `lab${run}` };
const other = { key: generateSecretKey(), handle: `oth${run}` };
const ids: Record<string, string> = {};
let child: ChildProcess;

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function post(name: string, user: typeof author, extra: Record<string, unknown>, publishNow = true) {
  const res = await api('/api/entries', { secret_key: user.key, content: `${name} note ${run}`, posting_intent: 'user-requested', ...extra });
  expect(res.ok).toBe(true);
  const notice = (await res.json()).receipt;
  ids[name] = notice.entry_id;
  if (notice.notification_required) {
    expect((await api(`/api/entries/${notice.entry_id}/notice`, {
      notice_id: notice.notice_id, notice_sha256: notice.notice_sha256,
      evidence_kind: 'agent_reported', conversation_ref: 'synthetic-label-test:notice',
    }, user.key)).ok).toBe(true);
  }
  if (publishNow) expect((await api(`/api/entries/${notice.entry_id}/publish`, {}, user.key)).ok).toBe(true);
}

async function feed(query: string): Promise<{ names: string[]; entries: any[]; total: number }> {
  const res = await api(`/api/entries?${query}`);
  expect(res.status).toBe(200);
  const body = await res.json() as { entries: any[]; total: number };
  return { names: body.entries.map(e => e.content.split(' ')[0]).sort(), entries: body.entries, total: body.total };
}

describe('note labels', () => {
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
    if (!ready) throw new Error(`Isolated label test server did not start (exit ${child.exitCode}): ${startupOutput}`);

    for (const user of [author, other]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    await post('labeled', author, { repo: `https://github.com/${repo.toUpperCase()}.git`, tags: ['#Latency', 'speech recognition'] });
    await post('tagged', author, { tags: [`topic-${run}`] });
    await post('plain', author, {});
    await post('direct', author, { repo, to: [`@${other.handle}`] });
    await post('others', other, { repo });
    await post('waiting', author, { repo }, false);
  }, 35000);

  afterAll(() => { child?.kill(); });

  it('stores a normalized repo and tags on the note', async () => {
    const { entries } = await feed(`repo=${repo}&author=${author.handle}`);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: ids.labeled, repo, tags: ['latency', 'speech-recognition'] });
  });

  it('returns public published notes for a repo, from any author, and nothing addressed or waiting', async () => {
    expect((await feed(`repo=${repo}`)).names).toEqual(['labeled', 'others']);
    expect((await feed(`repo=${repo}&key=${author.key}`)).names).toEqual(['labeled', 'others']);
    expect((await feed(`repo=widget-${run}`)).names).toEqual(['labeled', 'others']);
  });

  it('filters by tag, by author, and by either label', async () => {
    expect((await feed(`tag=topic-${run}`)).names).toEqual(['tagged']);
    expect((await feed(`repo=${repo}&author=${other.handle}`)).names).toEqual(['others']);
    expect((await feed(`repo=${repo}&tag=topic-${run}`)).names).toEqual(['labeled', 'others', 'tagged']);
  });

  it('returns nothing for a label no note has, or an unusable one', async () => {
    expect((await feed(`repo=acme/nothing-${run}`)).total).toBe(0);
    expect((await feed('repo=%3Cscript%3E')).total).toBe(0);
  });

  it('pages with limit and offset', async () => {
    const first = await feed(`repo=${repo}&tag=topic-${run}&limit=2`);
    const rest = await feed(`repo=${repo}&tag=topic-${run}&limit=2&offset=2`);
    expect(first.total).toBe(3);
    expect(first.entries).toHaveLength(2);
    expect(rest.entries).toHaveLength(1);
  });

  it('lets only the author change labels', async () => {
    const path = `/api/entries/${ids.plain}/labels`;
    expect((await api(path, { repo })).status).toBe(401);
    expect((await api(path, { repo }, other.key)).status).toBe(403);
    expect((await api(path, { repo: 'not a repo' }, author.key)).status).toBe(400);
    expect((await api('/api/entries/missing-id/labels', { repo }, author.key)).status).toBe(404);

    const set = await api(path, { repo, tags: ['Backfilled'] }, author.key);
    expect(await set.json()).toEqual({ id: ids.plain, repo, tags: ['backfilled'] });
    expect((await feed(`repo=${repo}`)).names).toEqual(['labeled', 'others', 'plain']);
    const stored = (await feed('tag=backfilled')).entries[0];
    expect(stored.content).toBe(`plain note ${run}`);

    const cleared = await api(path, { repo: null }, author.key);
    expect(await cleared.json()).toEqual({ id: ids.plain, repo: null, tags: ['backfilled'] });
    expect((await feed(`repo=${repo}`)).names).toEqual(['labeled', 'others']);
  });

  it('labels a waiting note without publishing it', async () => {
    const res = await api(`/api/entries/${ids.waiting}/labels`, { tags: [`held-${run}`] }, author.key);
    expect(await res.json()).toEqual({ id: ids.waiting, repo, tags: [`held-${run}`] });
    expect((await feed(`tag=held-${run}`)).total).toBe(0);
    expect((await api(`/api/entries/${ids.waiting}/publish`, {}, author.key)).ok).toBe(true);
    expect((await feed(`tag=held-${run}`)).names).toEqual(['waiting']);
  });

  it('labels several notes at once through the router_label_entry tool, skipping notes that are not the caller’s', async () => {
    const client = new Client({ name: 'label-test', version: '1' });
    await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${author.key}`)));
    try {
      const call = async (args: Record<string, unknown>) => {
        const result = await client.callTool({ name: 'router_label_entry', arguments: args }) as { content: { text: string }[]; isError?: boolean };
        return { text: result.content[0].text, isError: !!result.isError };
      };
      expect((await call({ entry_ids: [ids.tagged] })).text).toContain('Give repo, tags or both');
      expect((await call({ entry_ids: [], tags: ['x'] })).isError).toBe(true);
      expect((await call({ entry_ids: [ids.tagged], repo: 'not a repo' })).text).toContain('owner/name');

      const done = await call({ entry_ids: [ids.tagged, ids.plain, ids.others, 'missing-id'], repo: `Acme/Batch-${run}` });
      expect(done.isError).toBe(false);
      expect(done.text).toContain('Labeled 2 of 4 notes');
      expect(done.text).toContain(ids.others);
      expect(done.text).toContain('missing-id');
      const batch = await feed(`repo=acme/batch-${run}`);
      expect(batch.names).toEqual(['plain', 'tagged']);
      // Tags were not part of the request, so they are kept.
      expect(batch.entries.find(e => e.id === ids.tagged).tags).toEqual([`topic-${run}`]);

      expect((await call({ entry_ids: [ids.tagged, ids.plain], repo: null })).text).toContain('no repository');
      expect((await feed(`repo=acme/batch-${run}`)).total).toBe(0);
    } finally { await client.close(); }
  });

  it('leaves the ordinary feed unchanged', async () => {
    const res = await api('/api/entries?limit=50');
    const body = await res.json() as { entries: any[]; nextCursor: unknown };
    expect(body.entries.map(e => e.id)).toEqual(expect.arrayContaining([ids.labeled, ids.tagged, ids.others]));
    expect(body.entries.map(e => e.id)).not.toContain(ids.direct);
  });
});
