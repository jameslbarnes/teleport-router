import { describe, expect, it } from 'vitest';
import { sharingReceipt, formatSharingReceipt } from './sharing-receipt.js';
import type { JournalEntry } from './storage.js';

const entry: JournalEntry = { id: 'note-1', pseudonym: 'Writer', client: 'code', content: 'Exact text.\nSecond line.', timestamp: 1000, publishAt: 2000 };

describe('Sharing receipts', () => {
  it('reports the actual waiting state even after the deadline, without claiming notification evidence', () => {
    const receipt = sharingReceipt(entry, 'https://router.test/', true);
    expect(receipt).toMatchObject({ state: 'pending', publish_at: 2000, content: entry.content, notification_evidence: null, review_url: 'https://router.test/e/note-1#manage' });
    expect(receipt.audience).toContain('anyone on the internet');
    expect(formatSharingReceipt(receipt)).toContain('1970-01-01T00:00:02.000Z');
  });
  it('reports every addressed destination and normalizes the legacy channel without duplicates', () => {
    const receipt = sharingReceipt({ ...entry, to: ['#aria', '@reader'], channel: 'aria', aiOnly: true }, 'https://router.test', true);
    expect(receipt.destinations).toEqual(['#aria', '@reader']);
    expect(receipt.audience).toBe('Only: #aria, @reader');
    expect(sharingReceipt({ ...entry, aiOnly: true }, 'https://router.test', false).audience).toContain('Public Router');
    expect(sharingReceipt({ ...entry, visibility: 'private' }, 'https://router.test', false).audience).toBe('Only you — private post');
  });
  it('does not invent a countdown for held, removed or already published entries', () => {
    expect(sharingReceipt({ ...entry, moderationHeld: true }, 'https://router.test', true)).toMatchObject({ state: 'held', publish_at: null });
    expect(sharingReceipt(entry, 'https://router.test', true, true)).toMatchObject({ state: 'removed', publish_at: null });
    expect(sharingReceipt(entry, 'https://router.test', false)).toMatchObject({ state: 'published', publish_at: null });
  });
});
