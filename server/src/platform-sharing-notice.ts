import { StagedStorage, type Storage, type JournalEntry } from './storage.js';
import { sharingReceipt, formatVisibleSharingNotice } from './sharing-receipt.js';

/** Platform-originated writes have no MCP caller to deliver their notice. Send
 * it in the source conversation first; a successful send is server-reported
 * delivery, never a client layout or human-attention claim. No gate exemption. */
export async function announcePlatformEntry(entry: JournalEntry, storage: Storage, baseUrl: string,
  send: (text: string) => Promise<string>): Promise<void> {
  const pending = storage instanceof StagedStorage && storage.isPending(entry.id);
  const receipt = sharingReceipt(entry, baseUrl, pending);
  const reference = await send(formatVisibleSharingNotice(receipt));
  if (receipt.notification_required && storage instanceof StagedStorage) {
    const recorded = storage.recordSharingNotice(entry.id, {
      notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
      evidence_kind: 'agent_reported', conversation_ref: reference,
    });
    if (recorded.publishAt && !recorded.moderationHeld) {
      await send(`Router post ${entry.id}: scheduled for ${new Date(recorded.publishAt).toISOString()} (UTC).\n[Review or delete](${receipt.review_url})`);
    }
  }
}
