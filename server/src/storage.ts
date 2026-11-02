/**
 * Router Storage Layer
 *
 * Simple interface for storing journal entries.
 * Implementations can be swapped (in-memory, SQLite, Postgres, etc.)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Firestore } from 'firebase-admin/firestore';

// Visibility levels for entries
export type EntryVisibility = 'public' | 'private' | 'ai-only';

export interface JournalEntry {
  id: string;
  pseudonym: string;         // Legacy: "Quiet Feather#79c30b" (always present for display fallback)
  handle?: string;           // New: "james" (without @) if user has claimed a handle
  client: 'desktop' | 'mobile' | 'code';
  content: string;
  timestamp: number;
  keywords?: string[]; // Tokenized content for search
  publishAt?: number; // When entry becomes public. If undefined or in past, entry is published.
  isReflection?: boolean; // True for longform markdown reflections
  model?: string; // Model that wrote the entry (e.g., "claude-sonnet-4", "opus-4")
  humanVisible?: boolean; // @deprecated Use aiOnly. Show full content in human feed? Default true. False = AI-only (stub shown)
  aiOnly?: boolean; // Humans see stub, full content only via AI search. Orthogonal to access control.
  topicHints?: string[]; // For AI-only entries: topics covered (e.g., ["auth", "TEE"])

  // Unified addressing system
  to?: string[];             // Destinations: @handles, #channels, emails, webhook URLs. Empty = public.
  inReplyTo?: string;        // Parent entry ID (for threading)
  visibility?: EntryVisibility; // @deprecated Derived from `to`. Kept for backward compat.

  // Channel
  channel?: string;          // @deprecated Use #channel in `to`. Channel ID if posted via a channel skill.

  // Moderation state for staged entries only. Must not persist to published storage.
  moderationHeld?: boolean;
  moderationHoldReason?: string;
  moderationHeldBy?: string;   // 'automated' for automated review, else the moderator's handle
  scheduledPublishAt?: number; // publishAt before the hold; a release never publishes earlier
}

export interface Summary {
  id: string;
  pseudonym: string;
  content: string;
  timestamp: number; // When summary was created
  entryIds: string[]; // IDs of entries covered by this summary
  startTime: number; // Timestamp of first entry in summary
  endTime: number; // Timestamp of last entry in summary
}

export interface DailySummary {
  id: string;
  date: string; // YYYY-MM-DD format
  content: string;
  timestamp: number; // When summary was created
  entryCount: number;
  pseudonyms: string[]; // Pseudonyms who contributed that day
}

export interface Conversation {
  id: string;
  pseudonym: string;
  sourceUrl: string;
  platform: 'chatgpt' | 'claude' | 'gemini' | 'grok';
  title: string;
  content: string;           // Full conversation text (markdown from Firecrawl)
  summary: string;           // AI-generated 2-3 sentence summary
  timestamp: number;
  keywords: string[];        // Tokenized from content for search
  publishAt?: number;        // Staging delay (same as entries)
  humanVisible?: boolean;    // Show full content in human feed? Default false for imports.
}

export interface EmailPrefs {
  comments: boolean;         // Receive comment notifications
  digest: boolean;           // Receive daily digest
}

export interface EmailVerification {
  token: string;             // Verification token
  email: string;             // Email being verified
  expiresAt: number;         // Token expiration timestamp
}

// Parameter definition for user-created skills
export interface SkillParameter {
  name: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  description: string;
  required?: boolean;
  enum?: string[];
  default?: any;
}

// Skill definition (used for MCP tool definitions)
export interface Skill {
  id: string;                // Unique ID for the skill
  name: string;              // Tool name (e.g., "router_write_entry")
  description: string;       // What this skill does
  instructions: string;      // Detailed instructions for Claude to follow
  inputSchema?: Record<string, any>;  // For builtin skills (complex schemas)
  parameters?: SkillParameter[];      // For user skills (generates inputSchema)

  // Handler type
  handlerType?: 'builtin' | 'instructions';  // 'builtin' = server handles, 'instructions' = Claude follows instructions

  // Trigger
  triggerCondition?: string;           // e.g., "when user mentions Project X"

  // Addressing (for user skills)
  to?: string[];                       // @handles, #channels, emails, webhook URLs
  visibility?: EntryVisibility;        // @deprecated Use aiOnly + to. Default for entries created by this skill.
  humanVisible?: boolean;              // @deprecated Use aiOnly. Override user default.
  aiOnly?: boolean;                    // Entries from this skill are AI-only

  // Gallery
  public?: boolean;                    // Visible in gallery
  author?: string;                     // Creator handle
  clonedFrom?: string;                 // "author/skillId"
  cloneCount?: number;

  // Metadata
  createdAt: number;
  updatedAt?: number;
}

export interface User {
  handle: string;            // @james (unique, primary key, stored without @)
  secretKeyHash: string;     // SHA-256 hash of the secret key
  displayName?: string;      // "James"
  pronouns?: string;         // "they/them"
  bio?: string;              // "Building things"
  email?: string;            // For digest/messaging
  emailVerified?: boolean;   // Whether email has been verified via link
  emailPrefs?: EmailPrefs;   // Email notification preferences
  links?: string[];          // External links (Twitter, website, etc.)
  stagingDelayMs?: number;   // How long entries stay in staging (default 1 hour)
  createdAt: number;
  legacyPseudonym?: string;  // "Quiet Feather#79c30b" if migrated from old system
  defaultHumanVisible?: boolean; // @deprecated Use defaultAiOnly. Default visibility for new entries (default true)
  defaultAiOnly?: boolean; // Default: false. When true, new entries are AI-only (humans see stub).
  skillOverrides?: Record<string, Partial<Skill>>;  // Overrides for system tools (key = tool name)
  skills?: Skill[];                                  // User-created skills
  following?: { handle: string; note: string }[];  // Users this person follows, with living notes
  onboardedAt?: number;  // Set on first meaningful action (write, follow, clone)
  lastDailyQuestionAt?: number;  // UTC timestamp of last daily question trigger, resets by calendar day
  /** Linked platform accounts — Matrix, Telegram, Discord, etc. */
  linkedAccounts?: LinkedAccount[];
}

/**
 * A linked platform account.
 * Maps a Router identity to an identity on an external platform.
 */
export interface LinkedAccount {
  platform: string;          // "matrix", "telegram", "discord", etc.
  platformUserId: string;    // "@james:matrix.org", "123456789", etc.
  linkedAt: number;          // When the link was created
  verified?: boolean;        // Whether ownership has been verified
}

// ─────────────────────────────────────────────────────────────
// Channel types
// ─────────────────────────────────────────────────────────────

export interface ChannelSubscriber {
  handle: string;
  role: 'admin' | 'member';
  joinedAt: number;
}

export interface Channel {
  id: string;                    // slug, e.g. "flashbots"
  name: string;                  // display name, e.g. "Flashbots"
  description?: string;          // what this channel is about
  visibility: 'public' | 'private';  // @deprecated Use joinRule. Kept for backward compat.
  joinRule?: 'open' | 'invite';  // Who can join: 'open' = anyone, 'invite' = need token. Replaces visibility.
  createdBy: string;             // handle of creator
  createdAt: number;
  skills: Skill[];               // channel-scoped skills
  subscribers: ChannelSubscriber[];
  // Group posts stored in the owner's TinyCloud space instead of the Router database (see group-store.ts)
  store?: {
    kind: 'tinycloud';
    prefix: string;       // groups/<id>/ in the owner's space
    delegation?: string;  // the owner's serialized grant to the Router (bound to the Router's key)
    space?: string;       // owner's TinyCloud space id
  };
}

export interface ChannelInvite {
  token: string;                 // random token for invite links
  channelId: string;
  createdBy: string;
  createdAt: number;
  expiresAt?: number;
  maxUses?: number;
  uses: number;
  forHandle?: string;            // personal invite: only this handle may use it
}

/** Who is using an invite, and for which channel. Checked before the invite is consumed. */
export interface InviteUse {
  channelId: string;
  handle: string;
}

/**
 * An invite opens only the channel it was made for, and a personal invite only
 * for its recipient. Throws before anything is consumed.
 */
export function checkInviteUse(invite: ChannelInvite, use: InviteUse): void {
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    throw new Error('Invite has expired.');
  }
  if (invite.maxUses && invite.uses >= invite.maxUses) {
    throw new Error('Invite has reached maximum uses.');
  }
  if (invite.channelId !== use.channelId) {
    throw new Error('Invite is not valid for this channel.');
  }
  if (invite.forHandle && invite.forHandle.toLowerCase() !== use.handle.toLowerCase()) {
    throw new Error('Invite is not valid for this account.');
  }
}

/** Validate channel ID: lowercase alphanumeric + hyphens, 2-30 chars, no leading/trailing hyphens */
export function isValidChannelId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/.test(id);
}

// Common stop words to exclude from search
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been',
  'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
  'she', 'we', 'they', 'what', 'which', 'who', 'whom', 'whose', 'where',
  'when', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'own',
  'same', 'so', 'than', 'too', 'very', 'just', 'about', 'into', 'through',
  'during', 'before', 'after', 'above', 'below', 'between', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'any', 'also', 'being', 'their',
  'them', 'him', 'her', 'our', 'your', 'out', 'up', 'down', 'off', 'over',
]);

/**
 * Tokenize text into searchable keywords
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter(word => word.length > 2)
    .filter(word => !STOP_WORDS.has(word))
    .filter((word, index, arr) => arr.indexOf(word) === index); // unique
}

interface PageCursor {
  t: number;
  id: string;
}

function decodePageCursorInternal(cursor?: string): PageCursor | null {
  if (!cursor) return null;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as PageCursor;
    if (typeof decoded?.t !== 'number' || typeof decoded?.id !== 'string' || !Number.isFinite(decoded.t) || decoded.id.length === 0) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

export function encodePageCursor(item: { timestamp: number; id: string }): string {
  return Buffer.from(JSON.stringify({ t: item.timestamp, id: item.id }), 'utf8').toString('base64url');
}

function compareByFeedOrder(a: { timestamp: number; id: string }, b: { timestamp: number; id: string }): number {
  if (a.timestamp !== b.timestamp) return b.timestamp - a.timestamp;
  return b.id.localeCompare(a.id);
}

export interface Storage {
  /** Add a new entry. stagingDelayMs overrides the default staging delay (StagedStorage only). */
  addEntry(entry: Omit<JournalEntry, 'id'>, stagingDelayMs?: number): Promise<JournalEntry>;

  /** Get a single entry by ID */
  getEntry(id: string): Promise<JournalEntry | null>;

  /** Get recent entries (newest first) */
  getEntries(limit?: number, offset?: number, cursor?: string): Promise<JournalEntry[]>;

  /** Get entries by pseudonym */
  getEntriesByPseudonym(pseudonym: string, limit?: number): Promise<JournalEntry[]>;

  /** Get entries by handle */
  getEntriesByHandle(handle: string, limit?: number, since?: number): Promise<JournalEntry[]>;

  /** Search entries by keywords */
  searchEntries(query: string, limit?: number, since?: number): Promise<JournalEntry[]>;

  /** Get all entries since a timestamp */
  getEntriesSince(since: number, limit?: number): Promise<JournalEntry[]>;

  /** Get total entry count */
  getEntryCount(): Promise<number>;

  /** Delete an entry by ID */
  deleteEntry(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // User methods
  // ─────────────────────────────────────────────────────────────

  /** Create a new user (register handle) */
  createUser(user: Omit<User, 'createdAt'>): Promise<User>;

  /** Get user by handle */
  getUser(handle: string): Promise<User | null>;

  /** Get user by secret key hash */
  getUserByKeyHash(keyHash: string): Promise<User | null>;

  /** Update user profile */
  updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null>;

  /** Check if handle is available */
  isHandleAvailable(handle: string): Promise<boolean>;

  /** Migrate entries from pseudonym to handle (when user claims handle) */
  migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number>;

  /** Get all users with a legacyPseudonym (for migration) */
  getUsersWithLegacyPseudonym(): Promise<User[]>;

  /** Count entries with pseudonym but without handle (unmigrated) */
  countUnmigratedEntries(pseudonym: string, handle: string): Promise<number>;

  /** Get all users with email addresses (for digest sending) */
  getUsersWithEmail(): Promise<User[]>;

  /** Search users by handle prefix (for @mention typeahead) */
  searchUsers(prefix: string, limit?: number): Promise<User[]>;

  /** Get user by email address (case-insensitive) */
  getUserByEmail(email: string): Promise<User | null>;

  /** Get total user count */
  getUserCount(): Promise<number>;

  /** Get all users (for public skills gallery, etc.) */
  getAllUsers(): Promise<User[]>;

  /** Get entries addressed to a user (by handle or email) */
  getEntriesAddressedTo(handle: string, email?: string, limit?: number): Promise<JournalEntry[]>;

  /** Get replies to an entry */
  getRepliesTo(entryId: string, limit?: number): Promise<JournalEntry[]>;

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  /** Add a new conversation */
  addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation>;

  /** Get a single conversation by ID */
  getConversation(id: string): Promise<Conversation | null>;

  /** Get recent conversations (newest first) */
  getConversations(limit?: number, offset?: number, cursor?: string): Promise<Conversation[]>;

  /** Get conversations by pseudonym */
  getConversationsByPseudonym(pseudonym: string, limit?: number): Promise<Conversation[]>;

  /** Search conversations by keywords */
  searchConversations(query: string, limit?: number, since?: number): Promise<Conversation[]>;

  /** Delete a conversation by ID */
  deleteConversation(id: string): Promise<void>;

  // ─────────────────────────────────────────────────────────────
  // Channel methods
  // ─────────────────────────────────────────────────────────────

  /** Create a new channel */
  createChannel(channel: Channel): Promise<Channel>;

  /** Get a channel by ID */
  getChannel(id: string): Promise<Channel | null>;

  /** Update a channel */
  updateChannel(id: string, updates: Partial<Omit<Channel, 'id' | 'createdBy' | 'createdAt'>>): Promise<Channel | null>;

  /** Delete a channel */
  deleteChannel(id: string): Promise<void>;

  /** List channels, optionally filtered by subscriber handle, visibility, or joinRule */
  listChannels(opts?: { handle?: string; visibility?: string; joinRule?: string }): Promise<Channel[]>;

  /** Add a subscriber to a channel */
  addSubscriber(channelId: string, handle: string, role: 'admin' | 'member'): Promise<void>;

  /** Remove a subscriber from a channel */
  removeSubscriber(channelId: string, handle: string): Promise<void>;

  /** Get all channels a user is subscribed to */
  getSubscribedChannels(handle: string): Promise<Channel[]>;

  /** Create an invite for a channel */
  createInvite(invite: ChannelInvite): Promise<ChannelInvite>;

  /** Get an invite by token */
  getInvite(token: string): Promise<ChannelInvite | null>;

  /** Use an invite (increment uses, return the channel) */
  useInvite(token: string, use: InviteUse): Promise<Channel>;

  /** Get entries for a channel */
  getChannelEntries(channelId: string, limit?: number): Promise<JournalEntry[]>;

  /** Get the private spark room for a pair of handles, if one exists */
  getSparkPairRoom(handleA: string, handleB: string): Promise<string | null>;

  /** Persist the private spark room for a pair of handles */
  setSparkPairRoom(handleA: string, handleB: string, roomId: string): Promise<void>;

}

function getSparkPairKey(handleA: string, handleB: string): string {
  return [handleA.toLowerCase(), handleB.toLowerCase()].sort().join(':');
}

/**
 * In-memory storage for development/testing
 */
export class MemoryStorage implements Storage {
  private entries: JournalEntry[] = [];
  private users: Map<string, User> = new Map(); // handle -> User
  private nextId = 1;
  private sparkPairRooms: Map<string, string> = new Map();

  async addEntry(entry: Omit<JournalEntry, 'id'>, _stagingDelayMs?: number): Promise<JournalEntry> {
    const newEntry: JournalEntry = {
      ...entry,
      id: String(this.nextId++),
    };
    this.entries.unshift(newEntry); // Add to front for newest-first ordering
    return newEntry;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    return this.entries.find(e => e.id === id) || null;
  }

  async getEntries(limit = 50, offset = 0, cursor?: string): Promise<JournalEntry[]> {
    const parsedCursor = decodePageCursorInternal(cursor);
    if (parsedCursor) {
      return this.entries
        .slice()
        .sort(compareByFeedOrder)
        .filter(e => compareByFeedOrder(e, { timestamp: parsedCursor.t, id: parsedCursor.id }) > 0)
        .slice(0, limit);
    }
    return this.entries.slice(offset, offset + limit);
  }

  async getEntriesByPseudonym(pseudonym: string, limit = 50): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.pseudonym === pseudonym)
      .slice(0, limit);
  }

  async getEntriesByHandle(handle: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.handle === handle && (!since || e.timestamp >= since))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getEntryCount(): Promise<number> {
    return this.entries.length;
  }

  async getEntriesSince(since: number, limit = 50): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.timestamp >= since)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async searchEntries(query: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    return this.entries
      .filter(e => {
        if (since && e.timestamp < since) return false;
        const entryKeywords = e.keywords || tokenize(e.content);
        return queryKeywords.some(qk => entryKeywords.includes(qk));
      })
      .slice(0, limit);
  }

  async deleteEntry(id: string): Promise<void> {
    this.entries = this.entries.filter(e => e.id !== id);
  }

  // ─────────────────────────────────────────────────────────────
  // User methods
  // ─────────────────────────────────────────────────────────────

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    const newUser: User = {
      ...user,
      createdAt: Date.now(),
    };
    this.users.set(user.handle, newUser);
    return newUser;
  }

  async getUser(handle: string): Promise<User | null> {
    return this.users.get(handle) || null;
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    for (const user of this.users.values()) {
      if (user.secretKeyHash === keyHash) {
        return user;
      }
    }
    return null;
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    const user = this.users.get(handle);
    if (!user) return null;

    const updated = { ...user, ...updates };
    this.users.set(handle, updated);
    return updated;
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    return !this.users.has(handle);
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    let count = 0;
    this.entries = this.entries.map(e => {
      if (e.pseudonym === pseudonym) {
        count++;
        return { ...e, handle };
      }
      return e;
    });
    return count;
  }

  async getUsersWithLegacyPseudonym(): Promise<User[]> {
    return Array.from(this.users.values()).filter(u => u.legacyPseudonym);
  }

  async countUnmigratedEntries(pseudonym: string, handle: string): Promise<number> {
    return this.entries.filter(e => e.pseudonym === pseudonym && e.handle !== handle).length;
  }

  async getUsersWithEmail(): Promise<User[]> {
    return Array.from(this.users.values()).filter(u => u.email);
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    const lowerPrefix = prefix.toLowerCase();
    return Array.from(this.users.values())
      .filter(u => u.handle.toLowerCase().startsWith(lowerPrefix))
      .slice(0, limit);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const lowerEmail = email.toLowerCase();
    for (const user of this.users.values()) {
      if (user.email?.toLowerCase() === lowerEmail) {
        return user;
      }
    }
    return null;
  }

  async getUserCount(): Promise<number> {
    return this.users.size;
  }

  async getAllUsers(): Promise<User[]> {
    return Array.from(this.users.values());
  }

  async getEntriesAddressedTo(handle: string, email?: string, limit = 50): Promise<JournalEntry[]> {
    const handlePattern = `@${handle}`;
    return this.entries
      .filter(e => {
        if (!e.to || e.to.length === 0) return false;
        return e.to.some(dest =>
          dest === handlePattern ||
          dest === handle ||
          (email && dest.toLowerCase() === email.toLowerCase())
        );
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getRepliesTo(entryId: string, limit = 50): Promise<JournalEntry[]> {
    return this.entries
      .filter(e => e.inReplyTo === entryId)
      .sort((a, b) => a.timestamp - b.timestamp) // Oldest first for replies
      .slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  private conversations: Conversation[] = [];

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    const newConversation: Conversation = {
      ...conversation,
      id: String(this.nextId++),
    };
    this.conversations.unshift(newConversation);
    return newConversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return this.conversations.find(c => c.id === id) || null;
  }

  async getConversations(limit = 50, offset = 0, cursor?: string): Promise<Conversation[]> {
    const parsedCursor = decodePageCursorInternal(cursor);
    if (parsedCursor) {
      return this.conversations
        .slice()
        .sort(compareByFeedOrder)
        .filter(c => compareByFeedOrder(c, { timestamp: parsedCursor.t, id: parsedCursor.id }) > 0)
        .slice(0, limit);
    }
    return this.conversations.slice(offset, offset + limit);
  }

  async getConversationsByPseudonym(pseudonym: string, limit = 50): Promise<Conversation[]> {
    return this.conversations
      .filter(c => c.pseudonym === pseudonym)
      .slice(0, limit);
  }

  async searchConversations(query: string, limit = 50, since?: number): Promise<Conversation[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    return this.conversations
      .filter(c => {
        if (since && c.timestamp < since) return false;
        return queryKeywords.some(qk => c.keywords.includes(qk));
      })
      .slice(0, limit);
  }

  async deleteConversation(id: string): Promise<void> {
    this.conversations = this.conversations.filter(c => c.id !== id);
  }

  // ─────────────────────────────────────────────────────────────
  // Channel methods
  // ─────────────────────────────────────────────────────────────

  private channels: Map<string, Channel> = new Map();
  private invites: Map<string, ChannelInvite> = new Map();

  async createChannel(channel: Channel): Promise<Channel> {
    if (this.channels.has(channel.id)) {
      throw new Error(`Channel "${channel.id}" already exists.`);
    }
    this.channels.set(channel.id, { ...channel });
    return channel;
  }

  async getChannel(id: string): Promise<Channel | null> {
    return this.channels.get(id) || null;
  }

  async updateChannel(id: string, updates: Partial<Omit<Channel, 'id' | 'createdBy' | 'createdAt'>>): Promise<Channel | null> {
    const channel = this.channels.get(id);
    if (!channel) return null;
    const updated = { ...channel, ...updates };
    this.channels.set(id, updated);
    return updated;
  }

  async deleteChannel(id: string): Promise<void> {
    this.channels.delete(id);
    // Also clean up invites for this channel
    for (const [token, invite] of this.invites) {
      if (invite.channelId === id) {
        this.invites.delete(token);
      }
    }
  }

  async listChannels(opts?: { handle?: string; visibility?: string; joinRule?: string }): Promise<Channel[]> {
    let channels = Array.from(this.channels.values());
    if (opts?.handle) {
      channels = channels.filter(c =>
        c.subscribers.some(s => s.handle === opts.handle)
      );
    }
    if (opts?.visibility) {
      channels = channels.filter(c => c.visibility === opts.visibility);
    }
    if (opts?.joinRule) {
      channels = channels.filter(c => {
        // Map legacy visibility to joinRule for filtering
        const effectiveJoinRule = c.joinRule || (c.visibility === 'private' ? 'invite' : 'open');
        return effectiveJoinRule === opts.joinRule;
      });
    }
    return channels;
  }

  async addSubscriber(channelId: string, handle: string, role: 'admin' | 'member'): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel "${channelId}" not found.`);
    // Check if already subscribed
    if (channel.subscribers.some(s => s.handle === handle)) {
      return; // Already subscribed, no-op
    }
    channel.subscribers.push({ handle, role, joinedAt: Date.now() });
  }

  async removeSubscriber(channelId: string, handle: string): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`Channel "${channelId}" not found.`);
    channel.subscribers = channel.subscribers.filter(s => s.handle !== handle);
  }

  async getSubscribedChannels(handle: string): Promise<Channel[]> {
    return Array.from(this.channels.values()).filter(c =>
      c.subscribers.some(s => s.handle === handle)
    );
  }

  async createInvite(invite: ChannelInvite): Promise<ChannelInvite> {
    this.invites.set(invite.token, { ...invite });
    return invite;
  }

  async getInvite(token: string): Promise<ChannelInvite | null> {
    return this.invites.get(token) || null;
  }

  async useInvite(token: string, use: InviteUse): Promise<Channel> {
    const invite = this.invites.get(token);
    if (!invite) throw new Error('Invite not found.');
    checkInviteUse(invite, use);
    invite.uses++;
    const channel = this.channels.get(invite.channelId);
    if (!channel) throw new Error(`Channel "${invite.channelId}" not found.`);
    return channel;
  }

  async getChannelEntries(channelId: string, limit = 50): Promise<JournalEntry[]> {
    const channelDest = `#${channelId}`;
    return this.entries
      .filter(e => e.channel === channelId || (e.to && e.to.includes(channelDest)))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getSparkPairRoom(handleA: string, handleB: string): Promise<string | null> {
    return this.sparkPairRooms.get(getSparkPairKey(handleA, handleB)) || null;
  }

  async setSparkPairRoom(handleA: string, handleB: string, roomId: string): Promise<void> {
    this.sparkPairRooms.set(getSparkPairKey(handleA, handleB), roomId);
  }

}

/**
 * Generate a unique entry ID
 */
export function generateEntryId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `${timestamp}-${random}`;
}

/**
 * Firestore storage for production
 */
export class FirestoreStorage implements Storage {
  private db: Firestore;
  private collection = 'entries';

  constructor() {
    // Initialize Firebase if not already initialized
    if (getApps().length === 0) {
      const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
      const serviceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
      const serviceAccountPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;

      if (serviceAccountBase64) {
        // Base64-encoded JSON in env var
        const decoded = Buffer.from(serviceAccountBase64, 'base64').toString('utf-8');
        initializeApp({
          credential: cert(JSON.parse(decoded)),
        });
      } else if (serviceAccountJson) {
        // JSON string in env var
        initializeApp({
          credential: cert(JSON.parse(serviceAccountJson)),
        });
      } else if (serviceAccountPath) {
        // Path to JSON file
        initializeApp({
          credential: cert(serviceAccountPath),
        });
      } else {
        // Use application default credentials (for local dev with gcloud auth)
        initializeApp();
      }
    }
    this.db = getFirestore();
  }

  async addEntry(entry: Omit<JournalEntry, 'id'>, _stagingDelayMs?: number): Promise<JournalEntry> {
    const id = generateEntryId();
    const keywords = tokenize(entry.content);
    const newEntry: JournalEntry = { ...entry, id, keywords };

    const docData: Record<string, any> = {
      pseudonym: newEntry.pseudonym,
      client: newEntry.client,
      content: newEntry.content,
      timestamp: newEntry.timestamp,
      keywords,
    };

    if (newEntry.handle) {
      docData.handle = newEntry.handle;
    }

    if (newEntry.isReflection) {
      docData.isReflection = true;
    }

    if (newEntry.model) {
      docData.model = newEntry.model;
    }

    if (newEntry.humanVisible !== undefined) {
      docData.humanVisible = newEntry.humanVisible;
    }

    if (newEntry.aiOnly !== undefined) {
      docData.aiOnly = newEntry.aiOnly;
    }

    if (newEntry.topicHints && newEntry.topicHints.length > 0) {
      docData.topicHints = newEntry.topicHints;
    }

    // Unified addressing fields
    if (newEntry.to && newEntry.to.length > 0) {
      docData.to = newEntry.to;
    }

    if (newEntry.inReplyTo) {
      docData.inReplyTo = newEntry.inReplyTo;
    }

    if (newEntry.visibility) {
      docData.visibility = newEntry.visibility;
    }

    if (newEntry.channel) {
      docData.channel = newEntry.channel;
    }

    await this.db.collection(this.collection).doc(id).set(docData);

    return newEntry;
  }

  async getEntries(limit = 50, offset = 0, cursor?: string): Promise<JournalEntry[]> {
    let query: FirebaseFirestore.Query = this.db
      .collection(this.collection)
      .orderBy('timestamp', 'desc')
      .orderBy('__name__', 'desc');

    const parsedCursor = decodePageCursorInternal(cursor);
    if (parsedCursor) {
      query = query.startAfter(parsedCursor.t, parsedCursor.id);
    } else if (offset > 0) {
      query = query.offset(offset);
    }

    const snapshot = await query.limit(limit).get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async getEntriesByPseudonym(pseudonym: string, limit = 50): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async getEntriesByHandle(handle: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    let query = this.db
      .collection(this.collection)
      .where('handle', '==', handle);
    if (since) {
      query = query.where('timestamp', '>=', since);
    }
    const snapshot = await query
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async getEntryCount(): Promise<number> {
    const snapshot = await this.db.collection(this.collection).count().get();
    return snapshot.data().count;
  }

  async getEntriesSince(since: number, limit = 50): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    const doc = await this.db.collection(this.collection).doc(id).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as JournalEntry;
  }

  async deleteEntry(id: string): Promise<void> {
    await this.db.collection(this.collection).doc(id).delete();
  }

  async searchEntries(query: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    // Firestore array-contains-any supports up to 30 values
    const searchKeywords = queryKeywords.slice(0, 30);

    let firestoreQuery = this.db
      .collection(this.collection)
      .where('keywords', 'array-contains-any', searchKeywords);
    if (since) {
      firestoreQuery = firestoreQuery.where('timestamp', '>=', since);
    }
    const snapshot = await firestoreQuery
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  // ─────────────────────────────────────────────────────────────
  // User methods
  // ─────────────────────────────────────────────────────────────

  private usersCollection = 'users';

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    const newUser: User = {
      ...user,
      createdAt: Date.now(),
    };

    await this.db.collection(this.usersCollection).doc(user.handle).set({
      secretKeyHash: newUser.secretKeyHash,
      displayName: newUser.displayName || null,
      bio: newUser.bio || null,
      email: newUser.email || null,
      emailPrefs: newUser.emailPrefs || null,
      links: newUser.links || [],
      createdAt: newUser.createdAt,
      legacyPseudonym: newUser.legacyPseudonym || null,
    });

    return newUser;
  }

  async getUser(handle: string): Promise<User | null> {
    const doc = await this.db.collection(this.usersCollection).doc(handle).get();
    if (!doc.exists) return null;
    const data = doc.data()!;

    return {
      handle: doc.id,
      ...data,
    } as User;
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('secretKeyHash', '==', keyHash)
      .limit(1)
      .get();

    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const data = doc.data()!;

    return {
      handle: doc.id,
      ...data,
    } as User;
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    const userRef = this.db.collection(this.usersCollection).doc(handle);
    const doc = await userRef.get();
    if (!doc.exists) return null;

    await userRef.update(updates);

    const updated = await userRef.get();
    const data = updated.data()!;

    return {
      handle: updated.id,
      ...data,
    } as User;
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    const doc = await this.db.collection(this.usersCollection).doc(handle).get();
    return !doc.exists;
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    // Get all entries with this pseudonym
    console.log(`[FirestoreStorage] migrateEntriesToHandle: querying for pseudonym="${pseudonym}"`);
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .get();

    console.log(`[FirestoreStorage] Found ${snapshot.size} entries to migrate`);

    if (snapshot.size === 0) {
      return 0;
    }

    // Firestore batches are limited to 500 operations
    // Process in chunks if needed
    const BATCH_SIZE = 500;
    let totalMigrated = 0;

    for (let i = 0; i < snapshot.docs.length; i += BATCH_SIZE) {
      const chunk = snapshot.docs.slice(i, i + BATCH_SIZE);
      const batch = this.db.batch();

      chunk.forEach(doc => {
        batch.update(doc.ref, { handle });
      });

      await batch.commit();
      totalMigrated += chunk.length;
      console.log(`[FirestoreStorage] Migrated batch ${Math.floor(i / BATCH_SIZE) + 1}: ${chunk.length} entries`);
    }

    console.log(`[FirestoreStorage] Migration complete: ${totalMigrated} total entries migrated to @${handle}`);
    return totalMigrated;
  }

  async getUsersWithLegacyPseudonym(): Promise<User[]> {
    // Query users where legacyPseudonym exists and is not null
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('legacyPseudonym', '!=', null)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
  }

  async countUnmigratedEntries(pseudonym: string, handle: string): Promise<number> {
    // Count entries with this pseudonym that don't have the handle
    // Firestore doesn't support != queries well, so we query by pseudonym
    // and filter in memory
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .get();

    return snapshot.docs.filter(doc => doc.data().handle !== handle).length;
  }

  async getUsersWithEmail(): Promise<User[]> {
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('email', '!=', null)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    // Firestore prefix search: >= prefix and < prefix + high unicode char
    const endPrefix = prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1);
    const snapshot = await this.db
      .collection(this.usersCollection)
      .where('__name__', '>=', prefix.toLowerCase())
      .where('__name__', '<', endPrefix.toLowerCase())
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
  }

  async getUserCount(): Promise<number> {
    const snapshot = await this.db.collection(this.usersCollection).count().get();
    return snapshot.data().count;
  }

  async getAllUsers(): Promise<User[]> {
    const snapshot = await this.db.collection(this.usersCollection).get();
    return snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        handle: doc.id,
        ...data,
      } as User;
    });
  }

  async getUserByEmail(email: string): Promise<User | null> {
    const lowerEmail = email.toLowerCase();
    const snapshot = await this.db
      .collection(this.usersCollection)
      .get();

    // Filter in memory since Firestore doesn't support case-insensitive queries
    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.email?.toLowerCase() === lowerEmail) {
        return {
          handle: doc.id,
          ...data,
        } as User;
      }
    }
    return null;
  }

  async getEntriesAddressedTo(handle: string, email?: string, limit = 50): Promise<JournalEntry[]> {
    // Firestore doesn't support array-contains-any with multiple patterns well,
    // so we query for handle pattern and filter for email in memory
    const handlePattern = `@${handle}`;

    // Try querying by handle first
    const byHandle = await this.db
      .collection(this.collection)
      .where('to', 'array-contains', handlePattern)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    const results: JournalEntry[] = byHandle.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));

    // If email provided, also query by email and merge (dedup by id)
    if (email) {
      const byEmail = await this.db
        .collection(this.collection)
        .where('to', 'array-contains', email.toLowerCase())
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get();

      const existingIds = new Set(results.map(e => e.id));
      for (const doc of byEmail.docs) {
        if (!existingIds.has(doc.id)) {
          results.push({
            id: doc.id,
            ...doc.data(),
          } as JournalEntry);
        }
      }
    }

    // Sort merged results and limit
    return results
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getRepliesTo(entryId: string, limit = 50): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('inReplyTo', '==', entryId)
      .orderBy('timestamp', 'asc') // Oldest first for replies
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  // ─────────────────────────────────────────────────────────────
  // Summary methods
  // ─────────────────────────────────────────────────────────────

  async addSummary(summary: Omit<Summary, 'id'>): Promise<Summary> {
    const id = generateEntryId();
    const newSummary: Summary = { ...summary, id };

    await this.db.collection('summaries').doc(id).set({
      pseudonym: newSummary.pseudonym,
      content: newSummary.content,
      timestamp: newSummary.timestamp,
      entryIds: newSummary.entryIds,
      startTime: newSummary.startTime,
      endTime: newSummary.endTime,
    });

    return newSummary;
  }

  async getSummaries(limit = 50): Promise<Summary[]> {
    const snapshot = await this.db
      .collection('summaries')
      .orderBy('endTime', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Summary));
  }

  async getLastSummaryForPseudonym(pseudonym: string): Promise<Summary | null> {
    const snapshot = await this.db
      .collection('summaries')
      .where('pseudonym', '==', pseudonym)
      .orderBy('endTime', 'desc')
      .limit(1)
      .get();

    if (snapshot.empty) return null;

    const doc = snapshot.docs[0];
    return {
      id: doc.id,
      ...doc.data(),
    } as Summary;
  }

  async getEntriesInRange(pseudonym: string, startTime: number, endTime: number): Promise<JournalEntry[]> {
    const snapshot = await this.db
      .collection(this.collection)
      .where('pseudonym', '==', pseudonym)
      .where('timestamp', '>=', startTime)
      .where('timestamp', '<=', endTime)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  async deleteSummary(id: string): Promise<void> {
    await this.db.collection('summaries').doc(id).delete();
  }

  // ─────────────────────────────────────────────────────────────
  // Daily Summary methods
  // ─────────────────────────────────────────────────────────────

  async addDailySummary(summary: Omit<DailySummary, 'id'>): Promise<DailySummary> {
    const id = `daily-${summary.date}`;
    const newSummary: DailySummary = { ...summary, id };

    await this.db.collection('dailySummaries').doc(id).set({
      date: newSummary.date,
      content: newSummary.content,
      timestamp: newSummary.timestamp,
      entryCount: newSummary.entryCount,
      pseudonyms: newSummary.pseudonyms,
    });

    return newSummary;
  }

  async getDailySummaries(limit = 30): Promise<DailySummary[]> {
    const snapshot = await this.db
      .collection('dailySummaries')
      .orderBy('date', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as DailySummary));
  }

  async getDailySummary(date: string): Promise<DailySummary | null> {
    const doc = await this.db.collection('dailySummaries').doc(`daily-${date}`).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as DailySummary;
  }

  async deleteDailySummary(date: string): Promise<void> {
    await this.db.collection('dailySummaries').doc(`daily-${date}`).delete();
  }

  async getEntriesForDate(date: string): Promise<JournalEntry[]> {
    // Parse date and get start/end timestamps
    const startOfDay = new Date(date + 'T00:00:00Z').getTime();
    const endOfDay = new Date(date + 'T23:59:59.999Z').getTime();

    const snapshot = await this.db
      .collection(this.collection)
      .where('timestamp', '>=', startOfDay)
      .where('timestamp', '<=', endOfDay)
      .orderBy('timestamp', 'asc')
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as JournalEntry));
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods
  // ─────────────────────────────────────────────────────────────

  private conversationsCollection = 'imported_conversations';

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    const id = generateEntryId();
    const newConversation: Conversation = { ...conversation, id };

    const docData: Record<string, any> = {
      pseudonym: newConversation.pseudonym,
      sourceUrl: newConversation.sourceUrl,
      platform: newConversation.platform,
      title: newConversation.title,
      content: newConversation.content,
      summary: newConversation.summary,
      timestamp: newConversation.timestamp,
      keywords: newConversation.keywords,
    };

    if (newConversation.humanVisible !== undefined) {
      docData.humanVisible = newConversation.humanVisible;
    }

    await this.db.collection(this.conversationsCollection).doc(id).set(docData);

    return newConversation;
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const doc = await this.db.collection(this.conversationsCollection).doc(id).get();
    if (!doc.exists) return null;
    return {
      id: doc.id,
      ...doc.data(),
    } as Conversation;
  }

  async getConversations(limit = 50, offset = 0, cursor?: string): Promise<Conversation[]> {
    let query: FirebaseFirestore.Query = this.db
      .collection(this.conversationsCollection)
      .orderBy('timestamp', 'desc')
      .orderBy('__name__', 'desc');

    const parsedCursor = decodePageCursorInternal(cursor);
    if (parsedCursor) {
      query = query.startAfter(parsedCursor.t, parsedCursor.id);
    } else if (offset > 0) {
      query = query.offset(offset);
    }

    const snapshot = await query.limit(limit).get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Conversation));
  }

  async getConversationsByPseudonym(pseudonym: string, limit = 50): Promise<Conversation[]> {
    const snapshot = await this.db
      .collection(this.conversationsCollection)
      .where('pseudonym', '==', pseudonym)
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Conversation));
  }

  async searchConversations(query: string, limit = 50, since?: number): Promise<Conversation[]> {
    const queryKeywords = tokenize(query);
    if (queryKeywords.length === 0) return [];

    // Firestore array-contains-any supports up to 30 values
    const searchKeywords = queryKeywords.slice(0, 30);

    let firestoreQuery = this.db
      .collection(this.conversationsCollection)
      .where('keywords', 'array-contains-any', searchKeywords);
    if (since) {
      firestoreQuery = firestoreQuery.where('timestamp', '>=', since);
    }
    const snapshot = await firestoreQuery
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();

    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    } as Conversation));
  }

  async deleteConversation(id: string): Promise<void> {
    await this.db.collection(this.conversationsCollection).doc(id).delete();
  }

  // ─────────────────────────────────────────────────────────────
  // Channel methods
  // ─────────────────────────────────────────────────────────────

  private channelsCollection = 'channels';
  private invitesCollection = 'channel_invites';
  private sparkPairRoomsCollection = 'spark_pair_rooms';

  async createChannel(channel: Channel): Promise<Channel> {
    const existing = await this.db.collection(this.channelsCollection).doc(channel.id).get();
    if (existing.exists) {
      throw new Error(`Channel "${channel.id}" already exists.`);
    }
    const channelData: Record<string, any> = {
      name: channel.name,
      description: channel.description || null,
      visibility: channel.visibility,
      createdBy: channel.createdBy,
      createdAt: channel.createdAt,
      skills: channel.skills,
      subscribers: channel.subscribers,
    };
    if (channel.joinRule) {
      channelData.joinRule = channel.joinRule;
    }
    await this.db.collection(this.channelsCollection).doc(channel.id).set(channelData);
    return channel;
  }

  async getChannel(id: string): Promise<Channel | null> {
    const doc = await this.db.collection(this.channelsCollection).doc(id).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() } as Channel;
  }

  async updateChannel(id: string, updates: Partial<Omit<Channel, 'id' | 'createdBy' | 'createdAt'>>): Promise<Channel | null> {
    const ref = this.db.collection(this.channelsCollection).doc(id);
    const doc = await ref.get();
    if (!doc.exists) return null;
    await ref.update(updates);
    const updated = await ref.get();
    return { id: updated.id, ...updated.data() } as Channel;
  }

  async deleteChannel(id: string): Promise<void> {
    await this.db.collection(this.channelsCollection).doc(id).delete();
    // Clean up invites for this channel
    const invites = await this.db.collection(this.invitesCollection)
      .where('channelId', '==', id).get();
    const batch = this.db.batch();
    invites.docs.forEach(doc => batch.delete(doc.ref));
    if (!invites.empty) await batch.commit();
  }

  async listChannels(opts?: { handle?: string; visibility?: string; joinRule?: string }): Promise<Channel[]> {
    let query: FirebaseFirestore.Query = this.db.collection(this.channelsCollection);
    if (opts?.visibility) {
      query = query.where('visibility', '==', opts.visibility);
    }
    if (opts?.joinRule) {
      query = query.where('joinRule', '==', opts.joinRule);
    }
    const snapshot = await query.get();
    let channels = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Channel));
    if (opts?.handle) {
      channels = channels.filter(c => c.subscribers.some(s => s.handle === opts.handle));
    }
    return channels;
  }

  async addSubscriber(channelId: string, handle: string, role: 'admin' | 'member'): Promise<void> {
    const ref = this.db.collection(this.channelsCollection).doc(channelId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error(`Channel "${channelId}" not found.`);
    const channel = doc.data() as Omit<Channel, 'id'>;
    if (channel.subscribers.some(s => s.handle === handle)) return;
    channel.subscribers.push({ handle, role, joinedAt: Date.now() });
    await ref.update({ subscribers: channel.subscribers });
  }

  async removeSubscriber(channelId: string, handle: string): Promise<void> {
    const ref = this.db.collection(this.channelsCollection).doc(channelId);
    const doc = await ref.get();
    if (!doc.exists) throw new Error(`Channel "${channelId}" not found.`);
    const channel = doc.data() as Omit<Channel, 'id'>;
    channel.subscribers = channel.subscribers.filter(s => s.handle !== handle);
    await ref.update({ subscribers: channel.subscribers });
  }

  async getSubscribedChannels(handle: string): Promise<Channel[]> {
    // Firestore doesn't support querying array of objects by nested field well,
    // so we get all channels and filter in memory
    const snapshot = await this.db.collection(this.channelsCollection).get();
    return snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() } as Channel))
      .filter(c => c.subscribers.some(s => s.handle === handle));
  }

  async createInvite(invite: ChannelInvite): Promise<ChannelInvite> {
    await this.db.collection(this.invitesCollection).doc(invite.token).set({
      channelId: invite.channelId,
      createdBy: invite.createdBy,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt || null,
      maxUses: invite.maxUses || null,
      uses: invite.uses,
    });
    return invite;
  }

  async getInvite(token: string): Promise<ChannelInvite | null> {
    const doc = await this.db.collection(this.invitesCollection).doc(token).get();
    if (!doc.exists) return null;
    return { token: doc.id, ...doc.data() } as ChannelInvite;
  }

  async useInvite(token: string, use: InviteUse): Promise<Channel> {
    const inviteRef = this.db.collection(this.invitesCollection).doc(token);
    // Check and count in one transaction, so concurrent joins can't overrun maxUses
    const invite = await this.db.runTransaction(async (tx) => {
      const inviteDoc = await tx.get(inviteRef);
      if (!inviteDoc.exists) throw new Error('Invite not found.');
      const found = { token: inviteDoc.id, ...inviteDoc.data() } as ChannelInvite;
      checkInviteUse(found, use);
      tx.update(inviteRef, { uses: found.uses + 1 });
      return found;
    });
    const channel = await this.getChannel(invite.channelId);
    if (!channel) throw new Error(`Channel "${invite.channelId}" not found.`);
    return channel;
  }

  async getChannelEntries(channelId: string, limit = 50): Promise<JournalEntry[]> {
    // Query both legacy `channel` field and new `#channel` in `to` array
    const channelDest = `#${channelId}`;

    const [byChannel, byTo] = await Promise.all([
      // Legacy channel field — no orderBy to avoid needing a composite index
      this.db
        .collection(this.collection)
        .where('channel', '==', channelId)
        .limit(limit)
        .get(),
      this.db
        .collection(this.collection)
        .where('to', 'array-contains', channelDest)
        .orderBy('timestamp', 'desc')
        .limit(limit)
        .get(),
    ]);

    // Merge and dedup
    const seen = new Set<string>();
    const results: JournalEntry[] = [];
    for (const doc of [...byChannel.docs, ...byTo.docs]) {
      if (!seen.has(doc.id)) {
        seen.add(doc.id);
        results.push({ id: doc.id, ...doc.data() } as JournalEntry);
      }
    }

    return results
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getSparkPairRoom(handleA: string, handleB: string): Promise<string | null> {
    const doc = await this.db
      .collection(this.sparkPairRoomsCollection)
      .doc(getSparkPairKey(handleA, handleB))
      .get();
    if (!doc.exists) return null;
    const data = doc.data() as { roomId?: string } | undefined;
    return data?.roomId || null;
  }

  async setSparkPairRoom(handleA: string, handleB: string, roomId: string): Promise<void> {
    await this.db
      .collection(this.sparkPairRoomsCollection)
      .doc(getSparkPairKey(handleA, handleB))
      .set({
        handles: [handleA.toLowerCase(), handleB.toLowerCase()].sort(),
        roomId,
        updatedAt: Date.now(),
      });
  }

}

/**
 * Staged storage: entries live in memory for 1 hour before publishing to Firestore
 */
export class StagedStorage implements Storage {
  private pending: Map<string, JournalEntry> = new Map();
  private pendingConversations: Map<string, Conversation> = new Map();
  private published: Storage & Record<string, any>;
  private publishDelayMs: number;
  private publishInterval: NodeJS.Timeout | null = null;
  private onStageCallback: ((entry: JournalEntry) => void) | null = null;
  private onPublishCallback: ((entry: JournalEntry) => void) | null = null;

  constructor(publishDelayMs = 60 * 60 * 1000, publishedStorage?: Storage) { // Default 1 hour
    this.published = (publishedStorage || new FirestoreStorage()) as Storage & Record<string, any>;
    this.publishDelayMs = publishDelayMs;
    this.startPublishLoop();
  }

  /**
   * Register callback to be called when an entry enters the staging buffer
   */
  onStage(callback: (entry: JournalEntry) => void) {
    this.onStageCallback = callback;
  }

  /**
   * Register callback to be called when an entry is published
   */
  onPublish(callback: (entry: JournalEntry) => void) {
    this.onPublishCallback = callback;
  }

  private startPublishLoop() {
    // Check every minute for entries ready to publish
    this.publishInterval = setInterval(() => this.publishReadyEntries(), 60 * 1000);
  }

  private async publishReadyEntries() {
    const now = Date.now();

    // Publish ready entries
    for (const [id, entry] of this.pending) {
      if (entry.publishAt && entry.publishAt <= now) {
        // Move to Firestore without staging-only fields
        const { publishAt, moderationHeld, moderationHoldReason, moderationHeldBy, scheduledPublishAt, ...publishedEntry } = entry;
        const saved = await this.published.addEntry(publishedEntry);
        this.pending.delete(id);

        // Call the onPublish callback if registered
        if (this.onPublishCallback) {
          try {
            this.onPublishCallback(saved);
          } catch (err) {
            console.error('[Storage] onPublish callback error:', err);
          }
        }
      }
    }

    // Publish ready conversations
    for (const [id, conversation] of this.pendingConversations) {
      if (conversation.publishAt && conversation.publishAt <= now) {
        // Move to Firestore without publishAt field
        const { publishAt, ...publishedConversation } = conversation;
        await this.published.addConversation(publishedConversation);
        this.pendingConversations.delete(id);
      }
    }
  }

  async addEntry(entry: Omit<JournalEntry, 'id'>, stagingDelayMs?: number): Promise<JournalEntry> {
    const id = generateEntryId();
    const delay = stagingDelayMs ?? this.publishDelayMs;
    const newEntry: JournalEntry = {
      ...entry,
      id,
      publishAt: Date.now() + delay,
    };
    this.pending.set(id, newEntry);

    // Call the onStage callback if registered
    if (this.onStageCallback) {
      try {
        this.onStageCallback(newEntry);
      } catch (err) {
        console.error('[Storage] onStage callback error:', err);
      }
    }

    return newEntry;
  }

  async getEntry(id: string): Promise<JournalEntry | null> {
    // Check pending first, then published
    const pending = this.pending.get(id);
    if (pending) return pending;
    return this.published.getEntry(id);
  }

  async getEntries(limit = 50, offset = 0, cursor?: string): Promise<JournalEntry[]> {
    // Only return published entries for public feed
    return this.published.getEntries(limit, offset, cursor);
  }

  /**
   * Get entries by pseudonym. If includePending is true, includes unpublished entries.
   */
  async getEntriesByPseudonym(pseudonym: string, limit = 50, includePending = false): Promise<JournalEntry[]> {
    const published = await this.published.getEntriesByPseudonym(pseudonym, limit);

    if (!includePending) {
      return published;
    }

    // Include pending entries for this pseudonym
    const pendingEntries: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.pseudonym === pseudonym) {
        pendingEntries.push(entry);
      }
    }

    // Merge and sort by timestamp (newest first)
    return [...pendingEntries, ...published]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get pending entries for a specific pseudonym
   */
  async getPendingEntriesByPseudonym(pseudonym: string): Promise<JournalEntry[]> {
    const entries: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.pseudonym === pseudonym) {
        entries.push(entry);
      }
    }
    return entries.sort((a, b) => b.timestamp - a.timestamp);
  }

  async getEntriesByHandle(handle: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    return this.published.getEntriesByHandle(handle, limit, since);
  }

  async getEntriesSince(since: number, limit = 50): Promise<JournalEntry[]> {
    return this.published.getEntriesSince(since, limit);
  }

  async getEntryCount(): Promise<number> {
    const publishedCount = await this.published.getEntryCount();
    return publishedCount + this.pending.size;
  }

  async deleteEntry(id: string): Promise<void> {
    // Try pending first
    if (this.pending.has(id)) {
      this.pending.delete(id);
      return;
    }
    // Then try published
    await this.published.deleteEntry(id);
  }

  /**
   * Check if an entry is pending (for authorization checks)
   */
  isPending(id: string): boolean {
    return this.pending.has(id);
  }

  /**
   * Publish a pending entry immediately (move from pending to Firestore)
   * Returns the published entry, or null if entry was not found in pending
   */
  async publishEntry(id: string): Promise<JournalEntry | null> {
    const entry = this.pending.get(id);
    if (!entry) return null;

    // Move to Firestore without staging-only fields
    const { publishAt, moderationHeld, moderationHoldReason, moderationHeldBy, scheduledPublishAt, ...publishedEntry } = entry;
    const saved = await this.published.addEntry(publishedEntry);
    this.pending.delete(id);

    // Call the onPublish callback if registered
    if (this.onPublishCallback) {
      try {
        this.onPublishCallback(saved);
      } catch (err) {
        console.error('[Storage] onPublish callback error:', err);
      }
    }

    return saved;
  }

  async searchEntries(query: string, limit = 50, since?: number): Promise<JournalEntry[]> {
    // Search only published entries (pending entries are private)
    return this.published.searchEntries(query, limit, since);
  }

  /**
   * Stop the publish loop (for cleanup)
   */
  stop() {
    if (this.publishInterval) {
      clearInterval(this.publishInterval);
      this.publishInterval = null;
    }
  }

  /**
   * Get all pending entries (for moderation review)
   */
  getAllPendingEntries(): JournalEntry[] {
    return Array.from(this.pending.values())
      .sort((a, b) => (a.publishAt ?? 0) - (b.publishAt ?? 0));
  }

  /**
   * Update when a pending entry publishes.
   * Used by content moderation to hold (push publishAt to ~forever) or release entries.
   */
  updateEntryPublishAt(id: string, newPublishAt: number): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.publishAt = newPublishAt;
    return true;
  }

  /**
   * Mark a pending entry as held by moderation. `heldBy` is 'automated' for
   * automated review, otherwise the moderator's handle. The original publish time
   * is kept so a release can't publish the entry before the author's window ends.
   */
  holdEntry(id: string, reason: string, holdUntil: number, heldBy?: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.scheduledPublishAt ??= entry.publishAt;
    entry.publishAt = holdUntil;
    entry.moderationHeld = true;
    entry.moderationHoldReason = reason;
    entry.moderationHeldBy = heldBy;
    return true;
  }

  /**
   * Lift a moderation hold. The entry goes back to its original schedule: it
   * publishes then, or at the next publish tick if that time has passed.
   * Returns the new publish time, or null if the entry isn't pending or its
   * original schedule is unknown (held before scheduledPublishAt was recorded;
   * staging delays vary per user, so it can't be safely guessed).
   */
  releaseHold(id: string): number | null {
    const entry = this.pending.get(id);
    if (!entry || entry.scheduledPublishAt === undefined) return null;
    entry.publishAt = Math.max(entry.scheduledPublishAt, Date.now());
    delete entry.moderationHeld;
    delete entry.moderationHoldReason;
    delete entry.moderationHeldBy;
    delete entry.scheduledPublishAt;
    return entry.publishAt;
  }

  /**
   * Get all pending state for recovery (entries and conversations)
   */
  getPendingState(): { entries: JournalEntry[]; conversations: Conversation[] } {
    return {
      entries: Array.from(this.pending.values()),
      conversations: Array.from(this.pendingConversations.values()),
    };
  }

  /**
   * Restore pending state from recovery (entries and conversations)
   */
  restorePendingState(state: { entries: JournalEntry[]; conversations: Conversation[] }): void {
    for (const entry of state.entries) {
      this.pending.set(entry.id, entry);
    }
    for (const conversation of state.conversations) {
      this.pendingConversations.set(conversation.id, conversation);
    }
    console.log(`[Storage] Restored ${state.entries.length} pending entries, ${state.conversations.length} pending conversations`);
  }

  // ─────────────────────────────────────────────────────────────
  // User methods (delegated to FirestoreStorage)
  // ─────────────────────────────────────────────────────────────

  async createUser(user: Omit<User, 'createdAt'>): Promise<User> {
    return this.published.createUser(user);
  }

  async getUser(handle: string): Promise<User | null> {
    return this.published.getUser(handle);
  }

  async getUserByKeyHash(keyHash: string): Promise<User | null> {
    return this.published.getUserByKeyHash(keyHash);
  }

  async updateUser(handle: string, updates: Partial<Omit<User, 'handle' | 'secretKeyHash' | 'createdAt'>>): Promise<User | null> {
    return this.published.updateUser(handle, updates);
  }

  async isHandleAvailable(handle: string): Promise<boolean> {
    return this.published.isHandleAvailable(handle);
  }

  async migrateEntriesToHandle(pseudonym: string, handle: string): Promise<number> {
    return this.published.migrateEntriesToHandle(pseudonym, handle);
  }

  async getUsersWithLegacyPseudonym(): Promise<User[]> {
    return this.published.getUsersWithLegacyPseudonym();
  }

  async countUnmigratedEntries(pseudonym: string, handle: string): Promise<number> {
    return this.published.countUnmigratedEntries(pseudonym, handle);
  }

  async getUsersWithEmail(): Promise<User[]> {
    return this.published.getUsersWithEmail();
  }

  async searchUsers(prefix: string, limit = 10): Promise<User[]> {
    return this.published.searchUsers(prefix, limit);
  }

  async getUserByEmail(email: string): Promise<User | null> {
    return this.published.getUserByEmail(email);
  }

  async getUserCount(): Promise<number> {
    return this.published.getUserCount();
  }

  async getAllUsers(): Promise<User[]> {
    return this.published.getAllUsers();
  }

  async getEntriesAddressedTo(handle: string, email?: string, limit = 50): Promise<JournalEntry[]> {
    // Published entries only. A waiting entry is private to its author until it
    // publishes, which is also when recipients are notified.
    return this.published.getEntriesAddressedTo(handle, email, limit);
  }

  async getRepliesTo(entryId: string, limit = 50): Promise<JournalEntry[]> {
    // Get from published storage
    const published = await this.published.getRepliesTo(entryId, limit);

    // Also include pending replies
    const pendingReplies: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.inReplyTo === entryId) {
        pendingReplies.push(entry);
      }
    }

    // Merge and sort (oldest first for replies)
    return [...pendingReplies, ...published]
      .sort((a, b) => a.timestamp - b.timestamp)
      .slice(0, limit);
  }

  // ─────────────────────────────────────────────────────────────
  // Summary methods (delegated to FirestoreStorage)
  // ─────────────────────────────────────────────────────────────

  async addSummary(summary: Omit<Summary, 'id'>): Promise<Summary> {
    return this.published.addSummary(summary);
  }

  async getSummaries(limit = 50): Promise<Summary[]> {
    return this.published.getSummaries(limit);
  }

  async getLastSummaryForPseudonym(pseudonym: string): Promise<Summary | null> {
    return this.published.getLastSummaryForPseudonym(pseudonym);
  }

  async getEntriesInRange(pseudonym: string, startTime: number, endTime: number): Promise<JournalEntry[]> {
    return this.published.getEntriesInRange(pseudonym, startTime, endTime);
  }

  async deleteSummary(id: string): Promise<void> {
    return this.published.deleteSummary(id);
  }

  // Daily summary methods
  async addDailySummary(summary: Omit<DailySummary, 'id'>): Promise<DailySummary> {
    return this.published.addDailySummary(summary);
  }

  async getDailySummaries(limit = 30): Promise<DailySummary[]> {
    return this.published.getDailySummaries(limit);
  }

  async getDailySummary(date: string): Promise<DailySummary | null> {
    return this.published.getDailySummary(date);
  }

  async deleteDailySummary(date: string): Promise<void> {
    return this.published.deleteDailySummary(date);
  }

  async getEntriesForDate(date: string): Promise<JournalEntry[]> {
    return this.published.getEntriesForDate(date);
  }

  // ─────────────────────────────────────────────────────────────
  // Conversation methods (with staging support)
  // ─────────────────────────────────────────────────────────────

  async addConversation(conversation: Omit<Conversation, 'id'>): Promise<Conversation> {
    // Conversations publish immediately (user intentionally imported them)
    return this.published.addConversation(conversation);
  }

  async getConversation(id: string): Promise<Conversation | null> {
    // Check pending first, then published
    const pending = this.pendingConversations.get(id);
    if (pending) return pending;
    return this.published.getConversation(id);
  }

  async getConversations(limit = 50, offset = 0, cursor?: string): Promise<Conversation[]> {
    // Only return published conversations for public feed
    return this.published.getConversations(limit, offset, cursor);
  }

  /**
   * Get conversations by pseudonym. If includePending is true, includes unpublished conversations.
   */
  async getConversationsByPseudonym(pseudonym: string, limit = 50, includePending = false): Promise<Conversation[]> {
    const published = await this.published.getConversationsByPseudonym(pseudonym, limit);

    if (!includePending) {
      return published;
    }

    // Include pending conversations for this pseudonym
    const pendingConversations: Conversation[] = [];
    for (const conversation of this.pendingConversations.values()) {
      if (conversation.pseudonym === pseudonym) {
        pendingConversations.push(conversation);
      }
    }

    // Merge and sort by timestamp (newest first)
    return [...pendingConversations, ...published]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Get pending conversations for a specific pseudonym
   */
  async getPendingConversationsByPseudonym(pseudonym: string): Promise<Conversation[]> {
    const conversations: Conversation[] = [];
    for (const conversation of this.pendingConversations.values()) {
      if (conversation.pseudonym === pseudonym) {
        conversations.push(conversation);
      }
    }
    return conversations.sort((a, b) => b.timestamp - a.timestamp);
  }

  async searchConversations(query: string, limit = 50, since?: number): Promise<Conversation[]> {
    // Search only published conversations (pending are private)
    return this.published.searchConversations(query, limit, since);
  }

  async deleteConversation(id: string): Promise<void> {
    // Try pending first
    if (this.pendingConversations.has(id)) {
      this.pendingConversations.delete(id);
      return;
    }
    // Then try published
    await this.published.deleteConversation(id);
  }

  /**
   * Check if a conversation is pending (for authorization checks)
   */
  isConversationPending(id: string): boolean {
    return this.pendingConversations.has(id);
  }

  // ─────────────────────────────────────────────────────────────
  // Channel methods (delegated to FirestoreStorage)
  // ─────────────────────────────────────────────────────────────

  async createChannel(channel: Channel): Promise<Channel> {
    return this.published.createChannel(channel);
  }

  async getChannel(id: string): Promise<Channel | null> {
    return this.published.getChannel(id);
  }

  async updateChannel(id: string, updates: Partial<Omit<Channel, 'id' | 'createdBy' | 'createdAt'>>): Promise<Channel | null> {
    return this.published.updateChannel(id, updates);
  }

  async deleteChannel(id: string): Promise<void> {
    return this.published.deleteChannel(id);
  }

  async listChannels(opts?: { handle?: string; visibility?: string; joinRule?: string }): Promise<Channel[]> {
    return this.published.listChannels(opts);
  }

  async addSubscriber(channelId: string, handle: string, role: 'admin' | 'member'): Promise<void> {
    return this.published.addSubscriber(channelId, handle, role);
  }

  async removeSubscriber(channelId: string, handle: string): Promise<void> {
    return this.published.removeSubscriber(channelId, handle);
  }

  async getSubscribedChannels(handle: string): Promise<Channel[]> {
    return this.published.getSubscribedChannels(handle);
  }

  async createInvite(invite: ChannelInvite): Promise<ChannelInvite> {
    return this.published.createInvite(invite);
  }

  async getInvite(token: string): Promise<ChannelInvite | null> {
    return this.published.getInvite(token);
  }

  async useInvite(token: string, use: InviteUse): Promise<Channel> {
    return this.published.useInvite(token, use);
  }

  async getChannelEntries(channelId: string, limit = 50): Promise<JournalEntry[]> {
    // Include pending channel entries (match both legacy channel field and #channel in to)
    const published = await this.published.getChannelEntries(channelId, limit);
    const channelDest = `#${channelId}`;
    const pendingEntries: JournalEntry[] = [];
    for (const entry of this.pending.values()) {
      if (entry.channel === channelId || (entry.to && entry.to.includes(channelDest))) {
        pendingEntries.push(entry);
      }
    }
    return [...pendingEntries, ...published]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  async getSparkPairRoom(handleA: string, handleB: string): Promise<string | null> {
    return this.published.getSparkPairRoom(handleA, handleB);
  }

  async setSparkPairRoom(handleA: string, handleB: string, roomId: string): Promise<void> {
    return this.published.setSparkPairRoom(handleA, handleB, roomId);
  }

}
