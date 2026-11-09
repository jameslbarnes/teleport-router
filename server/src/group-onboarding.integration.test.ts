import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { generateSecretKey } from './identity.js';

const port = 30000 + Math.floor(Math.random() * 4000), base = `http://127.0.0.1:${port}`;
const ownerKey = generateSecretKey(), newKey = generateSecretKey(), outsiderKey = generateSecretKey();
const group = 'reading-club', otherGroup = 'another-group';
let child: ChildProcess, newcomer: Client, owner: Client, outsider: Client;
let invite: string, savedEntry: string;
const clients: Client[] = [];
const api = (path: string, key?: string, body?: unknown) => fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
async function connect(key: string) {
  const client = new Client({ name: 'group-first-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  clients.push(client); return client;
}
const call = (client: Client, name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
const text = (result: any) => result.content.map((c: any) => c.text || '').join('\n');
async function publish(client: Client, key: string, content: string, to?: string[]) {
  const result = await call(client, 'router_write_entry', { entry: content, client: 'code', sensitivity_check: 'Invented local fixture.', search_keywords: [], ...(to ? { to } : {}) });
  expect(result.isError, text(result)).not.toBe(true);
  const receipt = (result.structuredContent as any).receipt;
  // Local fixture transcript only: no production account or external message.
  if (receipt.notification_required) {
    const recorded = await call(client, 'router_record_sharing_notice', { entry_id: receipt.entry_id, notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256, conversation_ref: 'synthetic-local-fixture:visible-notice' });
    expect(recorded.isError, text(recorded)).not.toBe(true);
  }
  expect((await api(`/api/entries/${receipt.entry_id}/publish?key=${key}`, undefined, {})).ok).toBe(true);
  return receipt.entry_id;
}

describe('A new member joins, chooses group rules, reads and shares', () => {
  beforeAll(async () => {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', ANTHROPIC_API_KEY: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr?.on('data', d => { output = (output + d).slice(-2000); }); child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) { try { if ((await api('/health')).ok) { ready = true; break; } } catch {} await new Promise(r => setTimeout(r, 150)); }
    if (!ready) throw new Error('Local group server failed: ' + output);
    for (const [secret_key, handle] of [[ownerKey, 'owner'], [newKey, 'newcomer'], [outsiderKey, 'outsider']]) expect((await api('/api/identity/register', undefined, { secret_key, handle })).ok).toBe(true);
    for (const id of [group, otherGroup, 'open-club']) expect((await api('/api/channels', undefined, { secret_key: ownerKey, id, name: id === group ? 'Reading club' : 'Another group', description: id === group ? 'Explore ideas together.' : 'OTHER-GROUP-DESCRIPTION', join_rule: id === 'open-club' ? 'open' : 'invite' })).ok).toBe(true);
    invite = (await api(`/api/channels/${group}/invite`, undefined, { secret_key: ownerKey, max_uses: 1 }).then(r => r.json())).token;
    owner = await connect(ownerKey); newcomer = await connect(newKey); outsider = await connect(outsiderKey);
  }, 35000);
  afterAll(async () => { await Promise.all(clients.map(c => c.close().catch(() => {}))); child?.kill(); });

  it('keeps the invitation context without publishing, joining or saving choices on a read', async () => {
    const response = await api(`/api/tutorial?channelinvite=${invite}`);
    const view = await response.json();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(view.group.id).toBe(group);
    expect(view.member).toBe(false);
    expect(view.prompt).not.toContain('t.me/');
    expect(view.prompt).not.toContain('OTHER-GROUP-DESCRIPTION');
    expect((await api(`/api/group-onboarding?group=${group}`, newKey)).status).toBe(403);
    expect((await api(`/api/group-onboarding?group=${group}`)).status).toBe(401);
    expect((await api('/api/posting-rules', newKey).then(r => r.json())).revision).toBe(0);
    expect((await api(`/api/channels/${group}/join`, undefined, { secret_key: newKey, invite_token: invite })).ok).toBe(true);
    expect((await api(`/api/tutorial?channelinvite=${invite}`)).status).toBe(410);
  });

  it('offers one group as a draft, preserving choices until an explicit save', async () => {
    const response = await api(`/api/group-onboarding?group=${group}`, newKey);
    expect(response.status).toBe(200);
    const view = await response.json();
    expect(view.member).toBe(true);
    expect(view.prompt).not.toContain(newKey);
    expect(view.prompt).not.toContain(ownerKey);
    expect(view.suggested_rules.destinations).toEqual([`#${group}`]);
    expect((await api('/api/posting-rules', newKey).then(r => r.json())).revision).toBe(0);
    expect((await api('/api/posting-rules', newKey, { rules: view.suggested_rules, expected_revision: 0, confirmed: true })).ok).toBe(true);
    expect((await api(`/api/group-onboarding?group=${otherGroup}`, newKey)).status).toBe(403);
    expect((await api('/api/posting-rules', newKey).then(r => r.json())).revision).toBe(1);
  });

  it('allows an automatic group note and blocks automatic public writes through MCP and HTTP', async () => {
    savedEntry = await publish(newcomer, newKey, 'GROUP-ONLY first useful notebook observation.');
    const row = await api(`/api/entry/${savedEntry}`, newKey).then(r => r.json());
    expect(row.to).toEqual([`#${group}`]);
    expect((await api(`/api/entry/${savedEntry}`)).status).toBe(404);
    const blocked = await call(newcomer, 'router_write_entry', { entry: 'MUST-NOT-PUBLISH', to: [], client: 'code', sensitivity_check: 'Synthetic.', search_keywords: [] });
    expect(blocked.isError).toBe(true);
    expect((await api('/api/entries', undefined, { secret_key: newKey, content: 'MUST-NOT-PUBLISH', to: [] })).status).toBe(409);
    const approved = await call(newcomer, 'router_write_entry', { entry: 'My separately approved public idea.', to: [], posting_intent: 'user-approved', client: 'code', sensitivity_check: 'Synthetic.', search_keywords: [] });
    expect(approved.isError, text(approved)).not.toBe(true);
    expect((approved.structuredContent as any).receipt.audience).toBeDefined();
  });

  it('labels open groups as public and suggests approval before every post', async () => {
    await publish(owner, ownerKey, 'OPEN-GROUP-PUBLIC note.', ['#open-club']);
    expect(await api('/api/channels/open-club/entries').then(r => r.text())).toContain('OPEN-GROUP-PUBLIC');
    expect((await api('/api/channels/open-club/join', undefined, { secret_key: outsiderKey })).ok).toBe(true);
    const view = await api('/api/group-onboarding?group=open-club', outsiderKey).then(r => r.json());
    expect(view.group.audience).toContain('without joining');
    expect(view.suggested_rules.mode).toBe('review');
    expect((await api('/api/posting-rules', outsiderKey, { rules: view.suggested_rules, expected_revision: 0, confirmed: true })).ok).toBe(true);
    expect((await call(outsider, 'router_write_entry', { entry: 'OPEN-AUTO-BLOCKED', client: 'code', sensitivity_check: 'Synthetic.', search_keywords: [] })).isError).toBe(true);
  });

  it('reads only the chosen group even when the caller belongs to several, and never falls back', async () => {
    await publish(owner, ownerKey, 'OTHER-GROUP-ONLY notebook observation.', [`#${otherGroup}`]);
    await publish(owner, ownerKey, 'PUBLIC-ONLY notebook observation.', []);
    const pending = await call(owner, 'router_write_entry', { entry: 'PENDING-ONLY notebook observation.', to: [`#${group}`], client: 'code', sensitivity_check: 'Synthetic.', search_keywords: [] });
    expect(pending.isError).not.toBe(true);
    const found = await call(owner, 'router_search', { group_id: group, query: 'notebook', include_matrix: true });
    expect(found.isError).not.toBe(true);
    expect(text(found)).toContain('GROUP-ONLY');
    for (const absent of ['OTHER-GROUP-ONLY', 'PUBLIC-ONLY', 'PENDING-ONLY']) expect(text(found)).not.toContain(absent);
    expect(text(await call(newcomer, 'router_search', { group_id: group }))).toContain(savedEntry);
    expect((await call(outsider, 'router_search', { group_id: group, query: 'notebook' })).isError).toBe(true);
    expect((await call(owner, 'router_search', { group_id: 'missing-group', query: 'notebook' })).isError).toBe(true);
    expect((await call(owner, 'router_search', { group_id: '', query: 'notebook' })).isError).toBe(true);
    expect((await api(`/api/channels/${group}/leave`, undefined, { secret_key: newKey })).ok).toBe(true);
    expect((await call(newcomer, 'router_search', { group_id: group })).isError).toBe(true);
    expect((await api(`/api/group-onboarding?group=${group}`, newKey)).status).toBe(403);
    expect((await call(newcomer, 'router_write_entry', { entry: 'AFTER-LEAVING', client: 'code', sensitivity_check: 'Synthetic.', search_keywords: [] })).isError).toBe(true);
  });
});
