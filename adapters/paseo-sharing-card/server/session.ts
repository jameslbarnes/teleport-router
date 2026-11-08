import { readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { cardSchema, receiptSchema, type Receipt } from '../shared/card';

const sessionSchema = z.object({
  agent_id: z.string(),
  mode: z.enum(['test', 'production']).default('test'),
  base_url: z.string(),
  router_key: z.string().min(32).optional(), // Disposable test identities only.
  key_file: z.string().min(1).optional(), // One protected host key, shared by configured conversations.
  card: cardSchema,
}).superRefine((session, context) => {
  const validOrigin = (() => {
    try {
      const url = new URL(session.base_url);
      if (session.mode === 'production') return session.base_url === 'https://router.teleport.computer';
      return url.protocol === 'http:' && url.hostname === '127.0.0.1'
        && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash
        && session.base_url === url.origin;
    } catch { return false; }
  })();
  if (!validOrigin || session.card.test !== (session.mode === 'test')) {
    context.addIssue({ code: 'custom', message: 'Use an isolated loopback test Router or the fixed production origin and matching card mode' });
  }
  if ((!session.router_key && !session.key_file) || (session.router_key && session.key_file)
    || (session.mode === 'production' && !session.key_file)) {
    context.addIssue({ code: 'custom', message: 'Configure one protected key file (production) or disposable test key' });
  }
});
type Session = z.output<typeof sessionSchema>;
export function defaultSessionPath(agentId: string) {
  if (!/^[a-f0-9-]{36}$/.test(agentId)) throw new Error('Invalid conversation ID');
  return join(homedir(), '.paseo', 'router-sharing-card', 'sessions', `${agentId}.json`);
}

export class CardSession {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly file: string | ((agentId: string) => string) = defaultSessionPath, private readonly request = fetch) {}

  private path(agentId: string) { return typeof this.file === 'string' ? this.file : this.file(agentId); }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const task = this.queue.then(work);
    this.queue = task.catch(() => undefined);
    return task;
  }
  private async load(agentId: string): Promise<Session> {
    const session = sessionSchema.parse(JSON.parse(await readFile(this.path(agentId), 'utf8')));
    if (session.agent_id !== agentId) throw new Error('This card belongs to a different conversation');
    return session;
  }
  private entry(session: Session, entryId: string): Receipt {
    const entry = session.card.receipts.find(receipt => receipt.entry_id === entryId);
    if (!entry) throw new Error('This post is not part of this conversation card');
    return entry;
  }
  private async api(session: Session, path: string, method = 'GET', body?: unknown) {
    const key = session.router_key ?? (await readFile(session.key_file!, 'utf8')).trim();
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Error('Host key file is not a Router key');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      return await this.request(session.base_url + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } finally { clearTimeout(timer); }
  }
  private async save(session: Session) {
    session.card.updated_at = Math.max(Date.now(), session.card.updated_at + 1);
    const file = this.path(session.agent_id);
    await writeFile(file + '.tmp', JSON.stringify(session, null, 2), { mode: 0o600 });
    await rename(file + '.tmp', file);
    return session.card;
  }
  private canonicalReceipt(session: Session, entryId: string, value: unknown): Receipt {
    const receipt = receiptSchema.parse(value);
    if (receipt.entry_id !== entryId || receipt.review_url !== `${session.base_url}/e/${encodeURIComponent(entryId)}#manage`) {
      throw new Error('Router returned a receipt for a different post or origin');
    }
    return receipt;
  }
  add(agentId: string, entryId: string) {
    return this.serial(async () => {
      const session = await this.load(agentId);
      // Callers supply only an ID. Router supplies the exact saved content,
      // audience and notice; public read access alone never grants Delete.
      const response = await this.api(session, '/api/entry/' + encodeURIComponent(entryId));
      if (!response.ok) throw new Error(`Router could not load the owned post (${response.status})`);
      const result = await response.json() as { canDelete?: boolean; sharingReceipt?: unknown };
      if (result.canDelete !== true) throw new Error('This connection does not own the post');
      const receipt = this.canonicalReceipt(session, entryId, result.sharingReceipt);
      const existing = session.card.receipts.findIndex(r => r.entry_id === entryId);
      if (existing >= 0) session.card.receipts[existing] = receipt;
      else {
        if (session.card.receipts.length >= 200) throw new Error('This conversation card is full; show a text notice and review/delete link');
        session.card.receipts.push(receipt);
      }
      // Adding the row is not evidence that a client rendered it.
      return this.save(session);
    });
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
          const result = await response.json() as { canDelete?: boolean; sharingReceipt: unknown };
          if (result.canDelete !== true) throw new Error('This connection no longer owns the post');
          Object.assign(receipt, this.canonicalReceipt(session, receipt.entry_id, result.sharingReceipt));
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
      Object.assign(receipt, this.canonicalReceipt(session, entryId, result.receipt));
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
