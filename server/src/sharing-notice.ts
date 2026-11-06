import { createHash, randomUUID } from 'node:crypto';
import type { JournalEntry } from './storage.js';

export interface NoticeEvidence {
  kind: 'agent_reported' | 'client_reported';
  recorded_at: number;
  conversation_ref_sha256: string;
}

export interface SharingNotice {
  id: string;
  sha256: string;
  review_url: string;
  delay_ms: number;
  evidence?: NoticeEvidence;
}

export class SharingNoticeError extends Error {}

export function noticeDestinations(entry: Pick<JournalEntry, 'to' | 'channel'>): string[] {
  return [...new Set([...(entry.to || []), ...(entry.channel ? [`#${entry.channel}`] : [])])];
}

export function noticeDigest(entry: JournalEntry, notice: SharingNotice): string {
  // Bind the saved text, every destination, management link and waiting period.
  // No client-specific protocol or assertion of human attention is involved.
  return createHash('sha256').update(JSON.stringify({ version: 1, notice_id: notice.id,
    entry_id: entry.id, content: entry.content, destinations: noticeDestinations(entry),
    review_url: notice.review_url, delay_ms: notice.delay_ms })).digest('hex');
}

export function prepareNotice(entry: JournalEntry, baseUrl: string, delayMs: number): SharingNotice {
  const notice: SharingNotice = { id: randomUUID(), sha256: '', delay_ms: delayMs,
    review_url: `${baseUrl.replace(/\/$/, '')}/e/${encodeURIComponent(entry.id)}#manage` };
  notice.sha256 = noticeDigest(entry, notice);
  return notice;
}

export function noticeRecorded(entry: JournalEntry): boolean {
  return !entry.sharingNotice || !!entry.sharingNotice.evidence && entry.sharingNotice.sha256 === noticeDigest(entry, entry.sharingNotice);
}

export function recordNotice(entry: JournalEntry, input: unknown): NoticeEvidence {
  const value = input as Record<string, unknown> | null;
  const notice = entry.sharingNotice;
  if (!notice) throw new SharingNoticeError('This entry has no notification waiting to be recorded.');
  if (!value || value.notice_id !== notice.id || value.notice_sha256 !== notice.sha256 || notice.sha256 !== noticeDigest(entry, notice)) {
    throw new SharingNoticeError('The notice does not match this post. Retrieve its current sharing receipt and show that notice first.');
  }
  if (value.evidence_kind !== 'agent_reported' && value.evidence_kind !== 'client_reported') {
    throw new SharingNoticeError('Use agent_reported or client_reported; neither proves human attention.');
  }
  if (typeof value.conversation_ref !== 'string' || !value.conversation_ref.trim() || value.conversation_ref.length > 2000) {
    throw new SharingNoticeError('Provide the conversation/message reference where the notice was delivered. Router stores only its SHA-256 hash.');
  }
  // Retries cannot reset the countdown or rewrite the first recorded claim.
  if (notice.evidence) return notice.evidence;
  notice.evidence = { kind: value.evidence_kind, recorded_at: Date.now(),
    conversation_ref_sha256: createHash('sha256').update(value.conversation_ref).digest('hex') };
  const publishAt = notice.evidence.recorded_at + notice.delay_ms;
  if (entry.moderationHeld) entry.scheduledPublishAt = publishAt;
  else entry.publishAt = publishAt;
  return notice.evidence;
}
