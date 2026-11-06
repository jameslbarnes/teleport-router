import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { generateSecretKey } from './identity.js';

const port = 25000 + Math.floor(Math.random() * 4000), base = `http://127.0.0.1:${port}`;
const ownerKey = generateSecretKey(), readerKey = generateSecretKey();
const owner = 'notice_owner', reader = 'notice_reader';
let child: ChildProcess, client: Client;
const api = (path: string, key?: string, method = 'GET', body?: unknown) => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const write = (to: string[] = []) => client.callTool({ name: 'router_write_entry', arguments: { entry: 'An automatic test post.\n[Useful link](https://example.org).', client: 'code', sensitivity_check: 'Synthetic local test', search_keywords: [], posting_intent: 'automatic', to } });
function receipt(result: any) {
  expect(result.isError).not.toBe(true);
  const notice = result.structuredContent.receipt;
  expect(result.content[0].text).toContain(notice.review_url);
  expect(result.content[0].text).toContain('immediately show the person');
  expect(notice.notification_evidence).toBeNull();
  expect(notice.review_url).not.toContain(ownerKey);
  return notice;
}

describe('Write, review and delete across the publication boundary', () => {
  beforeAll(async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr?.on('data', d => { output = (output + d).slice(-2000); }); child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) { try { if ((await api('/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    if (!ready) throw new Error('Local notice server failed: ' + output);
    for (const [secret_key, handle] of [[ownerKey, owner], [readerKey, reader]]) expect((await api('/api/identity/register', undefined, 'POST', { secret_key, handle })).ok).toBe(true);
    client = new Client({ name: 'notice-test', version: '1' });
    await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${ownerKey}`)));
  }, 35000);
  afterAll(async () => { await client?.close().catch(() => {}); child?.kill(); });

  it('keeps automatic posting enabled, returns a precise receipt, and permits only the owner to delete', async () => {
    const notice = receipt(await write());
    expect(notice.state).toBe('awaiting_notice');
    expect(notice.publish_at).toBeNull();
    expect((await api(`/api/entries/${notice.entry_id}/publish`, ownerKey, 'POST')).status).toBe(409);
    const path = `/api/entry/${notice.entry_id}`;
    expect((await api(path)).status).toBe(404);
    expect((await api(path, readerKey)).status).toBe(404);
    const entry = await api(path, ownerKey).then(r => r.json());
    expect(entry).toMatchObject({ canDelete: true, sharingReceipt: notice });
    expect((await api(`/api/entries/${notice.entry_id}`, readerKey, 'DELETE')).status).toBe(403);
    // Link previews and the old GET route must never delete.
    const redirect = await fetch(`${base}/delete/${notice.entry_id}?key=${ownerKey}`, { redirect: 'manual' });
    expect(redirect.status).toBe(303);
    expect(redirect.headers.get('location')).toBe(`/e/${notice.entry_id}#manage`);
    expect((await api(path, ownerKey)).status).toBe(200);
    expect((await api(`/api/entries/${notice.entry_id}`, ownerKey, 'DELETE')).ok).toBe(true);
    expect((await api(path, ownerKey)).status).toBe(404);
  });

  it('keeps the same review link after publication and deletes the published record', async () => {
    const notice = receipt(await write());
    const record = { entry_id: notice.entry_id, notice_id: notice.notice_id, notice_sha256: notice.notice_sha256, conversation_ref: 'synthetic-transcript:message-2' };
    const recorded = await client.callTool({ name: 'router_record_sharing_notice', arguments: record });
    expect(recorded.isError).not.toBe(true);
    const confirmed = (recorded.structuredContent as any).receipt;
    expect(confirmed.state).toBe('pending');
    expect(confirmed.publish_at).toBeGreaterThan(Date.now() + 3599000);
    expect(confirmed.notification_evidence.kind).toBe('agent_reported');
    expect(JSON.stringify(confirmed)).not.toContain(record.conversation_ref);
    const retry = await client.callTool({ name: 'router_record_sharing_notice', arguments: record });
    expect((retry.structuredContent as any).receipt).toEqual(confirmed);
    const published = await api(`/api/entries/${notice.entry_id}/publish?key=${ownerKey}`, undefined, 'POST').then(r => r.json());
    expect(published.entry.id).toBe(notice.entry_id);
    const mine = await api(`/api/entry/${notice.entry_id}`, ownerKey).then(r => r.json());
    expect(mine.sharingReceipt).toMatchObject({ state: 'published', publish_at: null, review_url: notice.review_url });
    const publicView = await api(`/api/entry/${notice.entry_id}`).then(r => r.json());
    expect(publicView.canDelete).toBe(false);
    expect(publicView.sharingReceipt).toBeUndefined();
    expect(publicView.sharingNotice).toBeUndefined();
    expect((await api(`/api/entries/${notice.entry_id}`, ownerKey, 'DELETE')).ok).toBe(true);
    expect((await api(`/api/entry/${notice.entry_id}`)).status).toBe(404);
  });

  it('rejects absent, mismatched and other-author notice records without starting the countdown', async () => {
    const first = receipt(await write()), second = receipt(await write());
    const path = `/api/entries/${first.entry_id}/notice`;
    const input = { notice_id: first.notice_id, notice_sha256: first.notice_sha256, conversation_ref: 'local-test:message', evidence_kind: 'agent_reported' };
    expect((await api(path, undefined, 'POST', input)).status).toBe(401);
    expect((await api(path, readerKey, 'POST', input)).status).toBe(404);
    expect((await api(path, ownerKey, 'POST', { ...input, notice_id: second.notice_id })).status).toBe(409);
    expect((await api(path, ownerKey, 'POST', { ...input, conversation_ref: '' })).status).toBe(409);
    expect((await api(`/api/entry/${first.entry_id}`, ownerKey).then(r => r.json())).sharingReceipt.state).toBe('awaiting_notice');
    expect((await api(path, ownerKey, 'POST', input)).status).toBe(200);
  });

  it('returns the actual audience on REST, personal skills and group skills', async () => {
    const rest = await api('/api/entries', undefined, 'POST', { secret_key: ownerKey, content: '<img src=x onerror=alert(1)>\n[bad](javascript:alert(1))', to: [`@${reader}`] }).then(r => r.json());
    expect(rest.receipt.destinations).toEqual([`@${reader}`]);
    const safe = await api(`/api/entry/${rest.entry.id}`, ownerKey).then(r => r.json());
    expect(safe.contentHtml).not.toMatch(/<img|href="javascript:/i);
    expect((await client.callTool({ name: 'router_skills', arguments: { action: 'create', name: 'notice', description: 'Test', instructions: 'Test', to: [`@${reader}`] } })).isError).not.toBe(true);
    expect(receipt(await client.callTool({ name: 'skill_notice', arguments: { result: 'Personal skill test.' } })).destinations).toEqual([`@${reader}`]);
    expect((await api('/api/channels', undefined, 'POST', { secret_key: ownerKey, id: 'notices', name: 'Notices', join_rule: 'invite', visibility: 'private' })).ok).toBe(true);
    expect((await api('/api/channels/notices/skills', undefined, 'POST', { secret_key: ownerKey, name: 'note', description: 'Test', instructions: 'Test' })).ok).toBe(true);
    expect(receipt(await client.callTool({ name: 'channel_notices_note', arguments: { result: 'Group skill test.' } })).destinations).toEqual(['#notices']);
  });
});
