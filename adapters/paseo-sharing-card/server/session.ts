import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cardSchema, receiptSchema, type Receipt } from '../shared/card';

const sessionSchema = z.object({
  agent_id: z.string(),
  base_url: z.string().refine(value => {
    try {
      const url = new URL(value);
      return url.protocol === 'http:' && url.hostname === '127.0.0.1'
        && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
    } catch { return false; }
  }, 'This prototype only connects to an isolated loopback Router'),
  test_key: z.string().min(32),
  card: cardSchema,
});
type Session = z.output<typeof sessionSchema>;
export const defaultSessionPath = join(homedir(), '.paseo', 'router-card-test', 'session.json');

export class CardSession {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file = defaultSessionPath, private readonly request = fetch) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async load(agentId: string): Promise<Session> {
    const session = sessionSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
    if (session.agent_id !== agentId) throw new Error('This card belongs to a different conversation');
    return session;
  }
  private entry(session: Session, entryId: string): Receipt {
    const entry = session.card.receipts.find(receipt => receipt.entry_id === entryId);
    if (!entry) throw new Error('This post is not part of this test card');
    return entry;
  }
  private async api(session: Session, path: string, method = 'GET', body?: unknown) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await this.request(session.base_url + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${session.test_key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally { clearTimeout(timer); }
  }
  private async save(session: Session) {
    session.card.updated_at = Date.now();
    await writeFile(this.file + '.tmp', JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(this.file + '.tmp', this.file);
    return session.card;
  }
  read(agentId: string) {
    return this.serial(async () => (await this.load(agentId)).card);
  }
  refresh(agentId: string) {
    return this.serial(async () => {
      const session = await this.load(agentId);
      for (const receipt of session.card.receipts) {
        if (receipt.state === 'removed') continue;
        const response = await this.api(session, '/api/entry/' + encodeURIComponent(receipt.entry_id));
        if (response.status === 404) {
          Object.assign(receipt, { state: 'removed', publish_at: null, notification_required: false });
        } else if (response.ok) {
          const result = await response.json() as { sharingReceipt: unknown };
          Object.assign(receipt, receiptSchema.parse(result.sharingReceipt));
        } else throw new Error(`Router could not refresh the post (${response.status})`);
      }
      return this.save(session);
    });
  }
  rendered(agentId: string, entryId: string, noticeId: string, noticeHash: string) {
    return this.serial(async () => {
      const session = await this.load(agentId);
      const receipt = this.entry(session, entryId);
      if (receipt.notice_id !== noticeId || receipt.notice_sha256 !== noticeHash) {
        throw new Error('The displayed notice does not match this post');
      }
      if (!receipt.notification_required || receipt.state === 'removed') return session.card;
      const response = await this.api(session, '/api/entries/' + encodeURIComponent(entryId) + '/notice', 'POST', {
        notice_id: noticeId, notice_sha256: noticeHash, evidence_kind: 'client_reported',
        conversation_ref: `paseo:${agentId}:router-sharing-card:${entryId}`,
      });
      if (!response.ok) throw new Error(`Router could not record the notice (${response.status})`);
      const result = await response.json() as { receipt: unknown };
      Object.assign(receipt, receiptSchema.parse(result.receipt));
      return this.save(session);
    });
  }
  delete(agentId: string, entryId: string) {
    return this.serial(async () => {
      const session = await this.load(agentId);
      const receipt = this.entry(session, entryId);
      if (receipt.state === 'removed') return session.card;
      const response = await this.api(session, '/api/entries/' + encodeURIComponent(entryId), 'DELETE');
      if (!response.ok && response.status !== 404) throw new Error(`Router could not delete the post (${response.status})`);
      Object.assign(receipt, { state: 'removed', publish_at: null, notification_required: false });
      return this.save(session);
    });
  }
}
