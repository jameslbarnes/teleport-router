/**
 * Delivery Layer for Unified Addressing
 *
 * Handles parsing destination strings and delivering entries to recipients.
 * Destinations can be:
 * - @handles (e.g., "@alice")
 * - Email addresses (e.g., "bob@example.com")
 * - Webhook URLs (e.g., "https://webhook.example.com")
 */

import { tracePointer } from './trace-pointer.js';
import type { Storage, JournalEntry, User, Channel } from './storage.js';
import type { NotificationService, EmailClient } from './notifications.js';
import { canSendEmailTo } from './notifications.js';

// ═══════════════════════════════════════════════════════════════
// DESTINATION TYPES
// ═══════════════════════════════════════════════════════════════

export type Destination =
  | { type: 'handle'; handle: string; user?: User }
  | { type: 'email'; email: string; user?: User }
  | { type: 'webhook'; url: string }
  | { type: 'channel'; channelId: string };

// ═══════════════════════════════════════════════════════════════
// DESTINATION PARSING
// ═══════════════════════════════════════════════════════════════

/**
 * Parse a single destination string into a typed Destination
 *
 * @param dest - The destination string (e.g., "@alice", "bob@example.com", "https://...")
 * @returns Parsed Destination object
 */
export function parseDestination(dest: string): Destination {
  const trimmed = dest.trim();

  // Channel: starts with #
  if (trimmed.startsWith('#')) {
    const channelId = trimmed.slice(1).toLowerCase();
    return { type: 'channel', channelId };
  }

  // Handle: starts with @
  if (trimmed.startsWith('@')) {
    const handle = trimmed.slice(1).toLowerCase();
    return { type: 'handle', handle };
  }

  // Webhook URL: starts with http:// or https://
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return { type: 'webhook', url: trimmed };
  }

  // Email: contains @ but doesn't start with it (and isn't a URL)
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    return { type: 'email', email: trimmed.toLowerCase() };
  }

  // Default: treat as handle without @ prefix
  return { type: 'handle', handle: trimmed.toLowerCase() };
}

/**
 * Parse multiple destination strings
 *
 * @param destinations - Array of destination strings
 * @returns Array of parsed Destination objects
 */
export function parseDestinations(destinations: string[]): Destination[] {
  return destinations.map(parseDestination);
}

// ═══════════════════════════════════════════════════════════════
// DESTINATION RESOLUTION
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve destinations by looking up handles and emails in storage
 *
 * @param destinations - Array of destination strings
 * @param storage - Storage instance for user lookups
 * @returns Array of resolved Destination objects with user info attached
 */
export async function resolveDestinations(
  destinations: string[],
  storage: Storage
): Promise<Destination[]> {
  const parsed = parseDestinations(destinations);
  const resolved: Destination[] = [];

  for (const dest of parsed) {
    if (dest.type === 'handle') {
      // Look up user by handle
      const user = await storage.getUser(dest.handle);
      resolved.push({ ...dest, user: user || undefined });
    } else if (dest.type === 'email') {
      // Look up user by email
      const user = await storage.getUserByEmail(dest.email);
      resolved.push({ ...dest, user: user || undefined });
    } else {
      // Webhooks don't need resolution
      resolved.push(dest);
    }
  }

  return resolved;
}

// ═══════════════════════════════════════════════════════════════
// SSRF PREVENTION
// ═══════════════════════════════════════════════════════════════

/**
 * Check if a URL points to internal/private IP ranges
 */
export function isInternalUrl(urlString: string): boolean {
  try {
    const url = new URL(urlString);
    const hostname = url.hostname.toLowerCase();

    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
      return true;
    }

    // Block private IP ranges
    const ipMatch = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      // 10.x.x.x
      if (a === 10) return true;
      // 172.16.x.x - 172.31.x.x
      if (a === 172 && b >= 16 && b <= 31) return true;
      // 192.168.x.x
      if (a === 192 && b === 168) return true;
      // 127.x.x.x loopback
      if (a === 127) return true;
      // 169.254.x.x link-local
      if (a === 169 && b === 254) return true;
    }

    return false;
  } catch {
    return true; // Invalid URL = blocked
  }
}

// ═══════════════════════════════════════════════════════════════
// WEBHOOK DELIVERY
// ═══════════════════════════════════════════════════════════════

/**
 * Webhook payload sent when an entry addresses a webhook URL.
 *
 * Example payload:
 * ```json
 * {
 *   "event": "entry.addressed",
 *   "entryId": "en_abc123def456",
 *   "author": {
 *     "handle": "alice",
 *     "pseudonym": "Quiet Feather#79c30b"
 *   },
 *   "content": "Deploy complete for v2.3.1",
 *   "timestamp": 1738512000000,
 *   "visibility": "public",
 *   "to": ["@bob", "https://webhook.example.com/notify"],
 *   "inReplyTo": null,
 *   "url": "https://router.teleport.computer/e/en_abc123def456"
 * }
 * ```
 */
export interface WebhookPayload {
  /** Event type (always "entry.addressed" for now) */
  event: 'entry.addressed';
  /** Unique entry ID */
  entryId: string;
  /** Author information */
  author: {
    /** Handle without @ prefix, or null if unclaimed */
    handle: string | null;
    /** Pseudonym (always present) */
    pseudonym: string;
  };
  /** Entry content (full text) */
  content: string;
  /** Unix timestamp in milliseconds */
  timestamp: number;
  /** ISO 8601 timestamp for convenience */
  timestampISO: string;
  /** Visibility level */
  visibility: 'public' | 'private' | 'ai-only';
  /** All destinations this entry was addressed to */
  to: string[];
  /** Parent entry ID if this is a reply, null otherwise */
  inReplyTo: string | null;
  /** Permalink to the entry */
  url: string;
}

/**
 * Deliver entry to a webhook URL
 *
 * @param url - Webhook URL
 * @param entry - The entry to deliver
 * @param baseUrl - Base URL for permalinks (e.g., "https://router.teleport.computer")
 * @param headers - Optional custom headers
 * @returns Success status and any error message
 */
export async function deliverWebhook(
  url: string,
  entry: JournalEntry,
  baseUrl: string,
  headers?: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  // SSRF prevention
  if (isInternalUrl(url)) {
    return { success: false, error: 'Internal URLs are blocked for security' };
  }

  const payload: WebhookPayload = {
    event: 'entry.addressed',
    entryId: entry.id,
    author: {
      handle: entry.handle || null,
      pseudonym: entry.pseudonym,
    },
    content: entry.content,
    timestamp: entry.timestamp,
    timestampISO: new Date(entry.timestamp).toISOString(),
    visibility: entry.visibility || 'public',
    to: entry.to || [],
    inReplyTo: entry.inReplyTo || null,
    url: `${baseUrl}/e/${entry.id}`,
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'Router/1.0',
        ...(headers || {}),
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Unknown error' };
  }
}

// ═══════════════════════════════════════════════════════════════
// ENTRY DELIVERY
// ═══════════════════════════════════════════════════════════════

export interface DeliveryResult {
  destination: string;
  type: 'handle' | 'email' | 'webhook' | 'channel';
  success: boolean;
  error?: string;
}

export interface DeliveryConfig {
  storage: Storage;
  notificationService: NotificationService;
  emailClient?: EmailClient;
  fromEmail: string;
  baseUrl: string;
}

/**
 * Deliver an entry to all destinations in its `to` array.
 *
 * Email recipients (@handles with verified email + bare email addresses)
 * are batched into a single group email so all recipients can see each
 * other and reply-all works. Webhooks are delivered individually.
 *
 * @param entry - The entry to deliver
 * @param config - Configuration for delivery (storage, notification service, etc.)
 * @returns Array of delivery results
 */
export async function deliverEntry(
  entry: JournalEntry,
  config: DeliveryConfig
): Promise<DeliveryResult[]> {
  if (!entry.to || entry.to.length === 0) {
    return [];
  }

  const { storage, emailClient, fromEmail, baseUrl } = config;
  const results: DeliveryResult[] = [];

  // Look up the author for CC purposes
  const authorUser = entry.handle ? await storage.getUser(entry.handle) : null;
  const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
  const authorEmail = authorUser?.email && authorUser?.emailVerified ? authorUser.email : undefined;

  // Resolve destinations
  const destinations = await resolveDestinations(entry.to, storage);

  // Partition destinations: collect email recipients for batching
  const emailRecipients: { destString: string; email: string; type: 'handle' | 'email' }[] = [];

  for (let i = 0; i < destinations.length; i++) {
    const dest = destinations[i];
    const destString = entry.to[i];

    try {
      if (dest.type === 'handle') {
        if (!dest.user) {
          results.push({ destination: destString, type: 'handle', success: false, error: 'User not found' });
          continue;
        }
        // Check if this user has a verified email and can receive emails
        if (
          dest.user.email &&
          dest.user.emailVerified &&
          (!dest.user.emailPrefs || dest.user.emailPrefs.comments !== false) &&
          canSendEmailTo(dest.user.handle)
        ) {
          emailRecipients.push({ destString, email: dest.user.email, type: 'handle' });
        }
        // Mark as success regardless — the handle was resolved
        results.push({ destination: destString, type: 'handle', success: true });
      } else if (dest.type === 'email') {
        if (emailClient) {
          // For bare email destinations, check rate limit if they resolve to a user
          if (dest.user) {
            if (
              dest.user.emailVerified &&
              (!dest.user.emailPrefs || dest.user.emailPrefs.comments !== false) &&
              canSendEmailTo(dest.user.handle)
            ) {
              emailRecipients.push({ destString, email: dest.email, type: 'email' });
            }
          } else {
            // Bare email with no user — send directly
            emailRecipients.push({ destString, email: dest.email, type: 'email' });
          }
          results.push({ destination: destString, type: 'email', success: true });
        } else {
          results.push({ destination: destString, type: 'email', success: false, error: 'Email not configured' });
        }
      } else if (dest.type === 'webhook') {
        const result = await deliverWebhook(dest.url, entry, baseUrl);
        results.push({ destination: destString, type: 'webhook', ...result });
      } else if (dest.type === 'channel') {
        // Channels don't need active delivery — access is resolved live via membership
        results.push({ destination: destString, type: 'channel', success: true });
      }
    } catch (err) {
      results.push({
        destination: destString,
        type: dest.type,
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      });
    }
  }

  // Send one group email to all collected recipients
  if (emailRecipients.length > 0 && emailClient) {
    try {
      const recipientEmails = emailRecipients.map(r => r.email);

      // If the author is also a recipient, don't put them in both to and cc
      const authorIsRecipient = authorEmail && recipientEmails.some(
        e => e.toLowerCase() === authorEmail.toLowerCase()
      );

      const cc = authorEmail && !authorIsRecipient ? authorEmail : undefined;
      const replyTo = authorEmail;

      await emailClient.send({
        from: `Router <${fromEmail}>`,
        to: recipientEmails,
        subject: `${author} wrote you something`,
        html: renderAddressedEntryEmail(entry, author, baseUrl),
        cc,
        replyTo,
      });
    } catch (err) {
      // Log but don't fail individual results — the destinations were resolved OK
      console.error('[Delivery] Group email failed:', err);
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════
// EMAIL TEMPLATES
// ═══════════════════════════════════════════════════════════════

/**
 * Render HTML email for an addressed entry
 */
function renderAddressedEntryEmail(entry: JournalEntry, author: string, baseUrl: string): string {
  const contentPreview = entry.content.length > 500
    ? entry.content.slice(0, 500) + '...'
    : entry.content;

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: Georgia, serif; line-height: 1.7; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 40px 20px; }
    .quote { border-left: 3px solid #7c5cbf; padding: 12px 16px; margin: 20px 0; background: #f9f7ff; font-size: 16px; }
    a.btn { display: inline-block; background: #7c5cbf; color: white; padding: 10px 22px; text-decoration: none; border-radius: 6px; font-family: Georgia, serif; }
    .footer { font-size: 13px; color: #999; margin-top: 40px; }
  </style>
</head>
<body>
  <p>Hey,</p>

  <p>${author} wrote this for you on Router:</p>

  <div class="quote">${contentPreview}</div>

  <p><a href="${baseUrl}/e/${entry.id}" class="btn">View on Router</a></p>

  <div class="footer">
    &mdash;<br>
    router.teleport.computer &middot; <a href="${baseUrl}/settings">manage notifications</a>
  </div>
</body>
</html>
  `.trim();
}

// ═══════════════════════════════════════════════════════════════
// UNIFIED PRIVACY MODEL
// ═══════════════════════════════════════════════════════════════
//
// One rule: `to` determines access.
//   - Empty `to` = public (everyone can see)
//   - Non-empty `to` = private to those destinations
//
// `aiOnly` is orthogonal — controls whether humans see full content or a stub.
// It does NOT affect who has access.
//
// Channel membership (#channel in `to`) is resolved live.
// ═══════════════════════════════════════════════════════════════

/**
 * @deprecated Use canView() instead. Kept for backward compat during transition.
 */
export function getDefaultVisibility(
  to?: string[],
  inReplyTo?: string
): 'public' | 'private' | 'ai-only' {
  if (to && to.length > 0 && !inReplyTo) {
    return 'private';
  }
  return 'public';
}

/**
 * Normalize a legacy entry to the new unified model at read time.
 * Does NOT mutate — returns a new object.
 *
 * Migrations applied:
 * - `channel: "flashbots"` → adds `#flashbots` to `to`
 * - `visibility: 'ai-only'` or `humanVisible: false` → sets `aiOnly: true`
 * - `visibility: 'private'` with `to` → keeps `to` as-is (already correct)
 */
export function normalizeEntry(entry: JournalEntry): JournalEntry {
  const normalized = { ...entry, trace_url: tracePointer(entry.id) };
  let to = normalized.to ? [...normalized.to] : [];

  // Migrate channel field to #channel in `to`
  if (normalized.channel) {
    const channelDest = `#${normalized.channel}`;
    if (!to.includes(channelDest)) {
      to.push(channelDest);
    }
  }

  // Migrate visibility/humanVisible to aiOnly
  if (normalized.aiOnly === undefined) {
    if (normalized.visibility === 'ai-only' || normalized.humanVisible === false) {
      normalized.aiOnly = true;
    }
  }

  if (to.length > 0) {
    normalized.to = to;
  }

  return normalized;
}

/**
 * Check if a user's default is AI-only, reading whichever field exists.
 */
export function isDefaultAiOnly(user: User): boolean {
  if ('defaultAiOnly' in user && (user as any).defaultAiOnly !== undefined) {
    return (user as any).defaultAiOnly;
  }
  if (user.defaultHumanVisible !== undefined) {
    return !user.defaultHumanVisible;
  }
  return false; // default: human-visible
}

/**
 * Check if an entry should show as AI-only (stub for humans).
 * Reads `aiOnly` first, falls back to legacy `humanVisible`.
 */
export function isEntryAiOnly(entry: JournalEntry): boolean {
  if (entry.aiOnly !== undefined) return entry.aiOnly;
  if (entry.humanVisible !== undefined) return !entry.humanVisible;
  return false;
}

/**
 * Unified access control: check if a user can view an entry.
 *
 * Rule: `to` determines access.
 *   - Empty `to` (or undefined) = public, except an older record marked `visibility: 'private'`,
 *     which is its author's alone
 *   - Non-empty `to` = private to author + listed destinations
 *
 * Channel destinations (#channel) require a storage lookup to check membership.
 * This function is async because of that.
 *
 * @param entry - The entry to check (should be normalized first)
 * @param viewerHandle - The viewer's handle (without @), if any
 * @param viewerEmail - The viewer's email, if any
 * @param isAuthor - Whether the viewer is the entry's author
 * @param storage - Storage instance for channel membership lookups
 */
export async function canView(
  entry: JournalEntry,
  viewerHandle: string | undefined,
  viewerEmail: string | undefined,
  isAuthor: boolean,
  storage: Storage,
  channelAccessCache?: Map<string, boolean>
): Promise<boolean> {
  // Authors can always see their own entries
  if (isAuthor) return true;

  // No `to` = public, unless an older record was marked private with nowhere to go: then it is its author's alone,
  // as on public pages (hasPublicAudience).
  if (!entry.to || entry.to.length === 0) return entry.visibility !== 'private';

  // Check each destination
  for (const dest of entry.to) {
    // @handle match
    if (dest.startsWith('@')) {
      const handle = dest.slice(1).toLowerCase();
      if (viewerHandle && viewerHandle.toLowerCase() === handle) return true;
    }
    // #channel match — check if viewer is a subscriber
    else if (dest.startsWith('#')) {
      if (viewerHandle) {
        const channelId = dest.slice(1);
        if (channelAccessCache?.has(channelId)) {
          if (channelAccessCache.get(channelId)) {
            return true;
          }
          continue;
        }

        try {
          const channel = await storage.getChannel(channelId);
          const hasAccess = !!(channel && channel.subscribers.some(s => s.handle === viewerHandle));
          channelAccessCache?.set(channelId, hasAccess);
          if (hasAccess) {
            return true;
          }
        } catch {
          channelAccessCache?.set(channelId, false);
          // Channel lookup failed — deny access for this dest
        }
      }
    }
    // Email match
    else if (dest.includes('@') && !dest.startsWith('http')) {
      if (viewerEmail && dest.toLowerCase() === viewerEmail.toLowerCase()) return true;
    }
    // Bare handle match (legacy)
    else if (!dest.startsWith('http')) {
      if (viewerHandle && viewerHandle.toLowerCase() === dest.toLowerCase()) return true;
    }
    // Webhooks don't grant view access
  }

  return false;
}

/**
 * @deprecated Sync version kept for backward compat. Does NOT check #channel access.
 * Use canView() for full access checks.
 */
export function canViewEntry(
  entry: JournalEntry,
  userHandle?: string,
  userEmail?: string,
  isAuthor?: boolean
): boolean {
  if (isAuthor) return true;

  // No `to` = public (new model)
  if (!entry.to || entry.to.length === 0) {
    // Fall back to legacy visibility check
    if (!entry.visibility || entry.visibility === 'public') return true;
    if (entry.visibility === 'ai-only') return true;
    if (entry.visibility === 'private') return false;
    return true;
  }

  // Has `to` — check if viewer is a recipient
  for (const dest of entry.to) {
    if (dest.startsWith('@')) {
      const handle = dest.slice(1).toLowerCase();
      if (userHandle && userHandle.toLowerCase() === handle) return true;
    } else if (dest.startsWith('#')) {
      // Can't resolve channel membership synchronously — skip
      // (callers should use async canView instead)
    } else if (dest.includes('@') && !dest.startsWith('http')) {
      if (userEmail && dest.toLowerCase() === userEmail.toLowerCase()) return true;
    } else if (!dest.startsWith('http')) {
      if (userHandle && userHandle.toLowerCase() === dest.toLowerCase()) return true;
    }
  }

  return false;
}
