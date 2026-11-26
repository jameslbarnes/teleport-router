import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { generateSecretKey } from './identity.js';

// A trace pointer says that a post's trace exists and is held on its author's machine. Only the author may
// register one; exactly the people who can read the post may see it, through the API and router_get_entry.
const port = 15000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const author = { key: generateSecretKey(), handle: `ptra${tag}` };
const member = { key: generateSecretKey(), handle: `ptrm${tag}` };
const leaver = { key: generateSecretKey(), handle: `ptrl${tag}` };
const outsider = { key: generateSecretKey(), handle: `ptro${tag}` };
const group = `ptrg-${tag}`;
const SLICE = 'c'.repeat(64);
let child: ChildProcess;
let groupPost: any, publicPost: any;

async function api(path: string, body?: unknown, key?: string, method?: string) {
  return fetch(base + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const register = (entry_id: string, key?: string) => api('/api/trace-pointers', { entry_id, agent: 'claude-code', slice_sha256: SLICE }, key);
const status = (entry_id: string, key?: string) => api(`/api/trace-pointers?entry=${encodeURIComponent(entry_id)}`, undefined, key);
async function publish(receipt: any, key: string) {
  if (receipt.notification_required) {
    expect((await api(`/api/entries/${receipt.entry_id}/notice`, { notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
      evidence_kind: 'agent_reported', conversation_ref: 'synthetic-pointer-test:notice' }, key)).ok).toBe(true);
  }
  expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, key)).ok).toBe(true);
}
async function getEntryTool(key: string, id: string) {
  const client = new Client({ name: 'trace-pointer-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  try { return await client.callTool({ name: 'router_get_entry', arguments: { entry_id: id } }); } finally { await client.close(); }
}

describe('trace pointers through the server', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '',
        MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', SENDGRID_API_KEY: '', ANTHROPIC_API_KEY: '',
        FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '' },
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
    for (const user of [author, member, leaver, outsider]) expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    expect((await api('/api/channels', { secret_key: author.key, id: group, name: 'Private pointer test group', visibility: 'private', join_rule: 'invite', storage: 'router' })).ok).toBe(true);
    for (const user of [member, leaver]) {
      const invite = await (await api(`/api/channels/${group}/invite`, { secret_key: author.key, max_uses: 1 })).json() as { token: string };
      expect((await api(`/api/channels/${group}/join`, { secret_key: user.key, invite_token: invite.token })).ok).toBe(true);
    }
    const write = async (content: string, to: string[]) => {
      const res = await api('/api/entries', { secret_key: author.key, content, to, posting_intent: 'user-requested' });
      expect(res.ok).toBe(true);
      return (await res.json()).receipt;
    };
    groupPost = await write(`Group note with a trace ${tag}`, [`#${group}`]);
    publicPost = await write(`Public note with a trace ${tag}`, []);
  }, 120000);
  afterAll(() => { child?.kill(); });

  it('lets the author register a pointer for a waiting note, and shows it to the author only', async () => {
    const res = await register(groupPost.entry_id, author.key);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ trace: 'held_locally', agent: 'claude-code', slice_sha256: SLICE, registered: true });
    expect(await (await status(groupPost.entry_id, author.key)).json()).toMatchObject({ trace: 'held_locally', slice_sha256: SLICE });
    for (const key of [member.key, outsider.key, undefined]) expect((await status(groupPost.entry_id, key)).status).toBe(404);
  });

  it('refuses a pointer from anyone but the author, and from nobody signed in', async () => {
    expect((await register(publicPost.entry_id, member.key)).status).toBe(404);
    expect((await register(groupPost.entry_id, member.key)).status).toBe(404);
    expect((await register(publicPost.entry_id)).status).toBe(401);
    expect(await (await status(publicPost.entry_id, author.key)).json()).toEqual({ entry_id: publicPost.entry_id, trace: null });
  });

  it('treats registering again as a no-op', async () => {
    const again = await register(groupPost.entry_id, author.key);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ trace: 'held_locally', registered: false });
  });

  it('shows a private group note\'s pointer to current members, without its fingerprint, and to nobody else', async () => {
    await publish(groupPost, author.key);
    const seen = await (await status(groupPost.entry_id, member.key)).json();
    expect(seen).toMatchObject({ entry_id: groupPost.entry_id, trace: 'held_locally', agent: 'claude-code' });
    expect(seen).not.toHaveProperty('slice_sha256');
    const viaTool = await getEntryTool(member.key, groupPost.entry_id);
    expect(viaTool.isError).not.toBe(true);
    expect((viaTool.structuredContent as any).trace_state).toBe('held_locally');
    expect(JSON.stringify(viaTool.content)).toContain('held on the author');
    for (const key of [outsider.key, undefined]) expect((await status(groupPost.entry_id, key)).status).toBe(404);
    expect((await getEntryTool(outsider.key, groupPost.entry_id)).isError).toBe(true);
  });

  it('stops showing it to a member once removed', async () => {
    expect((await status(groupPost.entry_id, leaver.key)).status).toBe(200);
    expect((await api(`/api/channels/${group}/remove-member`, { handle: leaver.handle }, author.key)).ok).toBe(true);
    expect((await status(groupPost.entry_id, leaver.key)).status).toBe(404);
  });

  it('shows a public note\'s pointer to anyone once it publishes', async () => {
    expect((await register(publicPost.entry_id, author.key)).status).toBe(200);
    expect((await status(publicPost.entry_id)).status).toBe(404);
    await publish(publicPost, author.key);
    expect(await (await status(publicPost.entry_id)).json()).toMatchObject({ trace: 'held_locally', agent: 'claude-code' });
    expect((await status('no-such-post', outsider.key)).status).toBe(404);
  });
});
