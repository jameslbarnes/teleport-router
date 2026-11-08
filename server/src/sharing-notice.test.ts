import { afterEach, describe, expect, it, vi } from 'vitest';
import { FirestoreStorage, MemoryStorage, StagedStorage, type JournalEntry } from './storage.js';
import { sharingReceipt } from './sharing-receipt.js';

const stores: StagedStorage[] = [];
function make(delay = 60000) { const s = new StagedStorage(delay, new MemoryStorage(), 'https://router.test'); stores.push(s); return s; }
const post = () => ({ pseudonym: 'Test Author', client: 'code' as const, content: 'Synthetic notice test.', timestamp: Date.now() });
function ack(s: StagedStorage, entry: JournalEntry) {
  return s.recordSharingNotice(entry.id, { notice_id: entry.sharingNotice!.id, notice_sha256: entry.sharingNotice!.sha256,
    conversation_ref: 'test-conversation:message', evidence_kind: 'agent_reported' });
}
afterEach(() => { stores.splice(0).forEach(s => s.stop()); vi.useRealTimers(); });

describe('Public notice publication gate', () => {
  it('blocks timed, manual and recovered publication without notice, then starts a full window once', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000000);
    const original = make(), entry = await original.addEntry(post());
    await vi.advanceTimersByTimeAsync(120000);
    expect(original.isPending(entry.id)).toBe(true);
    await expect(original.publishEntry(entry.id)).rejects.toThrow('sharing notice');
    const restored = make(); restored.restorePendingState(JSON.parse(JSON.stringify(original.getPendingState())));
    await expect(restored.publishEntry(entry.id)).rejects.toThrow('sharing notice');
    const recovered = (await restored.getEntry(entry.id))!;
    ack(restored, recovered); const deadline = Date.now() + 60000;
    expect(recovered.publishAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(10000); ack(restored, recovered);
    expect(recovered.publishAt).toBe(deadline);
    await vi.advanceTimersByTimeAsync(50000);
    expect(restored.isPending(entry.id)).toBe(false);
    expect((await restored.getEntry(entry.id))?.sharingNotice?.evidence?.kind).toBe('agent_reported');
  });
  it('binds text and audience, survives a moderation hold, and permits deletion without a record', async () => {
    const s = make(), entry = await s.addEntry(post());
    const original = entry.content; entry.content = 'Changed';
    expect(() => ack(s, entry)).toThrow('does not match'); entry.content = original;
    entry.to = ['@other']; expect(() => ack(s, entry)).toThrow('does not match'); delete entry.to;
    s.holdEntry(entry.id, 'test', Date.now() + 999999999, 'automated');
    ack(s, entry); expect(entry.moderationHeld).toBe(true);
    expect(entry.scheduledPublishAt).toBeGreaterThan(Date.now());
    expect(s.releaseHold(entry.id)).toBe(entry.publishAt);
    const other = await s.addEntry(post()); await s.deleteEntry(other.id);
    expect(await s.getEntry(other.id)).toBeNull();
    expect(() => ack(s, other)).toThrow('no longer pending');
  });
  it('keeps private groups and previously queued posts on their existing schedule', async () => {
    const s = make(); const group = await s.addEntry({ ...post(), to: ['#private'] });
    expect(sharingReceipt(group, 'https://router.test', true).notification_required).toBe(false);
    expect((await s.publishEntry(group.id))?.id).toBe(group.id);
    s.restorePendingState({ entries: [{ ...post(), id: 'legacy', publishAt: Date.now() - 1 }], conversations: [] });
    expect((await s.publishEntry('legacy'))?.id).toBe('legacy');
  });

  it('persists the reported record in the Firestore document as well as returning it', async () => {
    const s = make(), entry = await s.addEntry(post()); ack(s, entry);
    const set = vi.fn().mockResolvedValue(undefined);
    const firestore = Object.create(FirestoreStorage.prototype) as FirestoreStorage;
    Object.assign(firestore, { db: { collection: () => ({ doc: () => ({ set }) }) }, collection: 'test' });
    await firestore.addEntry(entry);
    expect(set.mock.calls[0][0].sharingNotice).toEqual(entry.sharingNotice);
  });
});
