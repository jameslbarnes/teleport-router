import { describe, expect, it, vi } from 'vitest';
import { MemoryStorage, StagedStorage } from './storage.js';
import { announcePlatformEntry } from './platform-sharing-notice.js';

describe('Platform-originated public writes', () => {
  it('records delivery only after the exact notice is sent in the source conversation', async () => {
    const storage = new StagedStorage(3600000, new MemoryStorage(), 'https://router.test');
    try {
      const entry = await storage.addEntry({ pseudonym: 'test', client: 'code', content: 'Exact Matrix reply\nSecond line.', timestamp: Date.now() });
      const send = vi.fn(async (text: string) => {
        if (text.includes('Exact Matrix reply')) expect((await storage.getEntry(entry.id))?.sharingNotice?.evidence).toBeUndefined();
        return 'matrix:room:event';
      });
      await expect(storage.publishEntry(entry.id)).rejects.toThrow('notice');
      await announcePlatformEntry(entry, storage, 'https://router.test', send);
      expect(send.mock.calls[0][0]).toContain('Public Router');
      expect(send.mock.calls[0][0]).toContain('> Exact Matrix reply\n> Second line.');
      expect(send.mock.calls[0][0]).toContain(`/e/${entry.id}#manage`);
      expect(entry.sharingNotice?.evidence?.kind).toBe('agent_reported');
      expect(send.mock.calls[1][0]).toContain('scheduled for');
      expect((await storage.publishEntry(entry.id))?.id).toBe(entry.id);
    } finally { storage.stop(); }
  });

  it('leaves a post gated when delivery fails', async () => {
    const storage = new StagedStorage(3600000, new MemoryStorage(), 'https://router.test');
    try {
      const entry = await storage.addEntry({ pseudonym: 'test', client: 'code', content: 'Delivery failure', timestamp: Date.now() });
      await expect(announcePlatformEntry(entry, storage, 'https://router.test', async () => { throw new Error('send failed'); })).rejects.toThrow('send failed');
      expect(entry.sharingNotice?.evidence).toBeUndefined();
      await expect(storage.publishEntry(entry.id)).rejects.toThrow('notice');
    } finally { storage.stop(); }
  });
});
