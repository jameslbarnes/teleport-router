import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { generateSecretKey } from './identity.js';
import type { PostingRulesDraft } from './posting-rules.js';

const port = 15000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const ownerKey = generateSecretKey(), otherKey = generateSecretKey();
const owner = `rule${Date.now().toString(36).slice(-6)}`, other = `read${Date.now().toString(36).slice(-6)}`;
const privateText = 'Keep my private wording exactly — <script>not markup</script>\n  and spaces.';
const draft: PostingRulesDraft = { mode: 'manual', audience: 'selected', destinations: [`@${other}`], purpose: 'Find people working on related questions.', share: 'Useful discoveries', avoid: 'Private source material', style: 'Brief and concrete', instructions: privateText };
let child: ChildProcess;
let client: Client;
const clients: Client[] = [];
async function connect(key: string) {
  const c = new Client({ name: 'rules-fresh-session', version: '1' });
  await c.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  clients.push(c); return c;
}
async function api(path: string, key?: string, body?: unknown) {
  return fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await c.callTool({ name, arguments: args });
  return { error: result.isError, text: (result.content as { type: string; text?: string }[]).find(b => b.type === 'text')?.text || '' };
}
const write = { entry: 'An invented test idea.', client: 'code', sensitivity_check: 'Synthetic local test only.', search_keywords: [] };

describe('Personal rules across HTTP and fresh MCP sessions', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(), env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`Isolated rules test server did not start (exit ${child.exitCode}): ${startupOutput}`);
    for (const [key, handle] of [[ownerKey, owner], [otherKey, other]]) {
      const res = await api('/api/identity/register', undefined, { secret_key: key, handle });
      expect(res.ok).toBe(true);
    }
    client = await connect(ownerKey);
  }, 35000);
  afterAll(async () => { await Promise.all(clients.map(c => c.close().catch(() => {}))); child?.kill(); });

  it('requires owner authentication and explicit approval, saving no public entry', async () => {
    expect((await api('/api/posting-rules')).status).toBe(401);
    expect((await api(`/api/posting-rules?key=${ownerKey}`)).status).toBe(401);
    expect((await api('/api/posting-rules', ownerKey, { rules: draft, expected_revision: 0 })).status).toBe(400);
    const saved = await api('/api/posting-rules', ownerKey, { rules: draft, expected_revision: 0, confirmed: true });
    expect(saved.status).toBe(200);
    expect(saved.headers.get('cache-control')).toBe('no-store');
    expect((await saved.json()).rules.instructions).toBe(privateText);
    expect((await api('/api/posting-rules', otherKey).then(r => r.json())).rules).toBeNull();
    for (const path of [`/api/users/${owner}`, `/api/profile/${owner}`, '/api/users/search?q=rule', '/api/stats', '/api/posting-rules-guide', '/api/entries']) {
      const text = await api(path).then(r => r.text());
      expect(text).not.toContain('Keep my private wording');
      expect(text).not.toContain('"postingRules"');
    }
  });

  it('loads the exact saved choice in a new session and rejects stale automatic instructions', async () => {
    const fresh = await connect(ownerKey);
    const read = await call(fresh, 'router_posting_rules');
    expect(read.error).not.toBe(true);
    const rules = JSON.parse(read.text);
    expect(rules.rules.instructions).toBe(privateText);
    expect(rules.rules.mode).toBe('manual');
    const listing = await fresh.listTools();
    expect(listing.tools.find(t => t.name === 'router_write_entry')?.description).toContain('Only post when the person explicitly asks');
    expect((await call(fresh, 'router_write_entry', write)).error).toBe(true);
    expect((await api('/api/entries', undefined, { content: 'Blocked REST automatic post', secret_key: ownerKey })).status).toBe(409);
    const allowed = await call(fresh, 'router_write_entry', { ...write, posting_intent: 'user-requested' });
    expect(allowed.error).not.toBe(true);
    expect(allowed.text).toContain(`@${other}`);
    expect(await api('/api/entries').then(r => r.text())).not.toContain(write.entry);
    const outsider = await connect(otherKey);
    const outsiderTools = await outsider.listTools();
    expect(JSON.stringify(outsiderTools)).not.toContain('Keep my private wording');
  });

  it('rejects concurrent edits, keeps the existing text, and applies changes on an already-open connection', async () => {
    const saves = await Promise.all([
      api('/api/posting-rules', ownerKey, { rules: { ...draft, mode: 'review' }, expected_revision: 1, confirmed: true }),
      api('/api/posting-rules', ownerKey, { rules: { ...draft, mode: 'automatic' }, expected_revision: 1, confirmed: true }),
    ]);
    expect(saves.map(r => r.status).sort()).toEqual([200, 409]);
    const current = await api('/api/posting-rules', ownerKey).then(r => r.json());
    expect(current.rules.instructions).toBe(privateText);
    const saved = await call(client, 'router_posting_rules', { action: 'save', rules: { ...draft, mode: 'automatic' }, expected_revision: 2, confirmed: true });
    expect(saved.error).not.toBe(true);
    expect(JSON.parse(saved.text).revision).toBe(3);
    expect((await call(client, 'router_write_entry', { ...write, to: [] })).error).toBe(true);
    expect((await call(client, 'router_write_entry', write)).error).not.toBe(true);
  });

  it('applies the same rules to personal and group skill posts', async () => {
    expect((await call(client, 'router_skills', { action: 'create', name: 'rules_test', description: 'Synthetic test', instructions: 'A test', to: [`@${other}`] })).error).not.toBe(true);
    const groupId = `rules-${Date.now().toString(36)}`;
    const created = await api('/api/channels', undefined, { secret_key: ownerKey, id: groupId, name: 'Rules test', join_rule: 'open' });
    expect(created.ok).toBe(true);
    expect((await api(`/api/channels/${groupId}/skills`, undefined, { secret_key: ownerKey, name: 'note', description: 'Synthetic note', instructions: 'Test' })).ok).toBe(true);
    const current = await api('/api/posting-rules', ownerKey).then(r => r.json());
    expect((await call(client, 'router_posting_rules', { action: 'save', rules: { ...draft, mode: 'review' }, expected_revision: current.revision, confirmed: true })).error).not.toBe(true);
    expect((await call(client, 'skill_rules_test', { result: 'Blocked skill result' })).error).toBe(true);
    const blockedGroup = await call(client, `channel_${groupId}_note`, { result: 'Blocked group result' });
    expect(blockedGroup.error).toBe(true);
    expect(blockedGroup.text).toContain('require a draft');
    const personal = await call(client, 'skill_rules_test', { result: 'Requested synthetic skill result', posting_intent: 'user-requested' });
    expect(personal.error).not.toBe(true);
    const group = await call(client, `channel_${groupId}_note`, { result: 'Requested group result', posting_intent: 'user-requested' });
    expect(group.error, group.text).not.toBe(true);
  });

  it('serves the rules page and a guide that does not publish setup examples', async () => {
    expect((await api('/posting-rules')).status).toBe(200);
    const guide = await api('/api/posting-rules-guide').then(r => r.json());
    expect(guide.coach).toContain('Do not post the examples');
    expect(guide.installation).toContain('Preserve all unrelated instructions and my own edits');
    const tutorial = await api('/api/tutorial?client=code').then(r => r.json());
    expect(tutorial.prompt).toContain('router_posting_rules');
    expect(tutorial.prompt).not.toContain('Ambient capture');
  });

  it('does not let a saved group default outlive membership', async () => {
    const id = `former-${Date.now().toString(36)}`;
    expect((await api('/api/channels', undefined, { secret_key: otherKey, id, name: 'Membership check', join_rule: 'open' })).ok).toBe(true);
    expect((await api(`/api/channels/${id}/join`, undefined, { secret_key: ownerKey })).ok).toBe(true);
    const current = await api('/api/posting-rules', ownerKey).then(r => r.json());
    expect((await api('/api/posting-rules', ownerKey, { rules: { ...draft, mode: 'automatic', destinations: [`#${id}`] }, expected_revision: current.revision, confirmed: true })).ok).toBe(true);
    expect((await call(client, 'router_write_entry', write)).error).not.toBe(true);
    expect((await call(client, 'router_channels', { action: 'leave', channel_id: id })).error).not.toBe(true);
    const blocked = await call(client, 'router_write_entry', write);
    expect(blocked.error).toBe(true);
    expect(blocked.text).toContain('current group member');
    expect((await api('/api/entries', undefined, { secret_key: ownerKey, content: 'Also blocked over REST', posting_intent: 'user-requested' })).status).toBe(403);
  });
});
