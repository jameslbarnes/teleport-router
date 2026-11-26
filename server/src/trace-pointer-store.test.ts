import { describe, it, expect } from 'vitest';
import { tracePointerStore, tracePointers, TracePointerError } from './trace-pointer-store.js';
import type { JournalEntry } from './storage.js';

const SLICE = 'a'.repeat(64);
const entry = (id: string, handle: string, extra: Partial<JournalEntry> = {}) =>
  ({ id, handle, pseudonym: `pseudo-${handle}`, content: 'x', timestamp: 0, ...extra }) as JournalEntry;
const author = { pseudonym: 'pseudo-ann', handle: 'ann' };
const reader = { pseudonym: 'pseudo-bob', handle: 'bob' };
const stranger = { pseudonym: 'pseudo-eve', handle: 'eve' };

function setup(opts: { stored?: boolean | (() => Promise<boolean>) } = {}) {
  const legacy = { id: 'old', pseudonym: 'pseudo-old', content: 'x', timestamp: 0 } as JournalEntry;
  const posts = new Map([['p1', entry('p1', 'ann')], ['p2', entry('p2', 'ann')], ['old', legacy]]);
  // bob may read every post; eve none; the author all of hers.
  const canRead = new Set(['ann', 'bob']);
  let t = 1000;
  const svc = tracePointers({
    store: tracePointerStore(),
    getEntry: async id => posts.get(id) ?? null,
    visible: async (id, actor) => posts.get(id) && actor.handle && canRead.has(actor.handle) ? posts.get(id)! : null,
    storedTrace: opts.stored === undefined ? undefined : typeof opts.stored === 'function' ? opts.stored : async () => opts.stored as boolean,
    now: () => t++,
  });
  return svc;
}
const body = (entry_id: string, extra: Record<string, unknown> = {}) => ({ entry_id, agent: 'claude-code', slice_sha256: SLICE, ...extra });

describe('trace pointers', () => {
  it('lets the author register a pointer once; registering again changes nothing', async () => {
    const svc = setup();
    const first = await svc.register(author, body('p1'));
    expect(first).toMatchObject({ entry_id: 'p1', trace: 'held_locally', agent: 'claude-code', slice_sha256: SLICE, registered: true });
    const again = await svc.register(author, body('p1', { agent: 'codex', slice_sha256: 'b'.repeat(64) }));
    expect(again).toMatchObject({ trace: 'held_locally', agent: 'claude-code', slice_sha256: SLICE, registered: false, registered_at: (first as { registered_at?: number }).registered_at });
  });

  it('refuses anyone but the author, with the same answer as for a missing post', async () => {
    const svc = setup();
    const errorOf = (p: Promise<unknown>) => p.then(() => null, e => e as TracePointerError);
    const notYours = await errorOf(svc.register(reader, body('p1')));
    const missing = await errorOf(svc.register(author, body('nope')));
    expect(notYours).toBeInstanceOf(TracePointerError);
    expect([notYours!.status, notYours!.message]).toEqual([missing!.status, missing!.message]);
    expect(notYours!.status).toBe(404);
    expect((await svc.status(author, 'p1')).trace).toBeNull();
  });

  it('checks what is registered', async () => {
    const svc = setup();
    await expect(svc.register(author, body('p1', { agent: 'other' }))).rejects.toThrow(/agent must be/);
    await expect(svc.register(author, body('p1', { slice_sha256: 'XYZ' }))).rejects.toThrow(/slice_sha256/);
    await expect(svc.register(author, body('../p1'))).rejects.toThrow(/entry_id/);
  });

  it('an upload upgrades the pointer, and a pointer never downgrades an upload', async () => {
    const svc = setup();
    await svc.register(author, body('p1'));
    await svc.markUploaded(entry('p1', 'ann'));
    expect(await svc.status(author, 'p1')).toMatchObject({ trace: 'uploaded', agent: 'claude-code', slice_sha256: SLICE });
    expect((await svc.register(author, body('p1'))).trace).toBe('uploaded');
    // An upload with no pointer before it gets a record too.
    await svc.markUploaded(entry('p2', 'ann'));
    expect((await svc.register(author, body('p2'))).trace).toBe('uploaded');
    expect(await svc.stateOf('p2')).toBe('uploaded');
  });

  it('records a trace that is already in the author\'s storage as uploaded', async () => {
    expect((await setup({ stored: true }).register(author, body('p1'))).trace).toBe('uploaded');
    expect((await setup({ stored: false }).register(author, body('p1'))).trace).toBe('held_locally');
  });

  it('on a post with a handle, a different account with the same legacy name is refused', async () => {
    const svc = setup();
    // The author's legacy name, with another handle or none.
    for (const other of [{ pseudonym: 'pseudo-ann', handle: 'bob', registered: true }, { pseudonym: 'pseudo-ann', handle: null, registered: true }, { pseudonym: 'pseudo-ann' }]) {
      await expect(svc.register(other, body('p1'))).rejects.toMatchObject({ status: 404 });
    }
    await svc.register(author, body('p1'));
    // bob may read the post; he does not get the fingerprint.
    expect(await svc.status({ pseudonym: 'pseudo-ann', handle: 'bob', registered: true }, 'p1')).not.toHaveProperty('slice_sha256');
  });

  it('on a legacy post with no handle, accepts its legacy name only from a registered account', async () => {
    const svc = setup();
    await expect(svc.register({ pseudonym: 'pseudo-old' }, body('old'))).rejects.toMatchObject({ status: 404 });
    await expect(svc.register({ pseudonym: 'pseudo-old', registered: false }, body('old'))).rejects.toMatchObject({ status: 404 });
    await expect(svc.register({ pseudonym: 'pseudo-other', registered: true }, body('old'))).rejects.toMatchObject({ status: 404 });
    expect((await svc.register({ pseudonym: 'pseudo-old', registered: true }, body('old'))).registered).toBe(true);
  });

  it('records nothing when it cannot tell whether an older trace was uploaded, and tries again next time', async () => {
    let calls = 0;
    const svc = setup({ stored: async () => { if (calls++ === 0) throw new Error('storage unreachable'); return true; } });
    await expect(svc.register(author, body('p1'))).rejects.toMatchObject({ status: 503 });
    expect((await svc.status(author, 'p1')).trace).toBeNull();
    expect(await svc.register(author, body('p1'))).toMatchObject({ trace: 'uploaded', registered: true });
  });

  it('tells readers whether a trace exists and where, but not its fingerprint; tells others nothing', async () => {
    const svc = setup();
    await svc.register(author, body('p1'));
    const seen = await svc.status(reader, 'p1');
    expect(seen).toMatchObject({ entry_id: 'p1', trace: 'held_locally', agent: 'claude-code' });
    expect(seen).not.toHaveProperty('slice_sha256');
    expect(await svc.status(author, 'p1')).toHaveProperty('slice_sha256', SLICE);
    expect(await svc.status(reader, 'p2')).toEqual({ entry_id: 'p2', trace: null });
    const hidden = await svc.status(stranger, 'p1').then(() => null, e => e);
    const absent = await svc.status(stranger, 'nope').then(() => null, e => e);
    expect([hidden.status, hidden.message]).toEqual([absent.status, absent.message]);
  });
});
