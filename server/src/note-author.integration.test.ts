import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { generateSecretKey } from './identity.js';

// A note with a handle belongs only to the account with that handle. A note with no handle belongs to the key whose
// derived name matches the note's. The server here gives `author`, `sameName` and `noHandle` keys the same derived
// name (scripts/shared-name-keys).
const port = 21000 + Math.floor(Math.random() * 4000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const author = { key: generateSecretKey(), handle: `auth${tag}` };
const sameName = { key: generateSecretKey(), handle: `same${tag}` };
const noHandle = { key: generateSecretKey() };
const reader = { key: generateSecretKey(), handle: `read${tag}` };
const legacy = { key: generateSecretKey() };
const others = [sameName.key, noHandle.key];
let child: ChildProcess;

async function api(path: string, body?: unknown, key?: string, method?: string) {
  return fetch(base + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const client = new Client({ name: 'note-author-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  try { return await client.callTool({ name, arguments: args }) as { isError?: boolean; content: { text: string }[] }; }
  finally { await client.close(); }
}
const text = (result: { content: { text: string }[] }) => result.content.map(c => c.text).join('\n');
async function write(key: string, content: string, to: string[] = []) {
  const res = await api('/api/entries', { secret_key: key, content, to, posting_intent: 'user-requested' });
  expect(res.status).toBeLessThan(300);
  return (await res.json()).receipt as { entry_id: string; notice_id?: string; notice_sha256?: string; notification_required?: boolean };
}
const notice = (receipt: { entry_id: string; notice_id?: string; notice_sha256?: string }, key: string) =>
  api(`/api/entries/${receipt.entry_id}/notice`, { notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
    evidence_kind: 'agent_reported', conversation_ref: 'note-author-test:notice' }, key);
const entryIds = async (path: string) => JSON.stringify(await (await api(path)).json());

describe('who counts as a note\'s author', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', '--import', './scripts/shared-name-keys/register.mjs', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000',
        ROUTER_TEST_SHARED_NAME_KEYS: [author.key, sameName.key, noHandle.key].join(','),
        MODERATOR_HANDLES: '', TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '',
        SENDGRID_API_KEY: '', ANTHROPIC_API_KEY: '', FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    if (!ready) throw new Error(`Test server did not start (exit ${child.exitCode}): ${startupOutput}`);
    for (const user of [author, sameName, reader]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
  }, 120000);
  afterAll(() => { child?.kill(); });

  it('gives the three keys the same name, so the checks below rest on the handle', async () => {
    const names = await Promise.all([author.key, sameName.key, noHandle.key].map(async key => {
      const res = await api('/api/entries', { secret_key: key, content: `Name check ${tag}`, posting_intent: 'user-requested' });
      const body = await res.json() as { pseudonym: string; entry: { id: string } };
      expect((await api(`/api/entries/${body.entry.id}`, undefined, key, 'DELETE')).ok).toBe(true);
      return body.pseudonym;
    }));
    expect(names[0]).toBeTruthy();
    expect(new Set(names).size).toBe(1);
  });

  it('keeps a waiting note with a handle from another account or key with the same name', async () => {
    const content = `Waiting note with a handle ${tag}`;
    const receipt = await write(author.key, content);
    const id = receipt.entry_id;
    for (const key of others) {
      expect((await api(`/api/entry/${id}?key=${key}`)).status).toBe(404);
      expect((await api(`/api/entry/${id}/replies?key=${key}`)).status).toBe(404);
      expect(await entryIds(`/api/entries?key=${key}&limit=50`)).not.toContain(content);
      if (key === sameName.key) expect(await entryIds(`/api/inbox?key=${key}&limit=50`)).not.toContain(content);
      expect(text(await tool(key, 'router_get_entry', { entry_id: id }))).not.toContain(content);
      expect(text(await tool(key, 'router_review_staged', {}))).not.toContain(content);
      expect((await notice(receipt, key)).status).toBe(404);
      const toolNotice = await tool(key, 'router_record_sharing_notice', { entry_id: id, notice_id: receipt.notice_id,
        notice_sha256: receipt.notice_sha256, evidence_kind: 'agent_reported', conversation_ref: 'note-author-test:notice' });
      expect(toolNotice.isError).toBe(true);
      expect((await api(`/api/entries/${id}/labels`, { tags: ['x'] }, key)).status).toBe(403);
      expect((await tool(key, 'router_label_entry', { entry_ids: [id], tags: ['x'] })).isError).toBe(true);
      expect((await api(`/api/entries/${id}/publish`, {}, key)).status).toBe(403);
      expect((await tool(key, 'router_release_entry', { entry_id: id })).isError).toBe(true);
      expect((await api(`/api/entries/${id}`, undefined, key, 'DELETE')).status).toBe(403);
      expect((await tool(key, 'router_delete_entry', { entry_id: id })).isError).toBe(true);
    }
    // Still there, still waiting, unlabelled: and its author can do all of it.
    const own = await api(`/api/entry/${id}?key=${author.key}`);
    expect(own.status).toBe(200);
    expect(JSON.stringify(await own.json())).not.toContain('"x"');
    expect(await entryIds(`/api/entries?key=${author.key}&limit=50`)).toContain(content);
    expect(await entryIds(`/api/inbox?key=${author.key}&limit=50`)).toContain(content);
    expect(text(await tool(author.key, 'router_review_staged', {}))).toContain(content);
    expect((await api(`/api/entries/${id}/labels`, { tags: ['mine'] }, author.key)).status).toBe(200);
    expect((await tool(author.key, 'router_label_entry', { entry_ids: [id], tags: ['mine'] })).isError).toBeFalsy();
    if (receipt.notification_required) expect((await notice(receipt, author.key)).ok).toBe(true);
    expect((await api(`/api/entries/${id}/publish`, {}, author.key)).ok).toBe(true);
    expect((await api(`/api/entries/${id}`, undefined, author.key, 'DELETE')).ok).toBe(true);
  });

  it('lets only the author delete a published note with a handle, through the tool or the page', async () => {
    const receipt = await write(author.key, `Published note with a handle ${tag}`);
    if (receipt.notification_required) expect((await notice(receipt, author.key)).ok).toBe(true);
    expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, author.key)).ok).toBe(true);
    for (const key of others) {
      expect((await tool(key, 'router_delete_entry', { entry_id: receipt.entry_id })).isError).toBe(true);
      expect((await api(`/api/entries/${receipt.entry_id}`, undefined, key, 'DELETE')).status).toBe(403);
    }
    expect((await api(`/api/entry/${receipt.entry_id}`)).status).toBe(200);
    expect((await tool(author.key, 'router_delete_entry', { entry_id: receipt.entry_id })).isError).toBeFalsy();
    expect((await api(`/api/entry/${receipt.entry_id}`)).status).toBe(404);
  });

  it('shows a note addressed to one person only to its author and that person', async () => {
    const content = `Addressed note with a handle ${tag}`;
    const receipt = await write(author.key, content, [`@${reader.handle}`]);
    if (receipt.notification_required) expect((await notice(receipt, author.key)).ok).toBe(true);
    expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, author.key)).ok).toBe(true);
    for (const key of others) {
      expect((await api(`/api/entry/${receipt.entry_id}?key=${key}`)).status).toBe(404);
      expect(await entryIds(`/api/entries?key=${key}&limit=50`)).not.toContain(content);
      expect(await entryIds(`/api/search?q=${tag}&limit=50&key=${key}`)).not.toContain(content);
    }
    for (const key of [author.key, reader.key]) expect((await api(`/api/entry/${receipt.entry_id}?key=${key}`)).status).toBe(200);
  });

  it('keeps a note with no handle working for the key whose derived name matches it', async () => {
    const content = `Note with no handle ${tag}`;
    const receipt = await write(legacy.key, content);
    const id = receipt.entry_id;
    expect((await api(`/api/entry/${id}?key=${reader.key}`)).status).toBe(404);
    expect((await api(`/api/entries/${id}`, undefined, reader.key, 'DELETE')).status).toBe(403);
    expect((await api(`/api/entry/${id}?key=${legacy.key}`)).status).toBe(200);
    expect(await entryIds(`/api/entries?key=${legacy.key}&limit=50`)).toContain(content);
    expect((await api(`/api/entries/${id}/labels`, { tags: ['legacy'] }, legacy.key)).status).toBe(200);
    expect((await tool(legacy.key, 'router_label_entry', { entry_ids: [id], tags: ['legacy'] })).isError).toBeFalsy();
    if (receipt.notification_required) {
      const recorded = await tool(legacy.key, 'router_record_sharing_notice', { entry_id: id, notice_id: receipt.notice_id,
        notice_sha256: receipt.notice_sha256, evidence_kind: 'agent_reported', conversation_ref: 'note-author-test:notice' });
      expect(recorded.isError).toBeFalsy();
    }
    expect((await api(`/api/entries/${id}/publish`, {}, legacy.key)).ok).toBe(true);
    expect((await tool(legacy.key, 'router_delete_entry', { entry_id: id })).isError).toBeFalsy();
  });

  it('keeps a note marked private with nowhere to go for its author alone', async () => {
    const content = `Private with no destination ${tag}`;
    const written = await tool(author.key, 'router_write_entry', { sensitivity_check: 'Nothing sensitive: a synthetic test note.',
      client: 'code', entry: content, search_keywords: [tag], visibility: 'private' });
    expect(written.isError).toBeFalsy();
    const pending = (await (await api(`/api/entries?key=${author.key}&limit=50`)).json()).entries.find((e: any) => e.content === content);
    expect(pending?.visibility).toBe('private');
    expect(pending?.to).toBeUndefined();
    const receipt = (await (await api(`/api/entry/${pending.id}?key=${author.key}`)).json()).sharingReceipt;
    if (receipt?.notification_required) expect((await notice(receipt, author.key)).ok).toBe(true);
    expect((await api(`/api/entries/${pending.id}/publish`, {}, author.key)).ok).toBe(true);
    for (const key of [reader.key, undefined]) {
      expect((await api(`/api/entry/${pending.id}${key ? `?key=${key}` : ''}`)).status).toBe(404);
      expect(await entryIds(`/api/entries?limit=50${key ? `&key=${key}` : ''}`)).not.toContain(content);
      expect(await entryIds(`/api/search?q=${tag}&limit=50${key ? `&key=${key}` : ''}`)).not.toContain(content);
    }
    expect((await api(`/api/entry/${pending.id}?key=${author.key}`)).status).toBe(200);
  });

  it("on claiming a handle, moves to it only the notes with no handle under the key's name", async () => {
    const publish = async (key: string, content: string) => {
      const receipt = await write(key, content);
      if (receipt.notification_required) expect((await notice(receipt, key)).ok).toBe(true);
      expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, key)).ok).toBe(true);
      return receipt.entry_id;
    };
    const theirs = await publish(author.key, `Handled note before a claim ${tag}`);
    const older = await publish(noHandle.key, `Note with no handle before a claim ${tag}`);
    const late = `late${tag}`;
    const claimed = await api('/api/identity/claim', { secret_key: noHandle.key, handle: late });
    expect(claimed.status).toBe(201);
    expect((await claimed.json()).migratedEntries).toBe(1);
    expect((await (await api(`/api/entry/${theirs}`)).json()).handle).toBe(author.handle);
    expect((await (await api(`/api/entry/${older}`)).json()).handle).toBe(late);
    // The other account keeps its note and its authority over it; the new account has none.
    expect((await api(`/api/entries/${theirs}/labels`, { tags: ['x'] }, noHandle.key)).status).toBe(403);
    expect((await api(`/api/entries/${theirs}`, undefined, noHandle.key, 'DELETE')).status).toBe(403);
    expect((await api(`/api/entries/${theirs}/labels`, { tags: ['kept'] }, author.key)).status).toBe(200);
    expect((await api(`/api/entries/${older}/labels`, { tags: ['mine'] }, noHandle.key)).status).toBe(200);
    // Running the move again changes nothing.
    const again = await api('/api/identity/migrate', { secret_key: noHandle.key });
    expect((await again.json()).migratedEntries).toBe(0);
    expect((await (await api(`/api/entry/${theirs}`)).json()).handle).toBe(author.handle);
  });
});
