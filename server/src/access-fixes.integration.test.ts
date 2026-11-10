import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import jwt from 'jsonwebtoken';
import { generateSecretKey } from './identity.js';

// An address someone merely typed must not open notes sent to it, email links must not be
// forgeable with the secret that sits in public source, and maintenance routes need a moderator.
const port = 21000 + Math.floor(Math.random() * 4000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const SECRET = 'test-only-token-secret-' + tag.repeat(4);
const LEGACY = 'router-default-secret-change-in-production';
const sender = { key: generateSecretKey(), handle: `send${tag}` };
const owner = { key: generateSecretKey(), handle: `ownr${tag}` };
const impostor = { key: generateSecretKey(), handle: `impo${tag}` };
const moderator = { key: generateSecretKey(), handle: `modr${tag}` };
const address = `owner-${tag}@example.com`;
const note = `Private note for one address ${tag}`;
let child: ChildProcess;

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const inbox = async (key: string) => {
  const res = await api(`/api/inbox?key=${key}&limit=50`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { entries: { content: string }[] }).entries.map(e => e.content);
};
const claim = (key: string, email: string) => api('/api/send-verification', { key, email });
const link = (handle: string, email: string, secret: string) =>
  api(`/api/verify-email?token=${encodeURIComponent(jwt.sign({ handle, email, purpose: 'verify-email' }, secret, { expiresIn: '1h' }))}`);

describe('Access that depends on proof, not on a claim', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', JWT_SECRET: SECRET,
        MODERATOR_HANDLES: moderator.handle, TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', SENDGRID_API_KEY: '', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 300; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 300));
    }
    if (!ready) throw new Error(`Test server did not start (exit ${child.exitCode}): ${startupOutput}`);
    for (const user of [sender, owner, impostor, moderator]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    const posted = await api('/api/entries', { secret_key: sender.key, content: note, to: [address], posting_intent: 'user-requested' });
    expect(posted.ok).toBe(true);
    const receipt = (await posted.json()) as { receipt?: any; entry_id?: string; notice_id?: string };
    const r = receipt.receipt || receipt;
    if (r.notification_required) {
      expect((await api(`/api/entries/${r.entry_id}/notice`, { notice_id: r.notice_id, notice_sha256: r.notice_sha256, evidence_kind: 'agent_reported', conversation_ref: 'local-test:notice' }, sender.key)).ok).toBe(true);
    }
    expect((await api(`/api/entries/${r.entry_id}/publish`, {}, sender.key)).ok).toBe(true);
  }, 120000);
  afterAll(() => { child?.kill(); });

  it('does not show a note to an account that only claimed the address', async () => {
    await claim(impostor.key, address); // stored as unverified whether or not an email could be sent
    expect(await inbox(impostor.key)).not.toContain(note);
    const search = await api(`/api/search?q=${tag}&limit=20&key=${impostor.key}`);
    expect(JSON.stringify(await search.json())).not.toContain(note);
  });

  it('rejects a verification link signed with the secret from public source', async () => {
    expect((await link(impostor.handle, address, LEGACY)).ok).toBe(false);
    expect(await inbox(impostor.key)).not.toContain(note);
  });

  it('shows the note once the address is proven with a real link', async () => {
    await claim(owner.key, address);
    expect(await inbox(owner.key)).not.toContain(note);
    expect((await link(owner.handle, address, SECRET)).ok).toBe(true);
    expect(await inbox(owner.key)).toContain(note);
  });

  it('keeps the maintenance routes for moderators', async () => {
    for (const key of [undefined, impostor.key]) {
      expect((await api('/api/admin/unmigrated', undefined, key)).status).toBe(403);
      expect((await api('/api/admin/migrate-all', {}, key)).status).toBe(403);
    }
    expect((await api('/api/admin/unmigrated', undefined, moderator.key)).status).toBe(200);
  });
});
