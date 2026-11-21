/**
 * Channel-Topic Mapping Store
 *
 * Maps Hermes channels (e.g. 'engineering') to Telegram forum topics.
 * Each Hermes channel maps to exactly one Telegram forum thread_id in a
 * supergroup. Efficient lookups by both channelId and threadId via internal Maps.
 *
 * Standalone module — no imports from other Hermes modules.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ChannelTopicMapping {
  channelId: string;          // Hermes channel slug, e.g. 'engineering'
  telegramChatId: string;     // Telegram supergroup chat ID
  telegramThreadId: number;   // Telegram forum topic thread_id
  topicName: string;          // Display name of the topic
  createdAt: number;          // Timestamp when mapping was created
  createdBy?: string;         // Handle of who created it (optional)
}

// ─── Validation ──────────────────────────────────────────────────────────────

/** Lowercase alphanumeric + hyphens, 2-30 chars, no leading/trailing hyphens. */
const CHANNEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/;

function isValidChannelId(id: string): boolean {
  return CHANNEL_ID_RE.test(id);
}

// ─── Store ───────────────────────────────────────────────────────────────────

export class ChannelTopicMappingStore {
  /** Primary index: channelId → mapping */
  private byChannelId = new Map<string, ChannelTopicMapping>();
  /** Secondary index: threadId → mapping */
  private byThreadId = new Map<number, ChannelTopicMapping>();

  /** Add a mapping. Throws if channelId already mapped or format is invalid. */
  add(mapping: ChannelTopicMapping): void {
    if (!isValidChannelId(mapping.channelId)) {
      throw new Error(
        `Invalid channelId "${mapping.channelId}": must be lowercase alphanumeric + hyphens, 2-30 chars`,
      );
    }
    if (this.byChannelId.has(mapping.channelId)) {
      throw new Error(
        `Channel "${mapping.channelId}" is already mapped to thread ${this.byChannelId.get(mapping.channelId)!.telegramThreadId}`,
      );
    }
    this.byChannelId.set(mapping.channelId, mapping);
    this.byThreadId.set(mapping.telegramThreadId, mapping);
  }

  /** Remove a mapping by Hermes channel ID. Returns true if found & removed. */
  remove(channelId: string): boolean {
    const mapping = this.byChannelId.get(channelId);
    if (!mapping) return false;
    this.byChannelId.delete(channelId);
    this.byThreadId.delete(mapping.telegramThreadId);
    return true;
  }

  /** Remove a mapping by Telegram thread ID. Returns true if found & removed. */
  removeByThreadId(threadId: number): boolean {
    const mapping = this.byThreadId.get(threadId);
    if (!mapping) return false;
    this.byThreadId.delete(threadId);
    this.byChannelId.delete(mapping.channelId);
    return true;
  }

  /** Look up a mapping by Hermes channel ID. */
  getByChannelId(channelId: string): ChannelTopicMapping | null {
    return this.byChannelId.get(channelId) ?? null;
  }

  /** Look up a mapping by Telegram thread ID. */
  getByThreadId(threadId: number): ChannelTopicMapping | null {
    return this.byThreadId.get(threadId) ?? null;
  }

  /** Return all mappings as an array. */
  list(): ChannelTopicMapping[] {
    return [...this.byChannelId.values()];
  }

  /** Check if a Hermes channel has a mapping. */
  has(channelId: string): boolean {
    return this.byChannelId.has(channelId);
  }

  /** Number of active mappings. */
  size(): number {
    return this.byChannelId.size;
  }

  /** Serialize to a plain array for JSON persistence. */
  toJSON(): ChannelTopicMapping[] {
    return this.list();
  }

  /** Deserialize from persisted JSON array. Skips invalid entries defensively. */
  static fromJSON(data: ChannelTopicMapping[]): ChannelTopicMappingStore {
    const store = new ChannelTopicMappingStore();
    if (!Array.isArray(data)) return store;
    for (const entry of data) {
      try {
        // Minimal shape check — don't crash on garbage data
        if (
          entry &&
          typeof entry.channelId === 'string' &&
          typeof entry.telegramChatId === 'string' &&
          typeof entry.telegramThreadId === 'number' &&
          typeof entry.topicName === 'string' &&
          typeof entry.createdAt === 'number'
        ) {
          store.add(entry);
        }
      } catch {
        // Skip duplicates or invalid entries silently
      }
    }
    return store;
  }
}
