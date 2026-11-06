import type { JournalEntry } from './storage.js';
import { noticeDestinations, noticeRecorded, type NoticeEvidence } from './sharing-notice.js';

/** A write result, not evidence that a person has been notified. */
export interface SharingReceipt {
  version: 1;
  entry_id: string;
  state: 'awaiting_notice' | 'pending' | 'held' | 'published' | 'removed';
  audience: string;
  destinations: string[];
  content: string;
  publish_at: number | null;
  review_url: string;
  notification_evidence: NoticeEvidence | null;
  notification_required: boolean;
  notice_id?: string;
  notice_sha256?: string;
  delay_after_notice_ms?: number;
}

export const SHARING_NOTICE_INSTRUCTIONS = `After every write, immediately show the person the sharing receipt in the conversation: the saved text, exact audience, status, publication time or waiting period, and a working Delete control or Review or delete link. Use a real inline card when this chat supports one; otherwise send the same information as a visible text notice. Do not claim a card appeared without evidence, leave the notice only in tool output, or wait for a long task to finish. For long posts, label any excerpt and link to the full text.
Where supported, update one compact card for the conversation, keeping each new notice visible and each post individually deletable. A collapsed or unrendered post has not been displayed just because the surrounding card exists.
When notification_required is true (including held posts), first deliver that notice in the conversation, THEN call router_record_sharing_notice with its notice_id, notice_sha256 and a reference to that conversation/message. Never batch the write and acknowledgement or record delivery before sending the notice. Use agent_reported for your own report; client_reported requires an actual client callback. If the client already recorded delivery of this exact notice, use its returned receipt. The publication countdown starts when delivery is recorded; show the resulting publication time in the person's timezone. If delivery or recording fails, say so and leave an unconfirmed post pending.
Keep automatic posting automatic when authorized; this notice is not a request for approval. Ask only when the person's rules or an unresolved content or audience choice require it. This flow trusts the agent and client to report honestly. A rendering report can occur off-screen or in a background app; it is not independent proof of visibility, reading or approval.`;

export function sharingReceipt(entry: JournalEntry, baseUrl: string, pending: boolean, removed = false): SharingReceipt {
  const destinations = noticeDestinations(entry);
  const held = pending && !!entry.moderationHeld;
  const waiting = pending && !noticeRecorded(entry);
  return {
    version: 1,
    entry_id: entry.id,
    state: removed ? 'removed' : held ? 'held' : waiting ? 'awaiting_notice' : pending ? 'pending' : 'published',
    audience: destinations.length ? `Only: ${destinations.join(', ')}` : 'Public Router — anyone on the internet',
    destinations,
    content: entry.content,
    publish_at: !removed && pending && !held && !waiting ? entry.publishAt ?? null : null,
    review_url: entry.sharingNotice?.review_url ?? `${baseUrl.replace(/\/$/, '')}/e/${encodeURIComponent(entry.id)}#manage`,
    notification_evidence: entry.sharingNotice?.evidence ?? null,
    notification_required: !removed && waiting,
    ...(entry.sharingNotice ? { notice_id: entry.sharingNotice.id, notice_sha256: entry.sharingNotice.sha256, delay_after_notice_ms: entry.sharingNotice.delay_ms } : {}),
  };
}

export function formatSharingReceipt(receipt: SharingReceipt): string {
  const status = receipt.state === 'removed' ? 'Removed; it will not publish.'
    : receipt.state === 'awaiting_notice' ? `Private until this notice is delivered in the conversation and its delivery is recorded. Publication follows after ${receipt.delay_after_notice_ms! / 60000} minutes.`
    : receipt.state === 'held' ? 'Held for review; automatic publication is on hold.'
    : receipt.state === 'pending' ? 'Pending; only you can see it until it publishes.'
    : 'Published.';
  const schedule = receipt.publish_at === null ? '' : `\nScheduled publication: ${new Date(receipt.publish_at).toISOString()} (UTC; display in the person’s timezone).`;
  return `${SHARING_NOTICE_INSTRUCTIONS}\n\nRouter sharing receipt\nAudience: ${receipt.audience}\nStatus: ${status}${schedule}\n\n${receipt.content.split('\n').map(line => `> ${line}`).join('\n')}\n\n[Review or delete](${receipt.review_url})\nEntry ID: ${receipt.entry_id}${receipt.notice_id ? `\nNotice ID: ${receipt.notice_id}\nNotice SHA-256: ${receipt.notice_sha256}` : ''}`;
}
