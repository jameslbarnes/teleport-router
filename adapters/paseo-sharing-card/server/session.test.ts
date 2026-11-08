import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { CardSession } from './session';
import type { Receipt } from '../shared/card';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const receipt: Receipt = {
  version: 1, entry_id: 'test-post', state: 'awaiting_notice', audience: 'Public Router', destinations: [],
  content: 'A disposable test.', publish_at: null, review_url: 'http://127.0.0.1:18571/e/test-post#manage',
  notification_evidence: null, notification_required: true,
  notice_id: 'notice-1', notice_sha256: 'a'.repeat(64), delay_after_notice_ms: 3600000,
};
async function fixture(request: typeof fetch, base = 'http://127.0.0.1:18571') {
  const root = await mkdtemp(join(tmpdir(), 'router-card-test-')); roots.push(root);
  const file = join(root, 'session.json');
  await writeFile(file, JSON.stringify({ agent_id: 'conversation', mode: 'test', base_url: base, router_key: 'k'.repeat(40),
    card: { version: 1, test: true, updated_at: 0, receipts: [receipt] } }));
  return { service: new CardSession(file, request), file };
}
test('rejects another conversation, unknown post, and mismatched notice without making a request', async () => {
  const request = vi.fn<typeof fetch>(); const { service } = await fixture(request);
  await expect(service.read('other')).rejects.toThrow('different conversation');
  await expect(service.delete('conversation', 'other')).rejects.toThrow('not part');
  await expect(service.rendered('conversation', 'test-post', 'wrong', receipt.notice_sha256!)).rejects.toThrow('does not match');
  expect(request).not.toHaveBeenCalled();
});
test('refuses production and credential-bearing destinations', async () => {
  for (const base of ['https://router.teleport.computer', 'http://x:y@127.0.0.1:18571', 'http://127.0.0.1:18571/proxy']) {
    const { service } = await fixture(vi.fn<typeof fetch>(), base);
    await expect(service.read('conversation')).rejects.toThrow('loopback');
  }
});
test('read never acknowledges a notice and does not return credentials', async () => {
  const request = vi.fn<typeof fetch>(); const { service } = await fixture(request);
  const card = await service.read('conversation');
  expect(card.receipts[0].state).toBe('awaiting_notice');
  expect(JSON.stringify(card)).not.toContain('k'.repeat(40));
  expect(request).not.toHaveBeenCalled();
});
test('records client-reported evidence once with the bound notice and server schedule', async () => {
  const recorded = { ...receipt, state: 'pending', notification_required: false, publish_at: 123456789,
    notification_evidence: { kind: 'client_reported', recorded_at: 1, conversation_ref_sha256: 'b'.repeat(64) } };
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ receipt: recorded }));
  const { service } = await fixture(request);
  const card = await service.rendered('conversation', receipt.entry_id, receipt.notice_id!, receipt.notice_sha256!);
  expect(card.receipts[0].publish_at).toBe(123456789);
  expect(JSON.parse(request.mock.calls[0][1]?.body as string)).toMatchObject({ evidence_kind: 'client_reported', notice_sha256: receipt.notice_sha256 });
  await service.rendered('conversation', receipt.entry_id, receipt.notice_id!, receipt.notice_sha256!);
  expect(request).toHaveBeenCalledTimes(1);
});
test('failed deletion preserves the real state; retry confirms deletion and persists it', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('failed', { status: 503 }))
    .mockResolvedValueOnce(Response.json({ success: true }));
  const { service, file } = await fixture(request);
  await expect(service.delete('conversation', receipt.entry_id)).rejects.toThrow('503');
  expect((await service.read('conversation')).receipts[0].state).toBe('awaiting_notice');
  expect((await service.delete('conversation', receipt.entry_id)).receipts[0].state).toBe('removed');
  expect(JSON.parse(await readFile(file, 'utf8')).card.receipts[0].notification_required).toBe(false);
  await service.delete('conversation', receipt.entry_id);
  expect(request).toHaveBeenCalledTimes(2);
});
test('deletion winning a race cannot be undone by a delayed layout report', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true }));
  const { service } = await fixture(request);
  const [deleted, reported] = await Promise.all([
    service.delete('conversation', receipt.entry_id),
    service.rendered('conversation', receipt.entry_id, receipt.notice_id!, receipt.notice_sha256!),
  ]);
  expect(deleted.receipts[0].state).toBe('removed');
  expect(reported.receipts[0].state).toBe('removed');
  expect(request).toHaveBeenCalledTimes(1);
});
test('refresh detects a post removed outside the card', async () => {
  const { service } = await fixture(vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 404 })));
  expect((await service.refresh('conversation')).receipts[0].state).toBe('removed');
});

test('production is an explicit host configuration, with a fixed HTTPS origin and no client credentials', async () => {
  const request = vi.fn<typeof fetch>(); const { service, file } = await fixture(request);
  const config = JSON.parse(await readFile(file, 'utf8'));
  config.mode = 'production'; config.base_url = 'https://router.teleport.computer'; config.card.test = false;
  const key = config.router_key;
  config.key_file = file + '.key'; await writeFile(config.key_file, key);
  delete config.router_key;
  config.card.receipts = [];
  await writeFile(file, JSON.stringify(config));
  const canonical = { ...receipt, content: 'Exact saved text', review_url: `${config.base_url}/e/${receipt.entry_id}#manage` };
  request.mockResolvedValue(Response.json({ canDelete: true, sharingReceipt: canonical }));
  const card = await service.add('conversation', receipt.entry_id);
  expect(card.test).toBe(false);
  expect(card.receipts).toEqual([canonical]);
  expect(JSON.stringify(card)).not.toContain(key);
  expect(JSON.stringify(card)).not.toContain(config.key_file);
  expect(request.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(card.receipts[0].notification_evidence).toBeNull();
  for (const base of ['http://router.teleport.computer', 'https://router.teleport.computer.evil.test', 'https://router.teleport.computer/proxy', 'https://user:pass@router.teleport.computer']) {
    config.base_url = base; await writeFile(file, JSON.stringify(config));
    await expect(service.read('conversation')).rejects.toThrow('fixed production origin');
  }
});

test('adding refuses a non-owned, swapped or wrong-origin post and is idempotent', async () => {
  const request = vi.fn<typeof fetch>(); const { service } = await fixture(request);
  request.mockResolvedValueOnce(Response.json({ canDelete: false, sharingReceipt: receipt }));
  await expect(service.add('conversation', receipt.entry_id)).rejects.toThrow('does not own');
  for (const bad of [{ ...receipt, entry_id: 'different' }, { ...receipt, review_url: 'https://other.test/e/test-post' }]) {
    request.mockResolvedValueOnce(Response.json({ canDelete: true, sharingReceipt: bad }));
    await expect(service.add('conversation', receipt.entry_id)).rejects.toThrow('different post or origin');
  }
  request.mockImplementation(async () => Response.json({ canDelete: true, sharingReceipt: receipt }));
  await service.add('conversation', receipt.entry_id);
  expect((await service.add('conversation', receipt.entry_id)).receipts).toEqual([receipt]);
  expect(request.mock.calls.every(call => call[1]?.method === 'GET')).toBe(true);
});
