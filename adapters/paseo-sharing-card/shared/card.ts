import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

// Same receipt fields as Router. No agent-specific identity or credentials are
// added to the portable receipt; the host adapter owns conversation placement.
export const receiptSchema = z.object({
  version: z.literal(1),
  entry_id: z.string(),
  state: z.enum(['awaiting_notice', 'pending', 'held', 'published', 'removed']),
  audience: z.string(),
  destinations: z.array(z.string()),
  content: z.string(),
  publish_at: z.number().nullable(),
  review_url: z.string(),
  notification_evidence: z.object({
    kind: z.enum(['agent_reported', 'client_reported']),
    recorded_at: z.number(),
    conversation_ref_sha256: z.string(),
  }).nullable(),
  notification_required: z.boolean(),
  notice_id: z.string().optional(),
  notice_sha256: z.string().optional(),
  delay_after_notice_ms: z.number().optional(),
});
export type Receipt = z.output<typeof receiptSchema>;
export const cardSchema = z.object({
  version: z.literal(1),
  test: z.boolean(),
  updated_at: z.number(),
  receipts: z.array(receiptSchema).max(200),
});
export type Card = z.output<typeof cardSchema>;
const sessionInput = z.object({ agent_id: z.string() });
const entryInput = sessionInput.extend({ entry_id: z.string() });
export const showCardRpc = defineRpc({ name: 'show-card', input: sessionInput, output: cardSchema });
export const addPostRpc = defineRpc({ name: 'add-post', input: entryInput, output: cardSchema });
export const refreshCardRpc = defineRpc({ name: 'refresh-card', input: sessionInput, output: cardSchema });
export const renderedRpc = defineRpc({
  name: 'notice-rendered',
  input: entryInput.extend({ notice_id: z.string(), notice_sha256: z.string() }),
  output: cardSchema,
});
export const deleteRpc = defineRpc({ name: 'delete-post', input: entryInput, output: cardSchema });

export function statusText(receipt: Receipt, now = Date.now()): string {
  if (receipt.state === 'removed') return 'Deleted from Router';
  if (receipt.state === 'published') return 'Published';
  if (receipt.state === 'held') return 'Held for review';
  if (receipt.state === 'awaiting_notice') {
    const minutes = Math.round((receipt.delay_after_notice_ms ?? 3600000) / 60000);
    return `Waiting to record this notice · ${minutes}-minute delay`;
  }
  if (receipt.publish_at !== null && receipt.publish_at <= now) return 'Checking publication status…';
  if (receipt.publish_at !== null) {
    return `Scheduled for ${new Date(receipt.publish_at).toLocaleTimeString([], {
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    })}`;
  }
  return 'Pending';
}
