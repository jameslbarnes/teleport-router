import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';

// One person's notes page by (timestamp, id) on /api/entries/<handle or pseudonym> and /api/users/<handle>/entries.
// Every page applies the first page's visibility, and pages and cursors are made from visible notes alone.
// The server's clock is rounded to whole seconds so that many notes share a timestamp.
const port = 15000 + Math.floor(Math.random() * 5000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const author = { key: generateSecretKey(), handle: `pa${tag}` };
const member = { key: generateSecretKey(), handle: `pm${tag}` };
const removed = { key: generateSecretKey(), handle: `pr${tag}` };
const outsider = { key: generateSecretKey(), handle: `po${tag}` };
const group = `paging-${tag}`;
const coarseClock = 'data:text/javascript,' + encodeURIComponent('const now = Date.now; Date.now = () => Math.floor(now() / 1000) * 1000;');
let child: ChildProcess;

type Kind = 'public' | 'group' | 'direct' | 'waiting';
type Note = { id: string; timestamp: number; content: string };
const created = new Map<Kind, string[]>([['public', []], ['group', []], ['direct', []], ['waiting', []]]);
let authorPseudonym = '';

async function api(path: string, body?: unknown, key?: string, method?: string) {
  return fetch(base + path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function post(kind: Kind, n: number) {
  const to = kind === 'group' ? [`#${group}`] : kind === 'direct' ? [`@${member.handle}`] : [];
  const res = await api('/api/entries', { secret_key: author.key, content: `${kind} note ${n}`, to, posting_intent: 'user-requested' });
  expect(res.ok).toBe(true);
  const receipt = (await res.json()).receipt;
  created.get(kind)!.push(receipt.entry_id);
  if (kind === 'waiting') return;
  if (receipt.notification_required) {
    expect((await api(`/api/entries/${receipt.entry_id}/notice`, {
      notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
      evidence_kind: 'agent_reported', conversation_ref: 'synthetic-paging-test:notice',
    }, author.key)).ok).toBe(true);
  }
  expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, author.key)).ok).toBe(true);
}

/** Every page of a list, following nextCursor; the notes and each cursor in order. */
async function walk(path: string, key?: string, limit?: number) {
  const ids: string[] = [];
  const notes: Note[] = [];
  const cursors: (string | null)[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 500; guard++) {
    const query = new URLSearchParams();
    if (limit) query.set('limit', String(limit));
    if (cursor) query.set('cursor', cursor);
    const res = await api(`${path}?${query}`, undefined, key);
    expect(res.status).toBe(200);
    const body = await res.json() as { entries: Note[]; nextCursor: string | null };
    expect(body).toHaveProperty('nextCursor');
    notes.push(...body.entries);
    ids.push(...body.entries.map(e => e.id));
    pageSizes.push(body.entries.length);
    cursors.push(body.nextCursor);
    if (!body.nextCursor) return { ids, notes, cursors, pageSizes };
    // A cursor is only ever handed out with a full page.
    expect(body.entries.length).toBe(limit ?? (path.startsWith('/api/users/') ? 100 : 50));
    cursor = body.nextCursor;
  }
  throw new Error('paging did not end');
}

const newestFirst = (a: Note, b: Note) => b.timestamp - a.timestamp || Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));
const sortedIds = (notes: Note[]) => [...notes].sort(newestFirst).map(n => n.id);
const only = (kinds: Kind[]) => (ids: string[]) => ids.filter(id => kinds.some(k => created.get(k)!.includes(id)));

describe('paging one person\'s notes', () => {
  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', '--import', coarseClock, 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000',
        TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', ANTHROPIC_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`Isolated paging test server did not start (exit ${child.exitCode}): ${startupOutput}`);

    for (const user of [author, member, removed, outsider]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    expect((await api('/api/channels', { secret_key: author.key, id: group, name: 'Paging test group', visibility: 'private', join_rule: 'invite' })).ok).toBe(true);
    for (const user of [member, removed]) {
      const invite = await api(`/api/channels/${group}/invite`, { secret_key: author.key, max_uses: 1 }).then(r => r.json());
      expect((await api(`/api/channels/${group}/join`, { secret_key: user.key, invite_token: invite.token })).ok).toBe(true);
    }

    // 270 notes, hidden ones between public ones, several at a time so many share a timestamp.
    const plan: Kind[] = Array.from({ length: 270 }, (_, i) =>
      i % 12 === 3 ? 'group' : i % 12 === 7 ? 'direct' : i % 40 === 11 ? 'waiting' : 'public');
    for (let i = 0; i < plan.length; i += 6) {
      await Promise.all(plan.slice(i, i + 6).map((kind, j) => post(kind, i + j)));
    }
    // Removed after the group notes were written.
    expect((await api(`/api/channels/${group}/remove-member`, { handle: removed.handle }, author.key)).ok).toBe(true);
    const own = await api(`/api/entries/${author.handle}?limit=1`, undefined, author.key).then(r => r.json());
    authorPseudonym = own.entries[0].pseudonym;
    expect(authorPseudonym).toBeTruthy();
  }, 180000);

  afterAll(() => { child?.kill(); });

  it('returns each public note exactly once, in order, across more than 200 notes with equal timestamps', async () => {
    expect(created.get('public')!.length).toBeGreaterThan(200);
    const all = await walk(`/api/users/${author.handle}/entries`, undefined, 200);
    expect(all.pageSizes).toEqual([200, created.get('public')!.length - 200]);
    expect(new Set(all.ids).size).toBe(all.ids.length);
    expect([...all.ids].sort()).toEqual([...created.get('public')!].sort());
    expect(all.ids).toEqual(sortedIds(all.notes));
    // Many notes share a timestamp, and pages break inside such groups.
    const stamps = all.notes.map(n => n.timestamp);
    expect(new Set(stamps).size).toBeLessThan(stamps.length / 4);

    const small = await walk(`/api/users/${author.handle}/entries`, undefined, 7);
    expect(small.ids).toEqual(all.ids);
    const byHandle = await walk(`/api/entries/${author.handle}`, undefined, 7);
    expect(byHandle.ids).toEqual(all.ids);
    expect(byHandle.cursors).toEqual(small.cursors);
  });

  it('shows group and direct notes to a current member on every page, and nothing hidden to anyone else', async () => {
    const publicIds = (await walk(`/api/users/${author.handle}/entries`, undefined, 200)).ids;
    const asMember = await walk(`/api/entries/${author.handle}`, member.key, 9);
    expect(new Set(asMember.ids).size).toBe(asMember.ids.length);
    expect([...asMember.ids].sort()).toEqual([...created.get('public')!, ...created.get('group')!, ...created.get('direct')!].sort());
    expect(asMember.ids).toEqual(sortedIds(asMember.notes));
    // Group notes appear well past the first page.
    expect(only(['group'])(asMember.ids.slice(50)).length).toBeGreaterThan(5);

    for (const reader of [undefined, outsider.key, removed.key]) {
      const seen = await walk(`/api/entries/${author.handle}`, reader, 9);
      expect(seen.ids).toEqual(publicIds);
      expect(only(['group', 'direct', 'waiting'])(seen.ids)).toEqual([]);
    }
  });

  it('shows waiting notes only to their author, on later pages too', async () => {
    const asAuthor = await walk(`/api/entries/${encodeURIComponent(authorPseudonym)}`, author.key, 11);
    expect([...asAuthor.ids].sort()).toEqual([...created.values()].flat().sort());
    expect(asAuthor.ids).toEqual(sortedIds(asAuthor.notes));
    expect(only(['waiting'])(asAuthor.ids.slice(30)).length).toBeGreaterThan(0);
    for (const reader of [undefined, member.key, removed.key, outsider.key]) {
      const seen = await walk(`/api/entries/${encodeURIComponent(authorPseudonym)}`, reader, 11);
      expect(only(['waiting'])(seen.ids)).toEqual([]);
    }
    // By handle, waiting notes are left out for everyone, as before.
    expect(only(['waiting'])((await walk(`/api/entries/${author.handle}`, author.key, 11)).ids)).toEqual([]);
  });

  it('rejects a malformed cursor with 400 and treats an empty one as the first page', async () => {
    const bad = ['garbage!!', Buffer.from('not json').toString('base64url'), Buffer.from('{"t":"1","id":"x"}').toString('base64url'),
      Buffer.from('{"t":1,"id":""}').toString('base64url'), 'x'.repeat(2000),
      ...['a/b', '.', '..', '__name__', 'x'.repeat(600)].map(id => Buffer.from(JSON.stringify({ t: 1, id })).toString('base64url'))];
    for (const path of [`/api/entries/${author.handle}`, `/api/users/${author.handle}/entries`]) {
      for (const cursor of bad) {
        const res = await api(`${path}?cursor=${encodeURIComponent(cursor)}`);
        expect(res.status).toBe(400);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(await res.json()).toEqual({ error: 'Invalid cursor' });
      }
      const empty = await api(`${path}?cursor=&limit=5`).then(r => r.json());
      const first = await api(`${path}?limit=5`).then(r => r.json());
      expect(empty.entries.map((e: Note) => e.id)).toEqual(first.entries.map((e: Note) => e.id));
      expect(empty.nextCursor).toBe(first.nextCursor);
    }
  });

  // Last: it deletes the hidden notes.
  it('gives an outsider the same pages and cursors whether or not hidden notes sit between visible ones', async () => {
    const views = async () => ({
      outsider: await walk(`/api/entries/${author.handle}`, outsider.key, 7),
      removed: await walk(`/api/entries/${author.handle}`, removed.key, 13),
      signedOut: await walk(`/api/entries/${author.handle}`, undefined, 50),
      profile: await walk(`/api/users/${author.handle}/entries`, undefined, 7),
      byPseudonym: await walk(`/api/entries/${encodeURIComponent(authorPseudonym)}`, outsider.key, 7),
    });
    const withHidden = await views();
    for (const kind of ['group', 'direct', 'waiting'] as Kind[]) {
      for (const id of created.get(kind)!) {
        expect((await api(`/api/entries/${id}`, undefined, author.key, 'DELETE')).ok).toBe(true);
      }
    }
    // The hidden notes are gone: the member now sees only public notes.
    expect((await walk(`/api/entries/${author.handle}`, member.key, 9)).ids).toEqual(withHidden.signedOut.ids);
    const withoutHidden = await views();
    expect(withoutHidden).toEqual(withHidden);
  });
});
