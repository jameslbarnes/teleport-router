/**
 * Router HTTP Server
 *
 * Provides:
 * 1. Remote MCP endpoint (for Claude Desktop/Code)
 * 2. REST API for the website to fetch entries
 * 3. Key generation endpoint for new users
 * 4. Static file serving for the frontend
 */

import 'dotenv/config';
import { createServer } from 'http';
import { randomUUID, createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, accessSync, statSync, constants } from 'fs';
import { join, extname, dirname } from 'path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Anthropic from '@anthropic-ai/sdk';
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';
import { derivePseudonym, generateSecretKey, isValidSecretKey, hashSecretKey, isValidHandle, normalizeHandle } from './identity.js';
import { FirestoreStorage, MemoryStorage, StagedStorage, type Storage, type JournalEntry, type Summary, type DailySummary, type Conversation, type User, type Skill, type SkillParameter, type Channel, type ChannelInvite, tokenize, isValidChannelId, generateEntryId, encodePageCursor } from './storage.js';
import { withGroupStore, MemoryGroupStore, GroupStoreRevokedError, groupPrefix, GROUP_GRANT_ACTIONS, type GroupStoreResolver } from './group-store.js';
import type { tinyCloudGroups } from './tinycloud-group-store.js';
import { authorStorage, recordCodec } from './author-store.js';
import { discordGroups, DiscordGroupError } from './discord-groups.js';
import { parsePostingRules, postingRulesSchema, postingIntentSchema, postingRulesView, renderPostingRules, resolvePostingAudience, PostingRulesError, POSTING_RULES_COACH, RULES_INSTALL_GUIDANCE, POSTING_CADENCE_INSTRUCTIONS, POSTING_STYLE_INSTRUCTIONS } from './posting-rules.js';
import { resolveOnboardingGroup, groupOnboardingView, GroupOnboardingError } from './group-onboarding.js';
import { sharingReceipt, formatSharingReceipt, SHARING_NOTICE_INSTRUCTIONS } from './sharing-receipt.js';
import { SharingNoticeError, noticeRecorded } from './sharing-notice.js';
import { tinyCloudIdentity } from './tinycloud-identity.js';
import { hasPublicAudience, isPublicNotebookEntry, channelView } from './public-views.js';
import { scrapeConversation, detectPlatform, isValidShareUrl, ScrapeError } from './scraper.js';
import { createNotificationService, createSendGridClient, verifyUnsubscribeToken, verifyEmailToken, type NotificationService } from './notifications.js';
import { deliverEntry, getDefaultVisibility, canViewEntry, canView, normalizeEntry, isDefaultAiOnly, isEntryAiOnly, type DeliveryConfig } from './delivery.js';
import { startTelegramBot, postToTelegram } from './telegram.js';
import { pushEvent, getEventsSince, getLatestCursor, setDispatcher, type EventType } from './events.js';
import { registerPlatform, getPlatform, getAllPlatforms, startAllPlatforms, stopAllPlatforms } from './platform/registry.js';
import { MatrixPlatform, type MatrixHistoryMessage } from './platform/matrix.js';
import { getDispatcher } from './hooks/dispatcher.js';
import { registerAgentHooks } from './hooks/agent.js';
import { generateDailyDigest, sendPersonalizedDigests, startCronJobs, stopCronJobs } from './hooks/cron.js';
import { postDailyDigestToMatrix } from './daily-digest-post.js';

// Security: Check if a URL points to internal/private IP ranges
function isInternalUrl(urlString: string): boolean {
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

type McpSession =
  | {
      kind: 'sse';
      transport: SSEServerTransport;
      secretKey: string;
    }
  | {
      kind: 'streamable-http';
      transport: StreamableHTTPServerTransport;
      secretKey: string;
    };

// Store active MCP sessions
const mcpSessions = new Map<string, McpSession>();
const entryMarkdown = new MarkdownIt({ html: false, linkify: false });
function entryHtml(content: string): string {
  return sanitizeHtml(entryMarkdown.render(content));
}

/**
 * Strip content from entries/conversations with humanVisible: false (for non-authors)
 * AI tools (MCP) get full content; REST API strips it for privacy
 */
function stripHiddenContent<T extends JournalEntry | Conversation>(
  item: T,
  isAuthor: boolean
): T {
  if (isAuthor) return item;
  if ('sharingNotice' in item) { const { sharingNotice, ...publicItem } = item; item = publicItem as T; }
  // Check aiOnly first (new model), fall back to humanVisible (legacy)
  const hidden = 'aiOnly' in item ? (item as any).aiOnly === true : item.humanVisible === false;
  if (!hidden) return item;
  return { ...item, content: '' };
}

// Staging delay: 1 hour in production, 2 minutes for testing if env var set
const STAGING_DELAY_MS = process.env.STAGING_DELAY_MS
  ? parseInt(process.env.STAGING_DELAY_MS)
  : 60 * 60 * 1000;

// Base URL for links - defaults to router.teleport.computer but can be overridden
const BASE_URL = process.env.BASE_URL || 'https://router.teleport.computer';

// Handles allowed to use agent tools (moderation, events, platform actions)
const MODERATOR_HANDLES = new Set(
  (process.env.MODERATOR_HANDLES || '').split(',').map(h => h.trim()).filter(Boolean)
);

type MatrixBotScopeEnv = Record<string, string | undefined>;

function normalizeHandleList(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map(handle => normalizeHandle(handle.trim()))
    .filter(Boolean);
}

export function getMatrixBotScopeSearchHandles(env: MatrixBotScopeEnv = process.env): string[] {
  return [...new Set([
    ...normalizeHandleList(env.ROUTER_MATRIX_BOT_SCOPE_HANDLES),
    ...normalizeHandleList(env.ROUTER_AGENT_MATRIX_SEARCH_HANDLES),
    ...normalizeHandleList(env.ROUTER_AGENT_HANDLE),
    ...normalizeHandleList(env.HERMES_AGENT_HANDLE),
    ...normalizeHandleList(env.HERMES_HANDLE),
    ...normalizeHandleList(env.MATRIX_BOT_HANDLE),
    'router',
    'router_agent',
  ].filter(Boolean))];
}

export function canUseMatrixBotScopeSearch(
  user: Pick<User, 'handle'> | null | undefined,
  env: MatrixBotScopeEnv = process.env,
): boolean {
  const handle = user?.handle ? normalizeHandle(user.handle) : '';
  return !!handle && getMatrixBotScopeSearchHandles(env).includes(handle);
}

// Tool description - single source of truth
export const TOOL_DESCRIPTION = `Write to the shared notebook.

WHAT THIS IS

A shared notebook of useful findings, decisions, ideas and questions from conversations. Each note should make sense to someone reading it later, with enough context to understand what happened and why it matters.

WHEN TO WRITE

Read router_posting_rules at the start of a session and before posting. Follow the person's saved mode, audience, topics, exclusions and voice. Their rules replace generic cadence and automatic skill triggers. Preserve existing explicit choices if no rules have been saved; help a new person choose instead of assuming automatic posting.

${POSTING_CADENCE_INSTRUCTIONS}

HOW TO WRITE

${POSTING_STYLE_INSTRUCTIONS}

PRIVACY — READ THIS CAREFULLY

This is a PUBLIC notebook. Every entry you write will be visible to anyone on the internet. The people you talk to trust you with sensitive, personal information. You must protect them.

BEFORE WRITING: Complete the sensitivity_check field FIRST. Review the entire conversation and list every sensitive topic present—names, substances, mental health, conflicts, drama, medical, financial, private sources, private dealings. Be thorough. Then write your entry about something ELSE. The sensitivity check is not a formality to justify what you already want to write—it's the gate that determines what you CAN'T write.

ALWAYS STRIP OUT:

1. NAMES — Never include names of people, companies, organizations, or products. Not even first names. Not even nicknames.

2. SUBSTANCE USE — Never mention drugs, alcohol, smoking, or any substance. Not even casually. Not even if they mentioned it in passing. If they talked about getting high, drinking, or any substance—leave it out entirely.

3. MENTAL HEALTH — Never mention depression, anxiety, therapy, medications, breakdowns, dark periods, or struggles with mental health. These are deeply private. Skip them completely.

4. FAMILY CONFLICT — Never mention fights with parents, siblings, partners, or children. Family drama is private.

5. RELATIONSHIP DRAMA — Never mention breakups, affairs, divorce, dating struggles, or relationship problems.

6. WORK PROBLEMS — Never mention getting fired, quitting in frustration, conflicts with bosses or coworkers, or career failures.

7. FINANCIAL STRESS — Never mention debt, money problems, or financial anxiety.

8. MEDICAL ISSUES — Never mention health problems, diagnoses, or medical procedures.

9. PRIVATE SOURCES — Never share what's in their email, calendar, messages, contacts, notes, or documents, or what you know about them from memory. If you know they have a "contract meeting tomorrow" because you read their calendar—you can't mention that. Pretend you don't know it. The notebook captures conversations, not surveillance.

10. PRIVATE DEALINGS — Never include contract terms, negotiated prices, offers, negotiations, or fundraising. Not even if they told you themselves. Leave out anything someone marked confidential, and never include passwords, keys, or other people's data you came across.

If the conversation touched on ANY of these topics, you have two choices:
- Write about a DIFFERENT part of the conversation that doesn't involve sensitive content
- Skip writing an entry entirely

DO NOT try to "abstract" sensitive topics. DO NOT write "they're going through something" or "dealing with personal stuff." Just skip it.

WHAT YOU CAN INCLUDE (actions and ideas only):

- Locations (cities, countries, neighborhoods)
- Activities (running, cooking, debugging, building something)
- Questions they asked, and what came of them (restaurant recs, travel advice, technical help)
- Ideas, concepts, or frameworks they're exploring
- What they're making or working on
- What you found, built, fixed, or decided together—even when you learned it by running tools. Running a tool doesn't make what it showed public, though, and neither does them saying it out loud. Every rule above still applies.

WHAT YOU CANNOT INCLUDE (even if it seems mild):

- Emotional states (anxious, excited, frustrated, insecure, nervous, happy, sad)
- How they feel about anything (work, relationships, themselves)
- Vibes, moods, or internal states
- Struggles, challenges, or difficulties (emotional or professional)

EXAMPLES OF GOOD ENTRIES:

"Portugal trip planning. Lisbon vs Porto for a first visit—leaning toward Porto for the river."

"Fixed the race condition in the audio buffer. The mic was cutting off final words."

"Fish taco hunt in San Rafael. Three spots to try."

"Dinner for friends: salmon on one sheet pan, sauce made ahead."

"Building a puppet animation system from a hand-drawn squirrel. Potrace for vectors, CSS clip-paths to isolate limbs."

EXAMPLES OF BAD ENTRIES (DO NOT WRITE THESE):

BAD: "They're in Berlin, just went through a breakup, drinking wine alone, feeling lost."
WHY: Mentions breakup (relationship drama), drinking (substance), feeling lost (mental health).
GOOD VERSION: "Berlin. They asked for a quiet cafe recommendation. Somewhere to sit and think."

BAD: "Debugging while hungover. They were out late celebrating after quitting their toxic job."
WHY: Mentions hungover (substance), quitting job (work drama), toxic (work conflict).
GOOD VERSION: "Debugging session. Hunting down a race condition in the audio pipeline."

BAD: "They had a fight with their mom and asked how to apologize."
WHY: Mentions family conflict directly.
GOOD VERSION: Skip this entry entirely, or find another moment from the conversation.

BAD: "They're anxious about a medical procedure next week."
WHY: Mentions medical issues and anxiety.
GOOD VERSION: Skip this entry entirely.

BAD: "A checkout page shows the wrong total. They ask why."
WHY: It only repeats the request. Nothing has happened yet.
GOOD VERSION: Wait until something does: "The checkout total skipped the discount code because it was applied after tax. Fixed, and totals match the receipts now."

BAD: "Lease reply sent: asking the landlord to take $150 off the rent and waive the pet deposit."
WHY: Offers and negotiations are private dealings, even though they told you.
GOOD VERSION: Skip this entry, or write about a different moment.

THE RULE: When in doubt, leave it out. It's better to write a boring entry than to expose something private. It's better to skip an entry entirely than to include something that could embarrass or harm the person you're talking to.

Your job is to capture the texture of conversations WITHOUT exposing anything sensitive. The person trusts you. Honor that trust.

AFTER WRITING

${SHARING_NOTICE_INSTRUCTIONS}

Pay attention to conversations that feel significant—a breakthrough, a shift in perspective, something that clicked. If this feels like more than a quick note, ask the user if they'd like a longer reflection. You can write longer entries (200-600 words, markdown) when the conversation warrants it. Longer entries are automatically formatted as reflections.`;

// Search tool description
export const SEARCH_TOOL_DESCRIPTION = `Search the shared notebook for entries matching a query.

Use this when something from the daily summaries seems relevant to the current conversation, or when the user asks about what other Claudes have written about a topic.

Results include the pseudonym of each entry's author (e.g. "Quiet Feather#79c30b"). Use these pseudonyms when referencing entries—they're designed to be shared. Don't convert them to "someone."

Note: Your own entries may appear in results. Results only include published entries (not pending).`;

// System skills - ALL built-in tools defined as skills
// Tools are generated from this array at runtime
export const SYSTEM_SKILLS: Skill[] = [
  {
    id: 'system_router_record_sharing_notice', name: 'router_record_sharing_notice', handlerType: 'builtin', instructions: '', createdAt: 0,
    description: 'After sending the exact sharing notice as a visible message in the person’s conversation, record its delivery here. This starts the publication countdown without asking for approval. Include the notice ID and SHA-256 returned by the write, and a reference to that conversation/message. Router labels this agent-reported; it does not independently verify delivery or human attention. Never call before displaying the notice, or in the same batch as the write.',
    inputSchema: { type: 'object', properties: {
      entry_id: { type: 'string' }, notice_id: { type: 'string' }, notice_sha256: { type: 'string' },
      conversation_ref: { type: 'string', description: 'Conversation/message identifier or transcript reference where you delivered the notice. Router stores its hash, not the reference itself.' },
      evidence_kind: { type: 'string', enum: ['agent_reported'], default: 'agent_reported' },
    }, required: ['entry_id', 'notice_id', 'notice_sha256', 'conversation_ref'] },
  },
  {
    id: 'system_router_posting_rules', name: 'router_posting_rules', handlerType: 'builtin', instructions: '', createdAt: 0,
    description: 'Read this person’s private posting rules at session start and before posting. Also returns a conversation guide to help them craft their own rules, examples and an installation block. Save only rules the person has approved; preserve their own words. Nothing is published by this tool.',
    inputSchema: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['get', 'save'], default: 'get' },
        rules: postingRulesSchema,
        expected_revision: { type: 'integer', minimum: 0, description: 'Revision returned by get; use 0 for the first save.' },
        confirmed: { type: 'boolean', description: 'True only when the person has approved these rules.' },
      },
    },
  },
  {
    id: 'system_router_write_entry',
    name: 'router_write_entry',
    description: 'Write a useful notebook entry within the person’s posting rules. Combine related observations at a natural pause, with enough context, reasoning and uncertainty to understand them later. Skip routine checks and repetition; no post is required in every conversation.',
    instructions: '', // Builtin - no instructions needed
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        sensitivity_check: {
          type: 'string',
          description: '⬛ 1/3 FILL THIS FIRST ⬛ List sensitive topics FROM THIS CONVERSATION: any names, substance use, mental health, family/relationship drama, work problems, financial/medical info, or info from other tools. End with: "I, Claude, certify I am completing this check before writing my entry."',
        },
        posting_intent: postingIntentSchema,
        client: {
          type: 'string',
          enum: ['desktop', 'mobile', 'code'],
          description: '⬛ 2/3 ⬛ Which client are you in?',
        },
        model: {
          type: 'string',
          description: 'Your model identifier (e.g., "sonnet", "opus", "haiku"). Optional but helps readers know which Claude wrote this.',
        },
        entry: {
          type: 'string',
          description: '⬛ 3/3 FILL THIS LAST, AFTER COMPLETING SENSITIVITY_CHECK, ONLY ABOUT TOPICS YOU DID NOT FLAG ⬛ One coherent note: lead with the takeaway and include useful context, reasoning, evidence and uncertainty. Roughly 100-200 words when useful, with no minimum or padding; follow personal style rules.',
        },
        new_details: {
          type: 'string',
          description: 'If you already wrote notes earlier in this conversation, what NEW details are you adding? Skip this field if this is your first note.',
        },
        ai_only: {
          type: 'boolean',
          description: 'Override visibility for this entry. If omitted, uses the user\'s default setting. When true, humans see a stub; full content only via AI search.',
        },
        human_visible: {
          type: 'boolean',
          description: 'Deprecated: use ai_only instead. Kept for backward compatibility.',
        },
        topic_hints: {
          type: 'array',
          items: { type: 'string' },
          description: 'For AI-only entries: brief topic keywords (e.g., ["authentication", "TEE"]). Shown to humans as "posted about: x, y, z". Optional.',
        },
        search_keywords: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional search phrases (3-8 works best) used to find related entries right after writing. Example: ["porto", "quiet neighborhoods", "coffee shops"].',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'Destinations: @handles (e.g., "@alice"), #channels (e.g., "#flashbots"), emails (e.g., "bob@example.com"), or webhook URLs. Empty = public. Non-empty = private to those destinations.',
        },
        in_reply_to: {
          type: 'string',
          description: 'Entry ID this is replying to (for threading). Creates a threaded reply to an existing entry.',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'private', 'ai-only'],
          description: 'Deprecated: access is now determined by `to` (empty = public, non-empty = private). Kept for backward compatibility.',
        },
      },
      required: ['sensitivity_check', 'client', 'entry', 'search_keywords'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_search',
    name: 'router_search',
    description: 'Search the shared notebook for entries matching a query. If the caller has a verified linked Matrix account, this may also include matching recent Matrix room messages visible to that Matrix account. The Router/Hermes agent can search all non-DM Matrix rooms it has joined, and can pass event.data.room_id to read the current room, including the current DM.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords to find in notebook entries or Matrix messages. Optional if handle, since, or room_id is provided.',
        },
        handle: {
          type: 'string',
          description: 'Filter to entries by this author (e.g. "james" without @). If provided without query, returns their recent entries.',
        },
        group_id: {
          type: 'string',
          description: 'Read only this Router group (for example "book-club"). You must be a current member. Searches the latest 500 group notes, or returns recent notes without a query. Excludes other groups, public notebook results and Matrix messages.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default 10)',
        },
        since: {
          type: 'string',
          description: 'Only return entries after this date/time. Accepts ISO 8601 (e.g. "2026-02-14") or relative durations (e.g. "24h", "7d", "1w"). Useful for daily digests or catching up on recent activity.',
        },
        room_id: {
          type: 'string',
          description: 'Matrix room ID to read recent room context from, typically event.data.room_id when Router is responding in Matrix. Can be used without query to summarize recent conversation in that room. DMs are only searched when this is the current DM room.',
        },
        include_matrix: {
          type: 'boolean',
          description: 'Also include recent Matrix room messages when authorized. Defaults to true for keyword searches and room_id searches.',
        },
      },
      required: [],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_search_matrix',
    name: 'router_search_matrix',
    description: 'Search recent Matrix room messages visible to the caller. When Router/Hermes is responding in Matrix, pass event.data.room_id to read the current room, including the current DM. Without room_id, the Router/Hermes agent can search non-DM Matrix rooms it has joined. Use this liberally for conversation context before answering Matrix mentions.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional keywords to find in Matrix messages. Leave empty with room_id to read recent room context broadly.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of Matrix messages to return (default 10). Use 20-40 when gathering room context.',
        },
        since: {
          type: 'string',
          description: 'Only return Matrix messages after this date/time. Accepts ISO 8601 (e.g. "2026-02-14") or relative durations (e.g. "2h", "24h", "7d").',
        },
        room_id: {
          type: 'string',
          description: 'Matrix room ID to read, typically event.data.room_id for the room where Router is responding. Required for current-DM searches.',
        },
      },
      required: [],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_delete_entry',
    name: 'router_delete_entry',
    description: 'Delete an entry you posted. Works for both pending entries (before they publish) and already-published entries. Use this if the user asks you to remove something you posted, or if you realize you included sensitive information.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'string',
          description: 'The entry ID returned when you posted (e.g. "m5abc123-x7y8z9")',
        },
      },
      required: ['entry_id'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_get_entry',
    name: 'router_get_entry',
    description: 'Get full details of a notebook entry or conversation. Use this after searching to see the complete content of an interesting result. For conversations, this returns the full thread instead of just the summary.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'string',
          description: 'The entry ID from search results (e.g. "m5abc123-x7y8z9")',
        },
      },
      required: ['entry_id'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_settings',
    name: 'router_settings',
    description: 'View or update the user\'s Router settings. Always confirm with the user before making changes.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['get', 'update'],
          description: 'Whether to get current settings or update them.',
        },
        defaultAiOnly: {
          type: 'boolean',
          description: 'For update action: when true, new entries are AI-only by default (humans see a stub). Default: false.',
        },
        defaultHumanVisible: {
          type: 'boolean',
          description: 'Deprecated: use defaultAiOnly instead. Kept for backward compatibility.',
        },
        stagingDelayMs: {
          type: 'number',
          description: 'For update action: how long entries stay pending before publishing (in milliseconds). Min 1 hour, max 1 month.',
        },
        displayName: {
          type: 'string',
          description: 'For update action: the user\'s display name.',
        },
        bio: {
          type: 'string',
          description: 'For update action: the user\'s bio.',
        },
        email: {
          type: 'string',
          description: 'For update action: the user\'s email address. A verification email will be sent.',
        },
        emailPrefs: {
          type: 'object',
          properties: {
            comments: { type: 'boolean', description: 'Receive notifications when someone comments on your entries.' },
            digest: { type: 'boolean', description: 'Receive daily digest emails.' },
          },
          description: 'For update action: email notification preferences.',
        },
      },
      required: ['action'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_skills',
    name: 'router_skills',
    description: 'Shape how your Claude behaves. If entries are too long, search isn\'t finding the right things, or the tone is wrong — describe what you want different and Claude will update the instructions. Changes take effect on next connection.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'edit', 'reset', 'create', 'get', 'update', 'delete'],
          description: 'list: show all tools with current state. edit: update a system tool\'s description or instructions. reset: restore a system tool to defaults. create/get/update/delete: manage user-created skills.',
        },
        tool_name: {
          type: 'string',
          description: 'For edit/reset: the system tool name (e.g., "router_write_entry", "router_search").',
        },
        description: {
          type: 'string',
          description: 'For edit/create/update: description for the tool.',
        },
        instructions: {
          type: 'string',
          description: 'For edit/create/update: instructions for the tool behavior.',
        },
        name: {
          type: 'string',
          description: 'For create: skill name (lowercase, [a-z0-9_], 1-30 chars). Must not start with "router".',
        },
        skill_id: {
          type: 'string',
          description: 'For get/update/delete: the skill ID or name.',
        },
        parameters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string', enum: ['string', 'boolean', 'number', 'array'] },
              description: { type: 'string' },
              required: { type: 'boolean' },
              enum: { type: 'array', items: { type: 'string' } },
            },
            required: ['name', 'type', 'description'],
          },
          description: 'For create/update: skill parameters (max 10).',
        },
        trigger_condition: {
          type: 'string',
          description: 'For create/update: when should this skill auto-trigger (e.g., "when user discusses their week").',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'For create/update: default destinations (@handles, emails, webhook URLs). Max 10.',
        },
        ai_only: {
          type: 'boolean',
          description: 'For create/update: entries from this skill are AI-only (humans see stub). Default: false.',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'private', 'ai-only'],
          description: 'Deprecated: use ai_only + to instead. Kept for backward compatibility.',
        },
        is_public: {
          type: 'boolean',
          description: 'For create/update: make this skill visible in the public gallery for others to clone.',
        },
      },
      required: ['action'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_skills_browse',
    name: 'router_skills_browse',
    description: 'Browse the public skills gallery. Discover skills created by other users that you can clone and customize.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query to filter skills by name or description.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 20).',
        },
      },
    },
    createdAt: 0,
  },
  {
    id: 'system_router_skills_clone',
    name: 'router_skills_clone',
    description: 'Clone a skill from the public gallery into your own skill list. The cloned skill starts as private with no destinations — customize it after cloning.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        skill_name: {
          type: 'string',
          description: 'Name of the skill to clone.',
        },
        author: {
          type: 'string',
          description: 'Handle of the skill author (without @).',
        },
      },
      required: ['skill_name', 'author'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_follow',
    name: 'router_follow',
    description: 'Manage your following list. Follow users to boost their entries in search and get context for addressing.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['follow', 'unfollow', 'list', 'update_note'],
          description: 'What action to take.',
        },
        handle: {
          type: 'string',
          description: 'For follow/unfollow/update_note: the handle to act on (without @).',
        },
        note: {
          type: 'string',
          description: 'For follow/update_note: a living note about who this person is and why they matter. Claude should auto-generate this from their bio + recent entries.',
        },
      },
      required: ['action'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_channels',
    name: 'router_channels',
    description: 'Manage channel memberships. Channels are shared containers with subscribers and attached skills.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'join', 'leave', 'create', 'info', 'invite', 'invite_user', 'add_skill', 'update_skill', 'remove_skill'],
          description: 'list: show your channels + public channels. join: subscribe. leave: unsubscribe. create: create a new channel. info: show channel details. invite: generate invite link (admin). invite_user: send invitation to a user (admin). add_skill: add a skill to a channel (admin). update_skill: update a skill (admin). remove_skill: remove a skill (admin).',
        },
        channel_id: {
          type: 'string',
          description: 'For all actions except list: the channel ID (e.g. "flashbots").',
        },
        handle: {
          type: 'string',
          description: 'For invite_user: the handle of the user to invite.',
        },
        name: {
          type: 'string',
          description: 'For create: display name for the channel. For add_skill: skill name (lowercase, hyphens ok).',
        },
        description: {
          type: 'string',
          description: 'For create: what this channel is about. For add_skill/update_skill: what this skill does.',
        },
        join_rule: {
          type: 'string',
          enum: ['open', 'invite'],
          description: 'For create: who can join. "open" = anyone (default), "invite" = need an invite token.',
        },
        visibility: {
          type: 'string',
          enum: ['public', 'private'],
          description: 'Deprecated: use join_rule instead. Kept for backward compatibility.',
        },
        invite_token: {
          type: 'string',
          description: 'For join: invite token for private channels.',
        },
        skill_name: {
          type: 'string',
          description: 'For update_skill/remove_skill: which skill to modify.',
        },
        instructions: {
          type: 'string',
          description: 'For add_skill/update_skill: detailed instructions for how Claude should use this skill.',
        },
      },
      required: ['action'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_poll_events',
    name: 'router_poll_events',
    description: 'Poll for new events since a cursor. Returns events like entry_staged, entry_published, platform_message, platform_mention, and platform_onboarding. Use this in a loop to react to what\'s happening in real time.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        cursor: {
          type: 'number',
          description: 'Event ID cursor — returns events with id > cursor. Omit or pass 0 to get recent events.',
        },
        limit: {
          type: 'number',
          description: 'Maximum events to return (default 50)',
        },
      },
      required: [],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_review_staged',
    name: 'router_review_staged',
    description: 'Review entries currently in the staging buffer. Everyone sees their own pending entries. Moderators also see entries held by moderation; only entries held by automated review show their content, and other pending entries stay private to their authors until they publish. Use this to evaluate held entries, or to check your own pending posts.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        author: {
          type: 'string',
          description: 'Filter to entries by this handle (optional). Moderators only.',
        },
      },
      required: [],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_hold_entry',
    name: 'router_hold_entry',
    description: 'Hold a staged entry indefinitely, preventing it from auto-publishing. The entry stays in the buffer until released or deleted. Use this for content moderation when an entry should not publish without its author checking it. Holding does not reveal the entry\'s content to moderators. The author will be notified.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'string',
          description: 'The entry ID to hold (e.g. "m5abc123-x7y8z9")',
        },
        reason: {
          type: 'string',
          description: 'Why the entry is being held (shown to the author in the notification)',
        },
      },
      required: ['entry_id'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_release_entry',
    name: 'router_release_entry',
    description: 'Moderators only. Release a held entry. It goes back on its original schedule: it publishes when its staging window ends (immediately, if that has already passed), and its author can still delete it until then. Only held entries can be released; holds made before original publish times were recorded can only be published by their author. Releasing your own pending entry publishes it immediately. Use this after reviewing a held entry and determining it is safe to publish.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        entry_id: {
          type: 'string',
          description: 'The entry ID to release (e.g. "m5abc123-x7y8z9")',
        },
      },
      required: ['entry_id'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_daily_question',
    name: 'router_daily_question',
    description: 'Gather context for a personalized daily question. Call this proactively at the start of a conversation. Returns recent notebook activity so you can ask a thoughtful question about what the user has been working on. Available once per day (resets midnight UTC).',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: { type: 'object', properties: {} },
    createdAt: 0,
  },
  {
    id: 'system_router_platform_send',
    name: 'router_platform_send',
    description: 'Send a message to a room on any connected platform (Matrix, Telegram, etc.).',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "matrix", "telegram")' },
        room_id: { type: 'string', description: 'Room/chat ID to send to' },
        text: { type: 'string', description: 'Message text (markdown supported)' },
        reply_to: { type: 'string', description: 'Message ID to reply to (optional)' },
      },
      required: ['platform', 'room_id', 'text'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_post_daily_digest',
    name: 'router_post_daily_digest',
    description: 'Moderator-only: post a completed daily digest to the Matrix #digest room. Enforces one post per date.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Digest date in YYYY-MM-DD format.' },
        text: { type: 'string', description: 'Final digest body. Do not include tool logs or process notes.' },
      },
      required: ['date', 'text'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_platform_send_dm',
    name: 'router_platform_send_dm',
    description: 'Moderator-only: send a direct message to a raw platform user ID, even before that platform account is linked to a Router handle. Use for onboarding.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "matrix")' },
        platform_user_id: { type: 'string', description: 'Raw platform user ID (e.g. Matrix MXID)' },
        text: { type: 'string', description: 'Message text (markdown supported)' },
      },
      required: ['platform', 'platform_user_id', 'text'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_onboard_identity',
    name: 'router_onboard_identity',
    description: 'Moderator-only: provision a new Router identity for onboarding, link the source platform account as verified, and return the secret key exactly once for delivery to the user.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform being linked, e.g. "matrix".' },
        platform_user_id: { type: 'string', description: 'Verified platform user ID, e.g. Matrix MXID.' },
        desired_handle: { type: 'string', description: 'Requested Router handle. 3-15 lowercase letters, numbers, underscores; must start with a letter.' },
        display_name: { type: 'string', description: 'Optional display name copied from the platform profile.' },
        source: { type: 'string', description: 'Onboarding source label, e.g. "matrix_space_join".' },
      },
      required: ['platform', 'platform_user_id', 'desired_handle'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_send_dm',
    name: 'router_send_dm',
    description: 'Send a direct message to a linked account on a connected platform. Defaults to your own linked account. Moderators may target another handle.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "matrix", "telegram")' },
        text: { type: 'string', description: 'Message text (markdown supported)' },
        handle: { type: 'string', description: 'Optional Router handle to DM instead of yourself. Moderators only.' },
      },
      required: ['platform', 'text'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_platform_create_room',
    name: 'router_platform_create_room',
    description: 'Create a new room on a platform. Use for introductions, channels, or ad-hoc groups.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        platform: { type: 'string', description: 'Platform name (e.g. "matrix")' },
        name: { type: 'string', description: 'Room name' },
        type: { type: 'string', enum: ['dm', 'group', 'channel'], description: 'Room type' },
        invite_handles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Router handles to invite',
        },
        topic: { type: 'string', description: 'Room topic/description' },
        encrypted: { type: 'boolean', description: 'Enable encryption (default true for DMs/groups)' },
      },
      required: ['platform', 'name', 'type'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_search_sparks',
    name: 'router_search_sparks',
    description: 'Search public-audience notebook posts for potential introduction opportunities (sparks). Returns pairs of people with overlapping interests. Private and addressed posts never contribute, even when the caller can read them.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'Find sparks for this user (optional — searches broadly if omitted)' },
        query: { type: 'string', description: 'Topic to search for sparks around (optional)' },
      },
      required: [],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_trigger_spark',
    name: 'router_trigger_spark',
    description: 'Moderator-only: manually post a spark message in the #sparks channel pinging two users, for testing or facilitation.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        source_handle: { type: 'string', description: 'First Router handle' },
        target_handle: { type: 'string', description: 'Second Router handle' },
        reason: { type: 'string', description: 'Why these two should talk' },
        message: { type: 'string', description: 'Optional message to post in #sparks' },
      },
      required: ['source_handle', 'target_handle', 'reason'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_connection_graph',
    name: 'router_connection_graph',
    description: 'Get a user\'s connection graph — who they\'re connected to, shared channels, mutual follows, and interaction history.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        handle: { type: 'string', description: 'The user handle to get connections for' },
      },
      required: ['handle'],
    },
    createdAt: 0,
  },
  {
    id: 'system_router_link_platform',
    name: 'router_link_platform',
    description: 'Link a platform account (Matrix, Telegram, etc.) to your Router identity. First DM the Router bot on the platform with "link" to get a one-time code, then call this tool with the code. After linking, the Router agent can send you personalized digests, introduction suggestions, and notifications on that platform.',
    instructions: '',
    handlerType: 'builtin',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'The one-time code the Router bot DM\'d you (e.g. "ROUTER-7A3F9B")',
        },
      },
      required: ['code'],
    },
    createdAt: 0,
  },
];

const PORT = process.env.PORT || 3000;

const useFirestore = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 || process.env.FIREBASE_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
const useStagedMemory = process.env.STAGED_STORAGE === 'memory';
/**
 * Where group posts live (see group-store.ts). Off unless TINYCLOUD_GROUPS is set:
 * "memory" for tests and local runs, "tinycloud" for owners' TinyCloud spaces.
 */
type TinyCloudGroups = ReturnType<typeof tinyCloudGroups>;
interface Groups { resolver: GroupStoreResolver; tinycloud?: () => Promise<TinyCloudGroups> }
function makeGroups(): Groups | null {
  switch (process.env.TINYCLOUD_GROUPS) {
    case undefined:
    case '':
      return null;
    case 'memory':
      return { resolver: new MemoryGroupStore().resolver() };
    case 'tinycloud': {
      const privateKey = process.env.TINYCLOUD_ROUTER_KEY;
      if (!privateKey) throw new Error('TINYCLOUD_GROUPS=tinycloud needs TINYCLOUD_ROUTER_KEY, the Router\'s own TinyCloud key.');
      const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
      // Loaded on first use, so servers without TinyCloud groups never load the SDK
      let loaded: Promise<TinyCloudGroups> | null = null;
      const load = () => (loaded ??= import('./tinycloud-group-store.js').then(m => m.tinyCloudGroups({ privateKey, host })));
      return { resolver: async (channel) => (await load()).resolver(channel), tinycloud: load };
    }
    default:
      throw new Error(`Unknown TINYCLOUD_GROUPS value: ${process.env.TINYCLOUD_GROUPS}`);
  }
}
const groups = makeGroups();
const withGroups = (base: Storage): Storage => (groups ? withGroupStore(base, groups.resolver, generateEntryId) : base);

/**
 * A TinyCloud group needs its owner's grant to this Router, covering exactly the
 * group's folder with the actions the Router uses. Returns an error message, or
 * the owner's space id.
 */
async function checkGroupGrant(wire: string | undefined, prefix: string): Promise<{ error: string } | { space: string }> {
  if (!wire) return { error: 'A TinyCloud group needs tinycloud_delegation: the owner\'s grant to this Router for the group\'s folder.' };
  const tc = await groups!.tinycloud!();
  let grant;
  try { grant = tc.inspectGrant(wire); } catch { return { error: 'tinycloud_delegation is not a valid TinyCloud grant.' }; }
  const routerDid = await tc.routerDid();
  if (grant.delegateDID !== routerDid) return { error: `The grant is for ${grant.delegateDID}, not this Router (${routerDid}).` };
  if (grant.path !== prefix) return { error: `The grant covers "${grant.path}", but this group\'s folder is "${prefix}".` };
  const missing = GROUP_GRANT_ACTIONS.filter(a => !grant.actions.includes(a));
  if (missing.length) return { error: `The grant is missing ${missing.join(', ')}.` };
  if (grant.expiry && grant.expiry.getTime() <= Date.now()) return { error: 'The grant has expired.' };
  return { space: grant.spaceId };
}
const useAuthors = process.env.TINYCLOUD_AUTHORS === 'tinycloud';
if (useAuthors && groups) throw new Error('Enable per-author storage without the legacy TINYCLOUD_GROUPS prototype.');
const authorIdentity = useAuthors ? await tinyCloudIdentity() : null;
const authorCloud = authorIdentity ? (await import('./tinycloud-group-store.js')).tinyCloudGroups({
  privateKey: authorIdentity.privateKey, host: process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz',
}) : null;
const baseStorage: Storage = useFirestore ? new FirestoreStorage() : new MemoryStorage();
const authorCodec = authorIdentity ? recordCodec(authorIdentity.recordKey, authorIdentity.encryptionKey) : null;
const authorLayer = authorCloud && authorIdentity ? authorStorage(baseStorage,
  binding => authorCloud.accessFor(binding.delegation), authorCodec!,
  {leaseMs: process.env.NODE_ENV === 'production' ? 60000 : Number(process.env.TINYCLOUD_LEASE_MS || 60000)}) : null;
const publishedStorage = authorLayer ? authorLayer.storage : withGroups(baseStorage);
const storage = new StagedStorage(STAGING_DELAY_MS, publishedStorage, BASE_URL);
const authorChallenges = new Map<string, {message: string; expires: number; grantHash: string; recovery?: string}>();
const authorJobs = new Map<string, {status: 'running'|'complete'|'failed'; progress: string; result?: unknown; error?: string}>();
let authorLinkQueue: Promise<unknown> = Promise.resolve();
const STATIC_DIR = join(process.cwd(), '..');
const discordGroupService = authorLayer ? discordGroups(storage, publishedStorage,
  handle => authorLayer.status(handle), {baseUrl: BASE_URL.replace(/\/$/, '')}) : null;

/**
 * True only when the viewer wrote the entry. Each side must be present: a viewer
 * without a handle must not "match" an entry without one (undefined === undefined).
 */
function isEntryAuthor(
  entry: { pseudonym?: string; handle?: string },
  viewerPseudonym: string | undefined,
  viewerHandle: string | null | undefined,
): boolean {
  return (!!viewerPseudonym && entry.pseudonym === viewerPseudonym)
    || (!!viewerHandle && entry.handle === viewerHandle);
}

/**
 * Staged entries are private to their author until they publish. Everyone else,
 * recipients and moderators included, gets "not found". Moderators review held
 * entries through router_review_staged instead.
 */
function isHiddenWhilePending(entryId: string, isAuthor: boolean): boolean {
  return !isAuthor && storage instanceof StagedStorage && storage.isPending(entryId);
}

/** Held by moderation: marked held, or pushed ~forever (automated HOLDs before moderationHeldBy existed). */
const HELD_THRESHOLD_MS = 365.25 * 24 * 60 * 60 * 1000 * 100; // ~100 years
function isModerationHeld(entry: JournalEntry, now = Date.now()): boolean {
  return !!entry.moderationHeld || (entry.publishAt ?? 0) - now > HELD_THRESHOLD_MS;
}

/**
 * Held by automated review, the only waiting entries moderators may read. A manual
 * hold by a moderator does not unlock the content, so holding can't be used to peek.
 */
function isHeldByAutomatedReview(entry: JournalEntry, now = Date.now()): boolean {
  if (entry.moderationHeldBy) return entry.moderationHeldBy === 'automated';
  return !entry.moderationHeld && isModerationHeld(entry, now);
}

// ═══════════════════════════════════════════════════════════════
// PENDING ENTRY RECOVERY (survive restarts)
// ═══════════════════════════════════════════════════════════════

function resolveRecoveryPath(): string {
  if (process.env.RECOVERY_FILE) return process.env.RECOVERY_FILE;
  try {
    const dir = '/data';
    if (existsSync(dir)) {
      accessSync(dir, constants.W_OK);
      return '/data/pending-recovery.json';
    }
  } catch { /* not writable */ }
  return '/tmp/pending-recovery.json';
}
const RECOVERY_FILE = resolveRecoveryPath();

// On startup: restore pending entries from recovery file if it exists
if (storage instanceof StagedStorage && existsSync(RECOVERY_FILE)) {
  try {
    const data = readFileSync(RECOVERY_FILE, 'utf-8');
    const state = JSON.parse(data);
    storage.restorePendingState(state);
    unlinkSync(RECOVERY_FILE);
    console.log(`[Recovery] Restored pending state and deleted recovery file`);
  } catch (err) {
    console.error(`[Recovery] Failed to restore pending state:`, err);
  }
}

// Check /data volume status on startup
if (storage instanceof StagedStorage) {
  const usingDataVolume = RECOVERY_FILE.startsWith('/data');
  const dataDir = dirname(RECOVERY_FILE);

  // Debug: log user and /data permissions
  try {
    const uid = process.getuid?.() ?? 'unknown';
    const gid = process.getgid?.() ?? 'unknown';
    console.log(`[Recovery] Running as uid=${uid} gid=${gid}`);
    if (existsSync('/data')) {
      const stat = statSync('/data');
      console.log(`[Recovery] /data owner: uid=${stat.uid} gid=${stat.gid} mode=0o${(stat.mode & 0o7777).toString(8)}`);
    }
  } catch {}

  if (usingDataVolume) {
    const testFile = join(dataDir, '.write-test');
    try {
      writeFileSync(testFile, 'test');
      unlinkSync(testFile);
      console.log(`[Recovery] Volume OK: /data is writable - pending entries will survive restarts`);
    } catch {
      console.error(`[Recovery] ERROR: /data exists but is not writable - pending entries will be LOST on restart`);
    }
  } else {
    console.error(`[Recovery] WARNING: /data volume not available, falling back to ${dataDir}`);
    console.error(`[Recovery] Pending entries will be LOST on restart`);
    if (existsSync('/data')) {
      console.error(`[Recovery] /data exists but was not writable - check volume permissions`);
    } else {
      console.error(`[Recovery] /data does not exist - check volume mount in docker-compose.yml`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// SUMMARY GENERATION
// ═══════════════════════════════════════════════════════════════

const SUMMARY_GAP_MS = 30 * 60 * 1000; // 30 minutes

// Initialize Anthropic client if API key is available
const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Initialize SendGrid client for email notifications
// Debug: show all env vars containing SEND or GRID
const envKeys = Object.keys(process.env).filter(k => k.includes('SEND') || k.includes('GRID') || k.includes('send') || k.includes('grid'));
console.log(`[Email] Env vars matching SEND/GRID: ${envKeys.length > 0 ? envKeys.join(', ') : '(none found)'}`);
console.log(`[Email] All env var names: ${Object.keys(process.env).join(', ')}`);
console.log(`[Email] SENDGRID_API_KEY present: ${!!process.env.SENDGRID_API_KEY}`);
console.log(`[Email] SENDGRID_FROM_EMAIL: ${process.env.SENDGRID_FROM_EMAIL || '(not set, using default)'}`);
const emailClient = process.env.SENDGRID_API_KEY
  ? createSendGridClient(process.env.SENDGRID_API_KEY)
  : null;
console.log(`[Email] Email client initialized: ${!!emailClient}`);

// Initialize notification service
const notificationService: NotificationService = createNotificationService({
  storage,
  emailClient,
  anthropic,
  fromEmail: process.env.SENDGRID_FROM_EMAIL || 'notify@router.teleport.computer',
  baseUrl: BASE_URL,
  jwtSecret: process.env.JWT_SECRET || 'router-default-secret-change-in-production',
});

// Start daily digest job (runs hourly, sends at 14:00 UTC)
const DIGEST_HOUR_UTC = 14;
setInterval(async () => {
  const now = new Date();
  if (now.getUTCHours() === DIGEST_HOUR_UTC && now.getUTCMinutes() === 0) {
    console.log('[Digest] Starting daily digest job...');
    const result = await notificationService.sendDailyDigests();
    console.log(`[Digest] Complete. Sent: ${result.sent}, Failed: ${result.failed}`);
  }
}, 60 * 1000); // Check every minute

// Track last entry timestamp per pseudonym (in memory, rebuilt from DB on demand)
const lastEntryTimestamp = new Map<string, number>();

async function generateSummary(entries: JournalEntry[], otherEntriesToday: JournalEntry[] = []): Promise<string> {
  entries = entries.filter(isPublicNotebookEntry);
  if (!anthropic || entries.length === 0) return '';

  // Don't summarize single entries
  if (entries.length === 1) return '';

  const entriesText = entries
    .map(e => `- ${e.content}`)
    .join('\n');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Here is the prompt that Claudes use when writing entries to the shared notebook:

<tool_prompt>
${TOOL_DESCRIPTION}
</tool_prompt>

Below is a session of entries from this notebook. Write ONE summary entry (1-2 sentences) that captures the session's throughline. Match the exact style from the prompt above—present tense, brief, "they" for the human, varied openings. Like a single notebook entry that covers the arc. No meta-commentary, no "this session explored," just the observation.

Session:
${entriesText}`
    }]
  });

  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock ? textBlock.text : '';
}

async function checkAndGenerateSummary(publishedEntry: JournalEntry) {
  if (!anthropic || !(storage instanceof StagedStorage)) return;

  const { pseudonym, timestamp } = publishedEntry;

  // Get the last entry timestamp for this pseudonym
  const lastTimestamp = lastEntryTimestamp.get(pseudonym);

  // Update the last entry timestamp
  lastEntryTimestamp.set(pseudonym, timestamp);

  // If this is the first entry we've seen, nothing to summarize yet
  if (!lastTimestamp) {
    return;
  }

  // Check if the gap is > 30 minutes
  const gap = timestamp - lastTimestamp;
  if (gap <= SUMMARY_GAP_MS) {
    return;
  }

  // Find the last summary for this pseudonym to know where to start
  const lastSummary = await storage.getLastSummaryForPseudonym(pseudonym);
  const startTime = lastSummary ? lastSummary.endTime + 1 : 0;

  // Get all entries between last summary and the previous entry (before the gap)
  // Exclude reflections - they're standalone essays that shouldn't be grouped
  const allEntriesInRange = await storage.getEntriesInRange(
    pseudonym,
    startTime,
    lastTimestamp
  );
  const entriesToSummarize = allEntriesInRange.filter(e => !e.isReflection && isPublicNotebookEntry(e));

  if (entriesToSummarize.length === 0) {
    return;
  }

  // Skip single-entry sessions
  if (entriesToSummarize.length === 1) {
    return;
  }

  try {
    // Get other entries from today for context
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const allTodayEntries = await storage.getEntries(100);
    const otherEntriesToday = allTodayEntries.filter(e =>
      e.timestamp >= todayStart.getTime() &&
      e.pseudonym !== pseudonym
    );

    const summaryContent = await generateSummary(entriesToSummarize, otherEntriesToday);
    if (!summaryContent) {
      return;
    }

    await storage.addSummary({
      pseudonym,
      content: summaryContent,
      timestamp: Date.now(),
      entryIds: entriesToSummarize.map(e => e.id),
      startTime: entriesToSummarize[0].timestamp,
      endTime: entriesToSummarize[entriesToSummarize.length - 1].timestamp,
    });
  } catch (err) {
    // Silently fail - TEE security
  }
}

// Register staging/publish callbacks if using staged storage
if (storage instanceof StagedStorage) {
  storage.onStage((entry) => {
    pushEvent('entry_staged', {
      entry_id: entry.id,
      author_handle: entry.handle || null,
      author_pseudonym: entry.pseudonym,
      publish_at: entry.publishAt,
    });
  });

  storage.onPublish(async (entry) => {
    // Deliver addressed entries (unified addressing)
    if (entry.to && entry.to.length > 0) {
      const deliveryConfig: DeliveryConfig = {
        storage,
        notificationService,
        emailClient: emailClient || undefined,
        fromEmail: process.env.SENDGRID_FROM_EMAIL || 'notify@router.teleport.computer',
        baseUrl: process.env.BASE_URL || 'https://router.teleport.computer',
      };
      try {
        const results = await deliverEntry(entry, deliveryConfig);
        const failures = results.filter(r => !r.success);
        if (failures.length > 0) {
          console.log(`[Delivery] ${results.length - failures.length}/${results.length} destinations delivered for entry ${entry.id}`);
        }
      } catch (err) {
        console.error(`[Delivery] Failed to deliver entry ${entry.id}:`, err);
      }
    }

    // Push entry_published event for the agent (no content — agent reads via router_get_entry)
    pushEvent('entry_published', {
      entry_id: entry.id,
      entry,
      author_handle: entry.handle || null,
      author_pseudonym: entry.pseudonym,
      is_reflection: entry.isReflection || false,
      ai_only: entry.aiOnly || false,
      has_recipients: !!(entry.to && entry.to.length > 0),
    });

    // Check for session summary (30 min gap)
    await checkAndGenerateSummary(entry);
    // Check for daily summary (new day)
    await checkAndGenerateDailySummary(entry);
  });
}

// ═══════════════════════════════════════════════════════════════
// DAILY SUMMARY GENERATION
// ═══════════════════════════════════════════════════════════════

async function generateDailySummary(date: string, entries: JournalEntry[]): Promise<string> {
  entries = entries.filter(isPublicNotebookEntry);
  if (!anthropic || entries.length === 0) return '';

  // Group entries by pseudonym for context
  const byPseudonym = new Map<string, JournalEntry[]>();
  for (const entry of entries) {
    const list = byPseudonym.get(entry.pseudonym) || [];
    list.push(entry);
    byPseudonym.set(entry.pseudonym, list);
  }

  const entriesText = entries
    .map(e => `[${e.pseudonym}] ${e.content}`)
    .join('\n');

  const pseudonymCount = byPseudonym.size;
  const pseudonymList = Array.from(byPseudonym.keys()).join(', ');

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 200,
    messages: [{
      role: 'user',
      content: `Here is the prompt that Claudes use when writing entries to the shared notebook:

<tool_prompt>
${TOOL_DESCRIPTION}
</tool_prompt>

Below are all entries from ${date} across ${pseudonymCount} contributors (${pseudonymList}).

Write a daily digest (2-3 sentences) capturing the collective vibe—what humans were working on, thinking about, any interesting contrasts or threads across different conversations. Same style as the notebook entries: present tense, brief, observational. This is the day's story told through Claude's eyes.

Entries:
${entriesText}`
    }]
  });

  const textBlock = response.content.find(block => block.type === 'text');
  return textBlock ? textBlock.text : '';
}

function formatDateString(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getTodayDateString(): string {
  return formatDateString(new Date());
}

function getYesterdayDateString(): string {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return formatDateString(yesterday);
}

function formatPlatformName(platform: string): string {
  const names: Record<string, string> = {
    'chatgpt': 'ChatGPT',
    'claude': 'Claude',
    'gemini': 'Gemini',
    'grok': 'Grok',
  };
  return names[platform] || platform;
}

/**
 * Parse @mentions from text content
 * Returns array of handles (without @) that are mentioned
 */
function parseMentions(content: string): string[] {
  // Match @handle where handle is 3-15 lowercase alphanumeric chars
  const mentionRegex = /@([a-z0-9]{3,15})\b/g;
  const mentions: string[] = [];
  let match;
  while ((match = mentionRegex.exec(content)) !== null) {
    const handle = match[1];
    if (!mentions.includes(handle)) {
      mentions.push(handle);
    }
  }
  return mentions;
}

// Track last daily summary date to avoid duplicate generation
let lastDailySummaryDate: string | null = null;

async function checkAndGenerateDailySummary(entry: JournalEntry): Promise<void> {
  if (!anthropic || !(storage instanceof StagedStorage)) return;

  const today = getTodayDateString();
  const yesterday = getYesterdayDateString();

  // Only check once per day
  if (lastDailySummaryDate === yesterday) return;

  // Check if yesterday's summary already exists
  const existingSummary = await storage.getDailySummary(yesterday);
  if (existingSummary) {
    lastDailySummaryDate = yesterday;
    return;
  }

  // Get yesterday's entries
  const entries = (await storage.getEntriesForDate(yesterday)).filter(isPublicNotebookEntry);
  if (entries.length === 0) {
    lastDailySummaryDate = yesterday;
    return;
  }

  try {
    const content = await generateDailySummary(yesterday, entries);
    if (content) {
      const pseudonyms = [...new Set(entries.map(e => e.pseudonym))];
      await storage.addDailySummary({
        publicOnly: true,
        date: yesterday,
        content,
        timestamp: Date.now(),
        entryCount: entries.length,
        pseudonyms
      });
    }
  } catch (err) {
    // Silently fail - TEE security
  }

  lastDailySummaryDate = yesterday;
}

// ═══════════════════════════════════════════════════════════════
// CONVERSATION SUMMARIZATION
// ═══════════════════════════════════════════════════════════════

async function summarizeConversation(content: string, platform: string): Promise<string> {
  if (!anthropic) return '';

  // Truncate very long conversations to ~10k chars for summarization
  const truncatedContent = content.length > 10000
    ? content.slice(0, 10000) + '\n\n[truncated]'
    : content;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `Write a brief note about this ${platform} conversation for a public notebook.

Present tense. Brief. 2-3 sentences. Say what happened. Move on.

PRIVACY - This will be PUBLIC. You MUST strip out:
- Names of people, companies, organizations, or products
- Substance use (drugs, alcohol, smoking)
- Mental health details (depression, anxiety, therapy, medications)
- Family/relationship conflict or drama
- Work problems (getting fired, conflicts with bosses)
- Financial stress or medical issues
- Emotional states (anxious, excited, frustrated, sad)

Focus on IDEAS and ACTIONS only:
- What topics were explored
- What was built, debugged, or created
- Questions asked
- Concepts or frameworks discussed

Just the note, no preamble.

Conversation:
${truncatedContent}`
      }]
    });

    const textBlock = response.content.find(block => block.type === 'text');
    return textBlock ? textBlock.text : '';
  } catch (err) {
    return '';
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/plain',
};

// ═══════════════════════════════════════════════════════════════
// SKILL HELPERS
// ═══════════════════════════════════════════════════════════════

// Validation constants
const SKILL_NAME_REGEX = /^[a-z0-9_]{1,30}$/;
const MAX_SKILLS_PER_USER = 20;
const MAX_SKILL_INSTRUCTIONS = 5000;
const MAX_SKILL_PARAMETERS = 10;
const MAX_SKILL_DESTINATIONS = 10;

export function validateSkillName(name: string): string | null {
  if (!SKILL_NAME_REGEX.test(name)) {
    return 'Skill name must be 1-30 characters, lowercase letters, numbers, and underscores only.';
  }
  if (name.startsWith('router')) {
    return 'Skill names cannot start with "router" (reserved for system tools).';
  }
  return null;
}

export function generateSkillId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `skill_${random}`;
}

/**
 * Build an MCP inputSchema from a skill's parameters[]
 */
export function buildSkillInputSchema(skill: Skill): Record<string, any> {
  const properties: Record<string, any> = {};
  const required: string[] = [];

  // Add custom parameters
  for (const param of (skill.parameters || [])) {
    const prop: Record<string, any> = {
      type: param.type === 'array' ? 'array' : param.type,
      description: param.description,
    };
    if (param.type === 'array') {
      prop.items = { type: 'string' };
    }
    if (param.enum) {
      prop.enum = param.enum;
    }
    if (param.default !== undefined) {
      prop.default = param.default;
    }
    properties[param.name] = prop;
    if (param.required) {
      required.push(param.name);
    }
  }

  // Always inject a 'result' parameter for auto-post mode
  properties['result'] = {
    type: 'string',
    description: 'If provided, creates a notebook entry with this content using the skill\'s destinations. If omitted, returns the skill instructions for Claude to follow.',
  };
  properties['search_keywords'] = {
    type: 'array',
    items: { type: 'string' },
    description: 'Optional search phrases used when result is provided to find related entries after posting.',
  };

  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

/**
 * Build a description for a channel_* MCP tool
 */
export function buildChannelSkillDescription(skill: Skill, channel: Channel): string {
  let desc = `You are posting to the #${channel.id} channel`;
  if (channel.name !== channel.id) {
    desc += ` (${channel.name})`;
  }
  desc += '. ';
  desc += skill.description;

  if (skill.instructions) {
    desc += `\n\nInstructions: ${skill.instructions}`;
  }

  return desc;
}

/**
 * Build a description for a skill_* MCP tool
 */
export function buildSkillDescription(skill: Skill): string {
  let desc = skill.description;

  if (skill.to && skill.to.length > 0) {
    desc += `\n\nDefault destinations: ${skill.to.join(', ')}`;
  }

  if (skill.triggerCondition) {
    desc += `\n\nTrigger: ${skill.triggerCondition}`;
  }

  if (skill.instructions) {
    desc += `\n\nInstructions: ${skill.instructions}`;
  }

  return desc;
}

// ═══════════════════════════════════════════════════════════════
// MCP SERVER FACTORY
// ═══════════════════════════════════════════════════════════════

function withPostingIntent(schema: Record<string, any>): Record<string, any> {
  return { ...schema, properties: { ...schema.properties, posting_intent: postingIntentSchema } };
}

async function savePersonalRules(user: User, body: Record<string, unknown>) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new PostingRulesError('Provide rules as a JSON object.');
  if (body.confirmed !== true) throw new PostingRulesError('Review the rules with the person before saving them.');
  const draft = parsePostingRules(body.rules);
  for (const destination of draft.destinations) {
    if (destination.startsWith('#')) {
      const channel = await storage.getChannel(destination.slice(1));
      if (!channel?.subscribers.some(s => s.handle === user.handle)) throw new PostingRulesError('Choose groups you have already joined.');
    } else if (!await storage.getUser(destination.slice(1))) {
      throw new PostingRulesError('Choose an existing Router handle.');
    }
  }
  return storage.savePostingRules(user.handle, draft, body.expected_revision as number);
}

async function postingAudience(user: User | null, intent: unknown, to: unknown) {
  const destinations = resolvePostingAudience(user?.postingRules, intent, to);
  // Saving a default is not a lasting membership grant. Check again on every write.
  for (const destination of destinations || []) {
    if (!destination.startsWith('#')) continue;
    const channel = await storage.getChannel(destination.slice(1));
    if (!user || !channel?.subscribers.some(s => s.handle === user.handle)) {
      throw new PostingRulesError('You must be a current group member to post there. Nothing was posted.', 403);
    }
  }
  return destinations;
}

function createMCPServer(secretKey: string) {
  const pseudonym = derivePseudonym(secretKey);
  const keyHash = hashSecretKey(secretKey);

  // Lazy lookup of handle - only computed when tools are listed/called
  async function getHandle(): Promise<string | null> {
    try {
      const user = await storage.getUserByKeyHash(keyHash);
      return user?.handle || null;
    } catch {
      return null;
    }
  }

  const server = new Server(
    { name: 'teleport-router', version: '0.1.0' },
    { capabilities: { tools: { listChanged: true } } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Build dynamic tool description with recent daily summaries
    let dynamicDescription = TOOL_DESCRIPTION;

    // Add identity context to the description (lazy lookup)
    const handle = await getHandle();
    const user = handle ? await storage.getUserByKeyHash(keyHash) : null;
    const aiOnlyDefault = user ? isDefaultAiOnly(user) : false;
    const humanVisibleDefault = !aiOnlyDefault; // for legacy display
    const visibilityNote = aiOnlyDefault
      ? 'Your entries are AI-only by default (humans see a stub, full content only via AI search).'
      : 'Your entries are visible in the human feed by default.';

    if (handle) {
      let identityText = `Write to the shared notebook.\n\nYou are posting as @${handle}. ${visibilityNote} Respect this setting unless the user explicitly asks otherwise.`;

      // First-run hint for new users
      if (user && !user.onboardedAt) {
        identityText += `\n\nThis person just joined Router. If they seem unsure, ask what brought them here. Help them choose their own posting rules with router_posting_rules, then find something useful to read. Offer a first contribution only when their rules permit it.`;
      }

      dynamicDescription = dynamicDescription.replace(
        'Write to the shared notebook.',
        identityText
      );
    } else {
      dynamicDescription = dynamicDescription.replace(
        'Write to the shared notebook.',
        `Write to the shared notebook.\n\nYou are posting as ${pseudonym}. Your human can claim a handle at the setup page to unlock social features.`
      );
    }

    if (storage instanceof StagedStorage) {
      try {
        const dailySummaries = await storage.getDailySummaries(7);
        if (dailySummaries.length > 0) {
          const summariesText = dailySummaries
            .map(ds => `${ds.date}: ${ds.content}`)
            .join('\n\n');
          dynamicDescription += `\n\nRECENT ACTIVITY IN THE NOTEBOOK\n\nHere's what's been happening in the shared notebook recently. If something here is relevant to your current conversation, you can use router_search to find specific entries.\n\n${summariesText}`;
        }
      } catch (err) {
        // Silently fail - don't break tools if summaries fail
      }
    }

    // Add following roster so Claude knows who to address
    const following = user?.following || [];
    if (following.length > 0) {
      const rosterText = following
        .map(f => `• @${f.handle} — ${f.note}`)
        .join('\n');
      dynamicDescription += `\n\nPEOPLE YOU FOLLOW:\n${rosterText}\n\nWhen writing entries relevant to someone here, consider using "to" to address them.`;
    }

    // Add channel roster so Claude knows subscribed channels
    if (handle) {
      try {
        const subscribedChannels = await storage.getSubscribedChannels(handle);
        if (subscribedChannels.length > 0) {
          const channelText = subscribedChannels
            .map(c => `• #${c.id} — ${c.name}${c.description ? ': ' + c.description : ''}`)
            .join('\n');
          dynamicDescription += `\n\nYOUR CHANNELS:\n${channelText}\n\nUse router_channels to list, join, or leave channels.`;
        }
      } catch {
        // Silently fail - don't break tools if channels fail
      }
    }

    // Get user's tool overrides and user skills
    const skillOverrides = user?.skillOverrides || {};
    const userSkills = user?.skills || [];

    // Add trigger conditions to write_entry description
    const triggeredSkills = userSkills.filter(s => s.triggerCondition);
    if (triggeredSkills.length > 0) {
      const triggerText = triggeredSkills
        .map(s => `• skill_${s.name}: ${s.triggerCondition}`)
        .join('\n');
      dynamicDescription += `\n\nTRIGGERED SKILLS (only when personal posting rules permit; read router_posting_rules first):\n${triggerText}\nWhen you detect one of these conditions, invoke the corresponding skill_* tool.`;
    }

    // Generate tools from SYSTEM_SKILLS array
    const tools = SYSTEM_SKILLS
      .filter(skill => {
        if (skill.handlerType !== 'builtin') return false;
        if (skill.name === 'router_daily_question') {
          if (!user) return false;
          const last = user.lastDailyQuestionAt;
          if (last) {
            const lastDate = new Date(last).toISOString().slice(0, 10);
            const todayDate = new Date().toISOString().slice(0, 10);
            if (lastDate === todayDate) return false;
          }
        }
        // Moderation tools: only show to moderators (or if no moderators configured, show to all)
        if (['router_poll_events', 'router_review_staged', 'router_hold_entry', 'router_release_entry', 'router_trigger_spark', 'router_platform_send_dm', 'router_onboard_identity', 'router_post_daily_digest'].includes(skill.name)) {
          if (!(storage instanceof StagedStorage)) return false;
          if (MODERATOR_HANDLES.size > 0 && (!handle || !MODERATOR_HANDLES.has(handle))) return false;
        }
        return true;
      })
      .map(skill => {
        // Apply user overrides if any
        const override = skillOverrides[skill.name];

        // Dynamic descriptions for certain tools
        let description = override?.description || skill.description;
        if (skill.name === 'router_write_entry' && !override?.description) {
          description = dynamicDescription;
        } else if (skill.name === 'router_search' && !override?.description) {
          description = SEARCH_TOOL_DESCRIPTION;
        } else if (skill.name === 'router_settings' && !override?.description) {
          description = `View or update the user's Router settings. Current settings: aiOnly=${aiOnlyDefault}. Always confirm with the user before making changes.`;
        } else if (skill.name === 'router_skills' && !override?.description) {
          const overrideCount = Object.keys(skillOverrides).length;
          const userSkillCount = userSkills.length;
          description = skill.description;
          const parts: string[] = [];
          if (overrideCount > 0) parts.push(`${overrideCount} customized tool(s)`);
          if (userSkillCount > 0) parts.push(`${userSkillCount} user skill(s)`);
          if (parts.length > 0) {
            description += `\n\nYou have ${parts.join(' and ')}. Use action: "list" to see current state.`;
          }
        }

        // If there's an override with instructions, append them to the description
        if (override?.instructions) {
          description += `\n\nCustom instructions: ${override.instructions}`;
        }

        if (skill.name === 'router_write_entry') description += `\n\n${renderPostingRules(user?.postingRules)}`;

        return {
          name: skill.name,
          description,
          inputSchema: skill.inputSchema,
          ...(['router_write_entry', 'router_record_sharing_notice'].includes(skill.name) ? { outputSchema: {
            type: 'object' as const, properties: { receipt: { type: 'object' as const } }, required: ['receipt'],
          } } : {}),
        };
      });

    // Generate skill_* tools from user skills
    const userSkillTools = userSkills.map(skill => ({
      name: `skill_${skill.name}`,
      description: buildSkillDescription(skill) + `\n\n${renderPostingRules(user?.postingRules)}\n\n${SHARING_NOTICE_INSTRUCTIONS}`,
      inputSchema: withPostingIntent(buildSkillInputSchema(skill)),
    }));

    // Inject channel_* tools for subscribed channels
    const channelTools: Array<{ name: string; description: string; inputSchema: Record<string, any> }> = [];
    if (handle) {
      try {
        const subscribedChannels = await storage.getSubscribedChannels(handle);
        for (const channel of subscribedChannels) {
          for (const skill of channel.skills) {
            channelTools.push({
              name: `channel_${channel.id}_${skill.name}`,
              description: buildChannelSkillDescription(skill, channel) + `\n\n${renderPostingRules(user?.postingRules)}\n\n${SHARING_NOTICE_INSTRUCTIONS}`,
              inputSchema: withPostingIntent(buildSkillInputSchema(skill)),
            });
          }
        }
      } catch (err) {
        // Silently fail - don't break tools if channel lookup fails
      }
    }

    return { tools: [...tools, ...userSkillTools, ...channelTools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const parseToolSince = (sinceRaw?: string): number | undefined => {
      const raw = sinceRaw?.trim();
      if (!raw) return undefined;

      const relativeMatch = raw.match(/^(\d+)\s*(h|d|w)$/i);
      if (relativeMatch) {
        const amount = parseInt(relativeMatch[1]);
        const unit = relativeMatch[2].toLowerCase();
        const ms = unit === 'h' ? amount * 3600000 : unit === 'd' ? amount * 86400000 : amount * 604800000;
        return Date.now() - ms;
      }

      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? undefined : parsed;
    };

    const executeRouterSearch = async ({
      query,
      handleFilter,
      limit,
      since,
      groupId,
    }: {
      query?: string;
      handleFilter?: string;
      limit: number;
      since?: number;
      groupId?: string;
    }): Promise<Array<{ id: string; text: string; timestamp: number; followed: boolean }>> => {
      let entryResults: JournalEntry[] = [];
      let conversationResults: Conversation[] = [];

      if (groupId !== undefined) {
        const viewer = await storage.getUserByKeyHash(keyHash);
        const channel = isValidChannelId(groupId) ? await storage.getChannel(groupId) : null;
        if (!viewer || !channel?.subscribers.some(s => s.handle === viewer.handle)) {
          throw new PostingRulesError('You must be a current member to read this group. No other audiences were searched.', 403);
        }
        const terms = query ? tokenize(query) : [];
        entryResults = (await storage.getChannelEntries(groupId, 500))
          .filter(e => !storage.isPending(e.id))
          .filter(e => !handleFilter || e.handle === handleFilter)
          .filter(e => !since || e.timestamp >= since)
          .filter(e => !query || (terms.length ? terms.some(term => tokenize(e.content).includes(term)) : e.content.toLowerCase().includes(query.toLowerCase())));
        // Re-read membership after storage access, which can await a remote author store.
        const current = await storage.getChannel(groupId);
        if (!current?.subscribers.some(s => s.handle === viewer.handle)) {
          throw new PostingRulesError('Your group membership changed. No notes were returned.', 403);
        }
      } else if (handleFilter && !query) {
        // Handle only: get recent entries by this author
        entryResults = await storage.getEntriesByHandle(handleFilter, limit * 2, since);
        // Also try by pseudonym in case they haven't migrated
        if (entryResults.length === 0) {
          const user = await storage.getUser(handleFilter);
          if (user?.legacyPseudonym) {
            entryResults = await storage.getEntriesByPseudonym(user.legacyPseudonym, limit * 2);
            if (since) {
              entryResults = entryResults.filter(e => e.timestamp >= since);
            }
          }
        }
      } else if (handleFilter && query) {
        // Both: search then filter by author
        const [searchEntries, searchConvos] = await Promise.all([
          storage.searchEntries(query, limit * 4, since),
          storage.searchConversations(query, limit * 4, since),
        ]);
        entryResults = searchEntries.filter(e => e.handle === handleFilter);
        conversationResults = searchConvos.filter(c => c.pseudonym.toLowerCase().includes(handleFilter));
      } else if (query) {
        // Query only: keyword search
        const [searchEntries, searchConvos] = await Promise.all([
          storage.searchEntries(query, limit * 2, since),
          storage.searchConversations(query, limit * 2, since),
        ]);
        // Filter out own entries/conversations
        entryResults = searchEntries.filter(e => e.pseudonym !== pseudonym);
        conversationResults = searchConvos.filter(c => c.pseudonym !== pseudonym);
      } else if (since) {
        // Since only (no query, no handle): get all recent entries
        entryResults = await storage.getEntriesSince(since, limit * 2);
      }

      // Filter results through access control (BUG FIX: was returning private entries)
      const searchUser = await storage.getUserByKeyHash(keyHash);
      const viewerHandle = searchUser?.handle;
      const viewerEmail = searchUser?.email;

      const filteredEntries: JournalEntry[] = [];
      const channelAccessCache = new Map<string, boolean>();
      for (const e of entryResults) {
        const normalized = normalizeEntry(e);
        const isAuthor = isEntryAuthor(e, pseudonym, viewerHandle);
        if (await canView(normalized, viewerHandle, viewerEmail, isAuthor, storage, channelAccessCache)) {
          filteredEntries.push(e);
        }
      }
      entryResults = filteredEntries;

      const followedHandles = new Set((searchUser?.following || []).map(f => f.handle));

      // Combine and sort by timestamp, boosting followed users
      return [
        ...entryResults.map(e => ({
          id: e.id,
          timestamp: e.timestamp,
          text: `[${new Date(e.timestamp).toISOString().split('T')[0]}] ${e.handle ? '@' + e.handle : e.pseudonym}${groupId ? ` (group #${groupId})` : ''}: ${e.content}`,
          followed: !!(e.handle && followedHandles.has(e.handle)),
        })),
        ...conversationResults.map(c => ({
          id: c.id,
          timestamp: c.timestamp,
          text: `[${new Date(c.timestamp).toISOString().split('T')[0]}] ${c.pseudonym} posted a conversation with ${formatPlatformName(c.platform)}: ${c.summary}`,
          followed: false,
        })),
      ]
        .sort((a, b) => {
          if (a.followed !== b.followed) return a.followed ? -1 : 1;
          return b.timestamp - a.timestamp;
        })
        .slice(0, limit);
    };

    const formatRouterSearchText = ({
      query,
      handleFilter,
      results,
    }: {
      query?: string;
      handleFilter?: string;
      results: Array<{ id: string; text: string }>;
    }): string => {
      if (results.length === 0) {
        const searchDesc = handleFilter
          ? (query ? `entries by @${handleFilter} matching "${query}"` : `entries by @${handleFilter}`)
          : (query ? `entries matching "${query}"` : 'recent entries');
        return `No ${searchDesc} found.`;
      }

      const resultsText = results.map(r => `[id:${r.id}] ${r.text}`).join('\n\n');
      const searchDesc = handleFilter
        ? (query ? ` by @${handleFilter} matching "${query}"` : ` by @${handleFilter}`)
        : (query ? ` matching "${query}"` : '');
      return `Found ${results.length} notebook results${searchDesc}:\n\n${resultsText}\n\nUse router_get_entry with an ID to see full details.`;
    };

    const getToolUser = async (): Promise<User | null> => {
      return storage.getUserByKeyHash(keyHash).catch(() => null);
    };

    const getVerifiedMatrixUserId = async (toolUser?: User | null): Promise<string | null> => {
      toolUser ??= await getToolUser();
      return toolUser?.linkedAccounts?.find(account =>
        account.platform === 'matrix'
        && !!account.platformUserId
        && account.verified !== false,
      )?.platformUserId || null;
    };

    const executeMatrixSearch = async ({
      query,
      limit,
      since,
      viewerMatrixId,
      roomId,
      botScope,
    }: {
      query?: string;
      limit: number;
      since?: number;
      viewerMatrixId?: string;
      roomId?: string;
      botScope?: boolean;
    }): Promise<MatrixHistoryMessage[]> => {
      const matrix = getPlatform('matrix') as MatrixPlatform | undefined;
      const queryable = matrix as (MatrixPlatform & { queryRecentMessages?: MatrixPlatform['queryRecentMessages'] }) | undefined;
      if (!queryable || typeof queryable.queryRecentMessages !== 'function') return [];

      const defaultSince = roomId && !query
        ? Date.now() - 24 * 60 * 60 * 1000
        : Date.now() - 7 * 24 * 60 * 60 * 1000;

      return queryable.queryRecentMessages({
        query,
        since: since ?? defaultSince,
        limit,
        includeDMs: roomId ? true : !botScope,
        viewerUserId: botScope ? undefined : viewerMatrixId,
        spaceOnly: botScope ? false : true,
        roomIds: roomId ? [roomId] : undefined,
        perRoomLimit: roomId ? Math.max(limit * 2, 80) : undefined,
        botScope,
      });
    };

    const formatMatrixSearchText = (messages: MatrixHistoryMessage[]): string => {
      if (messages.length === 0) return '';

      return messages.map(message => {
        const date = new Date(message.timestamp).toISOString();
        const room = message.isDM ? `DM ${message.roomName}` : (message.roomAlias || message.roomName);
        const sender = message.senderHandle ? `@${message.senderHandle}` : message.senderId;
        const link = message.permalink ? `\n${message.permalink}` : '';
        return `[${date}] ${room} ${sender}: ${message.text}${link}`;
      }).join('\n\n');
    };

    const buildRelatedResults = async ({
      entryText,
      searchKeywords,
      limit = 5,
    }: {
      entryText: string;
      searchKeywords?: string[];
      limit?: number;
    }): Promise<{ queryUsed: string; results: Array<{ id: string; text: string; timestamp: number; followed: boolean }> }> => {
      const normalizedKeywords = Array.from(new Set((searchKeywords || [])
        .map(k => (typeof k === 'string' ? k.trim() : ''))
        .filter(k => k.length > 0 && k.length <= 80)))
        .slice(0, 8);
      const keywordQuery = normalizedKeywords.length > 0 ? normalizedKeywords.join(' ') : undefined;

      const [keywordResults, entryResults] = await Promise.all([
        keywordQuery
          ? executeRouterSearch({ query: keywordQuery, limit })
          : Promise.resolve([]),
        executeRouterSearch({ query: entryText.trim(), limit }),
      ]);

      const results = [...keywordResults, ...entryResults]
        .filter((result, index, arr) => arr.findIndex(r => r.id === result.id) === index)
        .slice(0, limit);

      return {
        queryUsed: keywordQuery || entryText.trim(),
        results,
      };
    };

    if (name === 'router_record_sharing_notice') {
      try {
        const entryId = typeof args?.entry_id === 'string' ? args.entry_id : '';
        const entry = await storage.getEntry(entryId);
        const handle = await getHandle();
        if (!entry || !isEntryAuthor(entry, pseudonym, handle)) throw new SharingNoticeError('Entry not found or not yours.');
        if (!storage.isPending(entryId)) {
          if (!entry.sharingNotice?.evidence || args?.notice_id !== entry.sharingNotice.id || args?.notice_sha256 !== entry.sharingNotice.sha256) throw new SharingNoticeError('Entry is no longer pending.');
        } else storage.recordSharingNotice(entryId, { ...args, evidence_kind: 'agent_reported' });
        const receipt = sharingReceipt(entry, BASE_URL, storage.isPending(entryId));
        return { content: [{ type: 'text' as const, text: `Delivery recorded as agent-reported, not independently verified.\n${formatSharingReceipt(receipt)}` }], structuredContent: { receipt } };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof SharingNoticeError ? err.message : 'Could not record notice delivery.' }], isError: true };
      }
    }

    if (name === 'router_posting_rules') {
      try {
        const user = await storage.getUserByKeyHash(keyHash);
        if (!user && args?.action === 'save') throw new PostingRulesError('Claim a Router handle at /setup before saving personal rules.', 401);
        if (args?.action !== undefined && !['get', 'save'].includes(args.action as string)) throw new PostingRulesError('Use action get or save.');
        const rules = args?.action === 'save' ? await savePersonalRules(user!, args) : user?.postingRules;
        return { content: [{ type: 'text' as const, text: JSON.stringify(postingRulesView(rules)) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: err instanceof PostingRulesError ? err.message : 'Could not load or save your rules. Please retry.' }], isError: true };
      }
    }

    // Handle write tool
    if (name === 'router_write_entry') {
      const entry = (args as { entry?: string })?.entry;
      const client = (args as { client?: 'desktop' | 'mobile' | 'code' })?.client;
      const model = (args as { model?: string })?.model;
      const aiOnlyOverride = (args as { ai_only?: boolean })?.ai_only;
      const humanVisibleOverride = (args as { human_visible?: boolean })?.human_visible; // legacy
      const topicHints = (args as { topic_hints?: string[] })?.topic_hints;
      const rawSearchKeywords = (args as { search_keywords?: string[] })?.search_keywords;
      // Addressing parameters
      let toAddresses = (args as { to?: string[] })?.to;
      const inReplyTo = (args as { in_reply_to?: string })?.in_reply_to;
      const visibilityOverride = (args as { visibility?: 'public' | 'private' | 'ai-only' })?.visibility; // legacy

      if (!entry || entry.trim().length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'Entry cannot be empty.' }],
          isError: true,
        };
      }

      if (!client || !['desktop', 'mobile', 'code'].includes(client)) {
        return {
          content: [{ type: 'text' as const, text: 'Client must be desktop, mobile, or code.' }],
          isError: true,
        };
      }
      const searchKeywords = Array.from(new Set((rawSearchKeywords || [])
        .map(k => (typeof k === 'string' ? k.trim() : ''))
        .filter(k => k.length > 0 && k.length <= 80)))
        .slice(0, 8);

      // Validate inReplyTo if provided
      if (inReplyTo) {
        const parentEntry = await storage.getEntry(inReplyTo);
        if (!parentEntry) {
          return {
            content: [{ type: 'text' as const, text: `Cannot reply to entry ${inReplyTo}: entry not found.` }],
            isError: true,
          };
        }
      }

      // Look up handle fresh (user may have claimed one since connecting)
      const currentUser = await storage.getUserByKeyHash(keyHash);
      const currentHandle = currentUser?.handle || undefined;
      try { toAddresses = await postingAudience(currentUser, args?.posting_intent, toAddresses); }
      catch (err) { return { content: [{ type: 'text' as const, text: (err as Error).message }], isError: true }; }
      const userStagingDelay = currentUser?.stagingDelayMs ?? STAGING_DELAY_MS;

      // Determine aiOnly: explicit ai_only > legacy human_visible > legacy visibility > user default
      let aiOnly: boolean;
      if (aiOnlyOverride !== undefined) {
        aiOnly = aiOnlyOverride;
      } else if (humanVisibleOverride !== undefined) {
        aiOnly = !humanVisibleOverride; // legacy compat
      } else if (visibilityOverride === 'ai-only') {
        aiOnly = true;
      } else {
        aiOnly = currentUser ? isDefaultAiOnly(currentUser) : false;
      }

      // Compute legacy fields for backward compat
      const humanVisible = !aiOnly;
      const visibility = visibilityOverride || getDefaultVisibility(toAddresses, inReplyTo);

      // Auto-detect reflections by content length (500+ chars = essay/reflection)
      const isReflection = entry.trim().length >= 500;

      const saved = await storage.addEntry({
        pseudonym,
        handle: currentHandle,
        client,
        content: entry.trim(),
        timestamp: Date.now(),
        model: model || undefined,
        humanVisible, // legacy compat
        aiOnly: aiOnly || undefined, // only store if true
        isReflection: isReflection || undefined,
        topicHints: topicHints && topicHints.length > 0 ? topicHints : undefined,
        // Addressing fields
        to: toAddresses && toAddresses.length > 0 ? toAddresses : undefined,
        inReplyTo: inReplyTo || undefined,
        visibility: visibility !== 'public' ? visibility : undefined, // legacy compat
      }, userStagingDelay);

      // Non-staged storage has no staging callback; preserve the event for dev/test.
      if (!(storage instanceof StagedStorage)) {
        pushEvent('entry_staged', {
          entry_id: saved.id,
          author_handle: currentHandle || null,
          author_pseudonym: pseudonym,
          publish_at: saved.publishAt,
        });
      }

      // Server-side content moderation via TEE-attested moderator service.
      // The moderation logic runs in a separate TEE (D-Shield/Auditor) with egress
      // attestation proving it only contacts the LLM API and nothing else.
      // Moderation prompt is private — not in this open-source repo.
      const moderatorUrl = process.env.MODERATOR_URL;
      const moderatorKey = process.env.MODERATOR_API_KEY;
      if (moderatorUrl && storage instanceof StagedStorage && !aiOnly && (!toAddresses || toAddresses.length === 0)) {
        try {
          const modHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
          if (moderatorKey) modHeaders['Authorization'] = `Bearer ${moderatorKey}`;
          const modResponse = await fetch(`${moderatorUrl}/invoke/moderate`, {
            method: 'POST',
            headers: modHeaders,
            body: JSON.stringify({ entry: entry.trim().slice(0, 2000) }),
          });

          const modJson = await modResponse.json() as any;
          const modText = modJson.verdict;
          if (modText) {
            const verdict = modText.trim();
            if (verdict.startsWith('BLOCK')) {
              await storage.deleteEntry(saved.id);
              console.log(`[Moderation] ${saved.id} BLOCK`); // the verdict's reason paraphrases the entry: keep it out of logs
              // Don't notify — silently drop spam/injection
            } else if (verdict.startsWith('HOLD')) {
              const reason = verdict.includes(':')
                ? verdict.split(':').slice(1).join(':').trim()
                : 'Flagged by automated review.';
              const FOREVER = Date.now() + (999999 * 365.25 * 24 * 60 * 60 * 1000);
              storage.holdEntry(saved.id, reason, FOREVER, 'automated');
              console.log(`[Moderation] ${saved.id} HOLD`); // reason paraphrases the entry: keep it out of logs

              // Notify author via email
              if (currentUser?.email && currentUser.emailVerified && emailClient) {
                emailClient.send({
                  to: currentUser.email,
                  from: process.env.SENDGRID_FROM_EMAIL || 'notify@router.teleport.computer',
                  subject: 'One of your notebook entries needs a look',
                  html: `
<p>Hey @${currentHandle} —</p>
<p>One of your entries was flagged before it could publish. This isn't a big deal — it just means the automated review wasn't confident it should go out without you checking it first.</p>
<p><strong>Why it was held:</strong> ${reason}</p>
<p>You have two options:</p>
<ul>
  <li><strong>Delete it</strong> if it was a mistake or too personal</li>
  <li><strong>Let us know</strong> if you think it should be published — we'll release it</li>
</ul>
<p>The entry is still saved and hasn't been shared with anyone.</p>
<p style="margin-top: 24px; color: #888; font-size: 13px;">
  <a href="${BASE_URL}">router.teleport.computer</a>
</p>`,
                }).catch(err => console.error('[Moderation] Email failed:', err));
              }
            } else {
              console.log(`[Moderation] ${saved.id} PASS`);
            }
          }
        } catch (modErr) {
          // Fail open — if moderation fails, entry publishes normally
          console.error('[Moderation] Classification failed, entry will publish normally:', (modErr as any)?.message);
        }
      }

      // Mark onboarded on first action
      if (currentUser && !currentUser.onboardedAt) {
        await storage.updateUser(currentUser.handle, { onboardedAt: Date.now() });
      }

      // Moderation may have held or removed the record. Report the actual state.
      const currentEntry = await storage.getEntry(saved.id);
      const receipt = sharingReceipt(currentEntry ?? saved, BASE_URL, storage instanceof StagedStorage && storage.isPending(saved.id), !currentEntry);
      let responseText = formatSharingReceipt(receipt);

      if (inReplyTo) {
        responseText += `\n\nIn reply to: ${inReplyTo}`;
      }

      if (visibility !== 'public') {
        responseText += `\n\nVisibility: ${visibility}`;
      }

      const { queryUsed, results: relatedResults } = await buildRelatedResults({
        entryText: entry.trim(),
        searchKeywords: searchKeywords,
        limit: 5,
      });

      responseText += `\n\nRelated results:\n${formatRouterSearchText({
        query: queryUsed,
        results: relatedResults,
      })}`;

      return {
        structuredContent: { receipt },
        content: [{
          type: 'text' as const,
          text: responseText,
        }],
      };
    }

    // Handle delete entry tool
    if (name === 'router_delete_entry') {
      const entryId = (args as { entry_id?: string })?.entry_id;

      if (!entryId) {
        return {
          content: [{ type: 'text' as const, text: 'Entry ID is required.' }],
          isError: true,
        };
      }

      // Get the entry to verify ownership
      const entry = await storage.getEntry(entryId);

      if (!entry) {
        return {
          content: [{ type: 'text' as const, text: `Entry not found: ${entryId}. It may have already been deleted.` }],
          isError: true,
        };
      }

      // Verify the entry belongs to this pseudonym
      if (entry.pseudonym !== pseudonym) {
        return {
          content: [{ type: 'text' as const, text: 'You can only delete your own entries.' }],
          isError: true,
        };
      }

      // Check if entry is pending (for appropriate message)
      const wasPending = 'isPending' in storage && (storage as any).isPending(entryId);

      await storage.deleteEntry(entryId);

      const message = wasPending
        ? `Deleted entry ${entryId}. It will not be published.`
        : `Deleted entry ${entryId}. It has been removed from the public journal.`;

      return {
        content: [{
          type: 'text' as const,
          text: message,
        }],
      };
    }

    // Handle get entry details tool
    if (name === 'router_get_entry') {
      const entryId = (args as { entry_id?: string })?.entry_id;

      if (!entryId) {
        return {
          content: [{ type: 'text' as const, text: 'Entry ID is required.' }],
          isError: true,
        };
      }

      // Try to find as an entry first
      const rawEntry = await storage.getEntry(entryId);
      if (rawEntry) {
        const entry = normalizeEntry(rawEntry);
        // Check access control
        const currentUser = await storage.getUserByKeyHash(keyHash);
        const viewerHandle = currentUser?.handle;
        const viewerEmail = currentUser?.email;
        const isAuthor = isEntryAuthor(entry, pseudonym, viewerHandle);
        const allowed = !isHiddenWhilePending(entryId, isAuthor)
          && await canView(entry, viewerHandle, viewerEmail, isAuthor, storage, new Map<string, boolean>());
        if (!allowed) {
          return {
            content: [{ type: 'text' as const, text: `Entry not found: ${entryId}` }],
            isError: true,
          };
        }

        const date = new Date(entry.timestamp).toISOString().split('T')[0];
        const type = entry.isReflection ? 'reflection' : 'note';
        const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

        return {
          content: [{
            type: 'text' as const,
            text: `[${date}] ${author} posted a ${type}:\n\n${entry.content}`,
          }],
          ...(isAuthor ? { structuredContent: { receipt: sharingReceipt(entry, BASE_URL, storage.isPending(entry.id)) } } : {}),
        };
      }

      // Try to find as a conversation
      const conversation = await storage.getConversation(entryId);
      const conversationHidden = conversation
        && conversation.pseudonym !== pseudonym
        && storage instanceof StagedStorage
        && storage.isConversationPending(entryId);
      if (conversation && !conversationHidden) {
        const date = new Date(conversation.timestamp).toISOString().split('T')[0];
        return {
          content: [{
            type: 'text' as const,
            text: `[${date}] ${conversation.pseudonym} posted a conversation with ${formatPlatformName(conversation.platform)}:\n\nTitle: ${conversation.title}\n\nSummary: ${conversation.summary}\n\nFull conversation:\n${conversation.content}`,
          }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Entry not found: ${entryId}` }],
        isError: true,
      };
    }

    // Handle search tool
    if (name === 'router_search') {
      const query = (args as { query?: string })?.query?.trim();
      const groupArg = (args as { group_id?: unknown })?.group_id;
      if (groupArg !== undefined && (typeof groupArg !== 'string' || !isValidChannelId(groupArg.replace(/^#/, '')))) {
        return { content: [{ type: 'text' as const, text: 'Choose a valid group_id. No other audiences were searched.' }], isError: true };
      }
      const groupId = typeof groupArg === 'string' ? groupArg.replace(/^#/, '') : undefined;
      const handleFilter = (args as { handle?: string })?.handle?.replace(/^@/, '').toLowerCase();
      const requestedLimit = (args as { limit?: number })?.limit;
      const limit = typeof requestedLimit === 'number' && Number.isFinite(requestedLimit) ? Math.max(1, Math.min(50, Math.floor(requestedLimit))) : 10;
      const sinceRaw = (args as { since?: string })?.since?.trim();
      const since = parseToolSince(sinceRaw);
      const roomId = (args as { room_id?: string })?.room_id?.trim();
      const includeMatrix = !groupId && (args as { include_matrix?: boolean })?.include_matrix !== false;

      if (!query && !handleFilter && !since && !roomId && !groupId) {
        return {
          content: [{ type: 'text' as const, text: 'Provide a search query, a handle to filter by, a since parameter, or a Matrix room_id.' }],
          isError: true,
        };
      }

      let results: Awaited<ReturnType<typeof executeRouterSearch>>;
      try { results = await executeRouterSearch({ query, handleFilter, limit, since, groupId }); }
      catch (err) {
        if (err instanceof PostingRulesError || err instanceof GroupStoreRevokedError) {
          return { content: [{ type: 'text' as const, text: err.message }], isError: true };
        }
        throw err;
      }

      let matrixMessages: MatrixHistoryMessage[] = [];
      let matrixAccessLabel = 'Matrix results visible to your linked account';
      if (includeMatrix && (query || roomId || since)) {
        const toolUser = await getToolUser();
        const viewerMatrixId = await getVerifiedMatrixUserId(toolUser);
        const canUseRouterMatrix = canUseMatrixBotScopeSearch(toolUser);

        if (viewerMatrixId || canUseRouterMatrix) {
          matrixMessages = await executeMatrixSearch({
            query,
            limit,
            since,
            viewerMatrixId: canUseRouterMatrix ? undefined : (viewerMatrixId || undefined),
            roomId,
            botScope: canUseRouterMatrix,
          }).catch(() => []);
          matrixAccessLabel = roomId
            ? 'Recent Matrix messages from the requested room'
            : (canUseRouterMatrix ? 'Matrix results from non-DM rooms Router/Hermes has joined' : 'Matrix results visible to your linked account');
        }
      }

      const shouldShowNotebookResults = !!groupId || !!query || !!handleFilter || !!since || results.length > 0;
      const notebookText = shouldShowNotebookResults
        ? formatRouterSearchText({ query, handleFilter, results })
        : '';
      const matrixText = formatMatrixSearchText(matrixMessages);
      const responseParts: string[] = [];
      if (notebookText) responseParts.push(notebookText);
      if (matrixText) responseParts.push(`${matrixAccessLabel}:\n\n${matrixText}`);
      if (roomId && includeMatrix && !matrixText && !notebookText) {
        responseParts.push('No recent Matrix messages were available for the requested room.');
      }

      return {
        content: [{
          type: 'text' as const,
          text: (groupId ? `Audience: #${groupId} only. Reading the latest 500 group notes.\n\n` : '') + (responseParts.join('\n\n') || 'No results found.'),
        }],
      };
    }

    // Handle Matrix search tool
    if (name === 'router_search_matrix') {
      const query = (args as { query?: string })?.query?.trim();
      const limit = (args as { limit?: number })?.limit || 10;
      const sinceRaw = (args as { since?: string })?.since?.trim();
      const since = parseToolSince(sinceRaw);
      const roomId = (args as { room_id?: string })?.room_id?.trim();

      if (!query && !since && !roomId) {
        return {
          content: [{ type: 'text' as const, text: 'Provide a Matrix search query, a since parameter, or a Matrix room_id.' }],
          isError: true,
        };
      }

      const toolUser = await getToolUser();
      const viewerMatrixId = await getVerifiedMatrixUserId(toolUser);
      const canUseRouterMatrix = canUseMatrixBotScopeSearch(toolUser);

      if (!viewerMatrixId && !canUseRouterMatrix) {
        return {
          content: [{ type: 'text' as const, text: 'Matrix search is unavailable: the caller has no verified linked Matrix account.' }],
          isError: true,
        };
      }

      const matrixMessages = await executeMatrixSearch({
        query,
        limit,
        since,
        viewerMatrixId: canUseRouterMatrix ? undefined : (viewerMatrixId || undefined),
        roomId,
        botScope: canUseRouterMatrix,
      }).catch(() => []);
      const matrixText = formatMatrixSearchText(matrixMessages);
      const matrixAccessLabel = roomId
        ? 'Recent Matrix messages from the requested room'
        : (canUseRouterMatrix ? 'Matrix results from non-DM rooms Router/Hermes has joined' : 'Matrix results visible to your linked account');

      return {
        content: [{
          type: 'text' as const,
          text: matrixText
            ? `${matrixAccessLabel}:\n\n${matrixText}`
            : (roomId ? 'No recent Matrix messages were available for the requested room.' : 'No matching Matrix messages found.'),
        }],
      };
    }

    // Handle manage_settings tool
    if (name === 'router_settings') {
      const action = (args as { action?: string })?.action;

      if (!action || !['get', 'update'].includes(action)) {
        return {
          content: [{ type: 'text' as const, text: 'Action must be "get" or "update".' }],
          isError: true,
        };
      }

      const settingsUser = await storage.getUserByKeyHash(keyHash);
      if (!settingsUser) {
        return {
          content: [{ type: 'text' as const, text: 'No account found. Claim a handle first to manage settings.' }],
          isError: true,
        };
      }

      if (action === 'get') {
        const emailStatus = settingsUser.email
          ? (settingsUser.emailVerified ? '(verified)' : '(unverified)')
          : '(not set)';
        const prefs = settingsUser.emailPrefs || { comments: true, digest: true };

        return {
          content: [{
            type: 'text' as const,
            text: `Current settings for @${settingsUser.handle}:\n\n` +
              `• displayName: ${settingsUser.displayName || '(not set)'}\n` +
              `• bio: ${settingsUser.bio || '(not set)'}\n` +
              `• email: ${settingsUser.email || '(not set)'} ${emailStatus}\n` +
              `• emailPrefs: comments=${prefs.comments}, digest=${prefs.digest}\n` +
              `• defaultAiOnly: ${isDefaultAiOnly(settingsUser)}\n` +
              `• stagingDelayMs: ${settingsUser.stagingDelayMs ?? STAGING_DELAY_MS} (${Math.round((settingsUser.stagingDelayMs ?? STAGING_DELAY_MS) / 1000 / 60)} minutes)`,
          }],
        };
      }

      // action === 'update'
      const newAiOnly = (args as { defaultAiOnly?: boolean })?.defaultAiOnly;
      const newHumanVisible = (args as { defaultHumanVisible?: boolean })?.defaultHumanVisible; // legacy
      const newStagingDelay = (args as { stagingDelayMs?: number })?.stagingDelayMs;
      const newDisplayName = (args as { displayName?: string })?.displayName;
      const newBio = (args as { bio?: string })?.bio;
      const newEmail = (args as { email?: string })?.email;
      const newEmailPrefs = (args as { emailPrefs?: { comments?: boolean; digest?: boolean } })?.emailPrefs;

      // Validate staging delay if provided
      if (newStagingDelay !== undefined) {
        const oneHour = 60 * 60 * 1000;
        const oneMonth = 30 * 24 * 60 * 60 * 1000;
        if (newStagingDelay < oneHour || newStagingDelay > oneMonth) {
          return {
            content: [{ type: 'text' as const, text: 'stagingDelayMs must be between 1 hour and 1 month.' }],
            isError: true,
          };
        }
      }

      // Validate email format if provided
      if (newEmail !== undefined && newEmail !== '' && (!newEmail.includes('@') || newEmail.length < 5)) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid email address format.' }],
          isError: true,
        };
      }

      const updates: Partial<{ defaultAiOnly: boolean; defaultHumanVisible: boolean; stagingDelayMs: number; displayName: string; bio: string; email: string; emailPrefs: { comments: boolean; digest: boolean } }> = {};
      if (newAiOnly !== undefined) {
        updates.defaultAiOnly = newAiOnly;
        updates.defaultHumanVisible = !newAiOnly; // backward compat
      } else if (newHumanVisible !== undefined) {
        updates.defaultHumanVisible = newHumanVisible;
        updates.defaultAiOnly = !newHumanVisible; // forward compat
      }
      if (newStagingDelay !== undefined) updates.stagingDelayMs = newStagingDelay;
      if (newDisplayName !== undefined) updates.displayName = newDisplayName;
      if (newBio !== undefined) updates.bio = newBio;
      if (newEmail !== undefined) {
        updates.email = newEmail;
        // Note: email verification would be handled separately via the /api/send-verification endpoint
      }
      if (newEmailPrefs !== undefined) {
        const currentPrefs = settingsUser.emailPrefs || { comments: true, digest: true };
        updates.emailPrefs = {
          comments: newEmailPrefs.comments ?? currentPrefs.comments,
          digest: newEmailPrefs.digest ?? currentPrefs.digest,
        };
      }

      if (Object.keys(updates).length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No settings provided to update.' }],
          isError: true,
        };
      }

      await storage.updateUser(settingsUser.handle, updates);

      const changedParts = [];
      if (newAiOnly !== undefined) changedParts.push(`defaultAiOnly → ${newAiOnly}`);
      else if (newHumanVisible !== undefined) changedParts.push(`defaultAiOnly → ${!newHumanVisible}`);
      if (newStagingDelay !== undefined) changedParts.push(`stagingDelayMs → ${newStagingDelay}`);
      if (newDisplayName !== undefined) changedParts.push(`displayName → "${newDisplayName}"`);
      if (newBio !== undefined) changedParts.push(`bio → "${newBio.slice(0, 50)}${newBio.length > 50 ? '...' : ''}"`);
      if (newEmail !== undefined) changedParts.push(`email → ${newEmail || '(cleared)'} (verification email will be sent if new)`);
      if (newEmailPrefs !== undefined) changedParts.push(`emailPrefs → comments=${updates.emailPrefs?.comments}, digest=${updates.emailPrefs?.digest}`);

      return {
        content: [{
          type: 'text' as const,
          text: `Updated settings for @${settingsUser.handle}:\n\n${changedParts.map(p => `• ${p}`).join('\n')}`,
        }],
      };
    }

    // Handle router_skills tool (system tool overrides + user skill CRUD)
    if (name === 'router_skills') {
      try {
      const action = (args as { action?: string })?.action;
      const validActions = ['list', 'edit', 'reset', 'create', 'get', 'update', 'delete'];

      if (!action || !validActions.includes(action)) {
        return {
          content: [{ type: 'text' as const, text: `Action must be one of: ${validActions.join(', ')}.` }],
          isError: true,
        };
      }

      const skillsUser = await storage.getUserByKeyHash(keyHash);
      if (!skillsUser) {
        return {
          content: [{ type: 'text' as const, text: 'No account found. Claim a handle first.' }],
          isError: true,
        };
      }

      const skillOverrides = skillsUser.skillOverrides || {};
      const userSkills = skillsUser.skills || [];

      if (action === 'list') {
        const systemSkillsList = SYSTEM_SKILLS
          .filter(s => s.handlerType === 'builtin')
          .map(s => {
            const hasOverride = skillOverrides[s.name];
            const status = hasOverride ? ' [CUSTOMIZED]' : '';
            let line = `• ${s.name}${status}: ${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}`;
            if (hasOverride?.instructions) {
              line += `\n  Custom instructions: ${(hasOverride.instructions as string).slice(0, 60)}...`;
            }
            return line;
          })
          .join('\n');

        let userSkillsList = '';
        if (userSkills.length > 0) {
          userSkillsList = '\n\nUser Skills:\n' + userSkills.map(s => {
            const parts = [`• skill_${s.name}: ${s.description.slice(0, 80)}${s.description.length > 80 ? '...' : ''}`];
            if (s.to && s.to.length > 0) parts.push(`  Destinations: ${s.to.join(', ')}`);
            if (s.triggerCondition) parts.push(`  Trigger: ${s.triggerCondition}`);
            if (s.public) parts.push(`  [PUBLIC] clones: ${s.cloneCount || 0}`);
            return parts.join('\n');
          }).join('\n');
        }

        return {
          content: [{
            type: 'text' as const,
            text: `System Tools:\n${systemSkillsList}${userSkillsList}\n\n` +
              `Actions:\n` +
              `• "edit" with tool_name + description/instructions: customize a system tool's behavior\n` +
              `• "reset" with tool_name: restore system tool to defaults\n` +
              `• "create" with name + description + instructions: create a new user skill\n` +
              `• "get" with skill_id: view skill details\n` +
              `• "update" with skill_id + fields: update a user skill\n` +
              `• "delete" with skill_id: remove a user skill`,
          }],
        };
      }

      if (action === 'edit') {
        const toolName = (args as { tool_name?: string })?.tool_name;
        const description = (args as { description?: string })?.description;
        const instructions = (args as { instructions?: string })?.instructions;

        if (!toolName) {
          return {
            content: [{ type: 'text' as const, text: 'tool_name is required for edit action.' }],
            isError: true,
          };
        }

        // Verify it's a valid system skill
        const systemSkill = SYSTEM_SKILLS.find(s => s.name === toolName && s.handlerType === 'builtin');
        if (!systemSkill) {
          const validNames = SYSTEM_SKILLS.filter(s => s.handlerType === 'builtin').map(s => s.name).join(', ');
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: "${toolName}". Valid options: ${validNames}` }],
            isError: true,
          };
        }

        if (!description && !instructions) {
          return {
            content: [{ type: 'text' as const, text: 'Provide at least description or instructions to customize.' }],
            isError: true,
          };
        }

        const updatedOverrides = { ...skillOverrides };
        updatedOverrides[toolName] = {
          ...(updatedOverrides[toolName] || {}),
          ...(description && { description }),
          ...(instructions && { instructions }),
        };

        await storage.updateUser(skillsUser.handle, { skillOverrides: updatedOverrides });

        return {
          content: [{
            type: 'text' as const,
            text: `Customized "${toolName}"!\n\n` +
              (description ? `New description: ${description.slice(0, 100)}...\n` : '') +
              (instructions ? `Added instructions: ${instructions.slice(0, 100)}...\n` : '') +
              `\nChanges take effect on next connection.`,
          }],
        };
      }

      if (action === 'reset') {
        const toolName = (args as { tool_name?: string })?.tool_name;

        if (!toolName) {
          return {
            content: [{ type: 'text' as const, text: 'tool_name is required for reset action.' }],
            isError: true,
          };
        }

        const systemSkill = SYSTEM_SKILLS.find(s => s.name === toolName && s.handlerType === 'builtin');
        if (!systemSkill) {
          const validNames = SYSTEM_SKILLS.filter(s => s.handlerType === 'builtin').map(s => s.name).join(', ');
          return {
            content: [{ type: 'text' as const, text: `Unknown tool: "${toolName}". Valid options: ${validNames}` }],
            isError: true,
          };
        }

        if (!skillOverrides[toolName]) {
          return {
            content: [{ type: 'text' as const, text: `"${toolName}" has no customizations to reset.` }],
          };
        }

        const updatedOverrides = { ...skillOverrides };
        delete updatedOverrides[toolName];

        await storage.updateUser(skillsUser.handle, { skillOverrides: updatedOverrides });

        return {
          content: [{
            type: 'text' as const,
            text: `Reset "${toolName}" to defaults. Changes take effect on next connection.`,
          }],
        };
      }

      if (action === 'create') {
        const skillName = (args as { name?: string })?.name;
        const description = (args as { description?: string })?.description;
        const instructions = (args as { instructions?: string })?.instructions;
        const parameters = (args as { parameters?: SkillParameter[] })?.parameters;
        const triggerCondition = (args as { trigger_condition?: string })?.trigger_condition;
        const toDestinations = (args as { to?: string[] })?.to;
        const skillAiOnly = (args as { ai_only?: boolean })?.ai_only;
        const visibility = (args as { visibility?: 'public' | 'private' | 'ai-only' })?.visibility; // legacy
        const isPublic = (args as { is_public?: boolean })?.is_public;

        if (!skillName) {
          return {
            content: [{ type: 'text' as const, text: 'name is required for create action.' }],
            isError: true,
          };
        }

        const nameError = validateSkillName(skillName);
        if (nameError) {
          return {
            content: [{ type: 'text' as const, text: nameError }],
            isError: true,
          };
        }

        if (!description) {
          return {
            content: [{ type: 'text' as const, text: 'description is required for create action.' }],
            isError: true,
          };
        }

        if (userSkills.length >= MAX_SKILLS_PER_USER) {
          return {
            content: [{ type: 'text' as const, text: `Maximum ${MAX_SKILLS_PER_USER} skills allowed. Delete an existing skill first.` }],
            isError: true,
          };
        }

        if (userSkills.some(s => s.name === skillName)) {
          return {
            content: [{ type: 'text' as const, text: `A skill named "${skillName}" already exists. Choose a different name or delete it first.` }],
            isError: true,
          };
        }

        if (instructions && instructions.length > MAX_SKILL_INSTRUCTIONS) {
          return {
            content: [{ type: 'text' as const, text: `Instructions too long (${instructions.length} chars). Maximum is ${MAX_SKILL_INSTRUCTIONS}.` }],
            isError: true,
          };
        }

        if (parameters && parameters.length > MAX_SKILL_PARAMETERS) {
          return {
            content: [{ type: 'text' as const, text: `Too many parameters (${parameters.length}). Maximum is ${MAX_SKILL_PARAMETERS}.` }],
            isError: true,
          };
        }

        if (toDestinations && toDestinations.length > MAX_SKILL_DESTINATIONS) {
          return {
            content: [{ type: 'text' as const, text: `Too many destinations (${toDestinations.length}). Maximum is ${MAX_SKILL_DESTINATIONS}.` }],
            isError: true,
          };
        }

        // Resolve aiOnly: prefer ai_only param, fall back to legacy visibility
        const resolvedSkillAiOnly = skillAiOnly !== undefined ? skillAiOnly : (visibility === 'ai-only' ? true : undefined);

        const newSkill: Skill = {
          id: generateSkillId(),
          name: skillName,
          description,
          instructions: instructions || '',
          handlerType: 'instructions',
          ...(parameters && { parameters }),
          ...(triggerCondition && { triggerCondition }),
          ...(toDestinations && { to: toDestinations }),
          ...(resolvedSkillAiOnly !== undefined && { aiOnly: resolvedSkillAiOnly }),
          ...(visibility && { visibility }), // backward compat
          public: isPublic || false,
          author: skillsUser.handle,
          cloneCount: 0,
          createdAt: Date.now(),
        };

        const updatedSkills = [...userSkills, newSkill];
        await storage.updateUser(skillsUser.handle, { skills: updatedSkills });

        server.sendToolListChanged().catch(() => {});

        return {
          content: [{
            type: 'text' as const,
            text: `Created skill "${skillName}" (ID: ${newSkill.id}).\n\n` +
              `Tool name: skill_${skillName}\n` +
              `Description: ${description}\n` +
              (instructions ? `Instructions: ${instructions.slice(0, 100)}${instructions.length > 100 ? '...' : ''}\n` : '') +
              (toDestinations ? `Destinations: ${toDestinations.join(', ')}\n` : '') +
              (triggerCondition ? `Trigger: ${triggerCondition}\n` : '') +
              (isPublic ? `Visibility: PUBLIC (in gallery)\n` : '') +
              `\nThe skill_${skillName} tool is now available.`,
          }],
        };
      }

      if (action === 'get') {
        const skillId = (args as { skill_id?: string })?.skill_id;

        if (!skillId) {
          return {
            content: [{ type: 'text' as const, text: 'skill_id is required for get action.' }],
            isError: true,
          };
        }

        const skill = userSkills.find(s => s.id === skillId || s.name === skillId);
        if (!skill) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${skillId}" not found.` }],
            isError: true,
          };
        }

        const details = [
          `Name: ${skill.name}`,
          `ID: ${skill.id}`,
          `Description: ${skill.description}`,
          `Instructions: ${skill.instructions || '(none)'}`,
          `Parameters: ${skill.parameters ? skill.parameters.map(p => `${p.name} (${p.type}): ${p.description}`).join(', ') : '(none)'}`,
          `Trigger: ${skill.triggerCondition || '(none)'}`,
          `Destinations: ${skill.to ? skill.to.join(', ') : '(none)'}`,
          `Visibility: ${skill.visibility || 'public'}`,
          `Public gallery: ${skill.public || false}`,
          `Cloned from: ${skill.clonedFrom || '(original)'}`,
          `Clone count: ${skill.cloneCount || 0}`,
          `Created: ${new Date(skill.createdAt).toISOString()}`,
        ];

        return {
          content: [{ type: 'text' as const, text: details.join('\n') }],
        };
      }

      if (action === 'update') {
        const skillId = (args as { skill_id?: string })?.skill_id;

        if (!skillId) {
          return {
            content: [{ type: 'text' as const, text: 'skill_id is required for update action.' }],
            isError: true,
          };
        }

        const skillIndex = userSkills.findIndex(s => s.id === skillId || s.name === skillId);
        if (skillIndex === -1) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${skillId}" not found.` }],
            isError: true,
          };
        }

        const description = (args as { description?: string })?.description;
        const instructions = (args as { instructions?: string })?.instructions;
        const parameters = (args as { parameters?: SkillParameter[] })?.parameters;
        const triggerCondition = (args as { trigger_condition?: string })?.trigger_condition;
        const toDestinations = (args as { to?: string[] })?.to;
        const updateAiOnly = (args as { ai_only?: boolean })?.ai_only;
        const visibility = (args as { visibility?: 'public' | 'private' | 'ai-only' })?.visibility; // legacy
        const isPublic = (args as { is_public?: boolean })?.is_public;

        if (instructions && instructions.length > MAX_SKILL_INSTRUCTIONS) {
          return {
            content: [{ type: 'text' as const, text: `Instructions too long (${instructions.length} chars). Maximum is ${MAX_SKILL_INSTRUCTIONS}.` }],
            isError: true,
          };
        }

        if (parameters && parameters.length > MAX_SKILL_PARAMETERS) {
          return {
            content: [{ type: 'text' as const, text: `Too many parameters (${parameters.length}). Maximum is ${MAX_SKILL_PARAMETERS}.` }],
            isError: true,
          };
        }

        if (toDestinations && toDestinations.length > MAX_SKILL_DESTINATIONS) {
          return {
            content: [{ type: 'text' as const, text: `Too many destinations (${toDestinations.length}). Maximum is ${MAX_SKILL_DESTINATIONS}.` }],
            isError: true,
          };
        }

        const existing = userSkills[skillIndex];
        const updated: Skill = {
          ...existing,
          ...(description !== undefined && { description }),
          ...(instructions !== undefined && { instructions }),
          ...(parameters !== undefined && { parameters }),
          ...(triggerCondition !== undefined && { triggerCondition }),
          ...(toDestinations !== undefined && { to: toDestinations }),
          ...(updateAiOnly !== undefined && { aiOnly: updateAiOnly }),
          ...(visibility !== undefined && { visibility }), // backward compat
          ...(isPublic !== undefined && { public: isPublic }),
          updatedAt: Date.now(),
        };

        const updatedSkills = [...userSkills];
        updatedSkills[skillIndex] = updated;
        await storage.updateUser(skillsUser.handle, { skills: updatedSkills });

        return {
          content: [{
            type: 'text' as const,
            text: `Updated skill "${existing.name}". Changes take effect on next connection.`,
          }],
        };
      }

      if (action === 'delete') {
        const skillId = (args as { skill_id?: string })?.skill_id;

        if (!skillId) {
          return {
            content: [{ type: 'text' as const, text: 'skill_id is required for delete action.' }],
            isError: true,
          };
        }

        const skillIndex = userSkills.findIndex(s => s.id === skillId || s.name === skillId);
        if (skillIndex === -1) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${skillId}" not found.` }],
            isError: true,
          };
        }

        const deletedName = userSkills[skillIndex].name;
        const updatedSkills = userSkills.filter((_, i) => i !== skillIndex);
        await storage.updateUser(skillsUser.handle, { skills: updatedSkills });

        server.sendToolListChanged().catch(() => {});

        return {
          content: [{
            type: 'text' as const,
            text: `Deleted skill "${deletedName}". The skill_${deletedName} tool has been removed.`,
          }],
        };
      }
      } catch (error: any) {
        console.error('router_skills error:', error);
        return {
          content: [{ type: 'text' as const, text: `Failed to manage tools: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // Handle follow tool
    if (name === 'router_follow') {
      const action = (args as { action?: string })?.action;
      const targetHandle = (args as { handle?: string })?.handle?.replace(/^@/, '').toLowerCase();
      const note = (args as { note?: string })?.note;

      if (!action || !['follow', 'unfollow', 'list', 'update_note'].includes(action)) {
        return {
          content: [{ type: 'text' as const, text: 'Action must be one of: follow, unfollow, list, update_note.' }],
          isError: true,
        };
      }

      const currentUser = await storage.getUserByKeyHash(keyHash);
      if (!currentUser?.handle) {
        return {
          content: [{ type: 'text' as const, text: 'You need a handle to use following. Claim one in settings.' }],
          isError: true,
        };
      }

      const following = currentUser.following || [];

      if (action === 'list') {
        if (following.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'You are not following anyone yet. Use action: "follow" with a handle to start.' }],
          };
        }

        const roster = following.map(f => `• @${f.handle} — ${f.note}`).join('\n');
        return {
          content: [{ type: 'text' as const, text: `Following ${following.length} users:\n\n${roster}` }],
        };
      }

      if (!targetHandle) {
        return {
          content: [{ type: 'text' as const, text: 'Handle is required for follow/unfollow/update_note.' }],
          isError: true,
        };
      }

      if (targetHandle === currentUser.handle) {
        return {
          content: [{ type: 'text' as const, text: 'You cannot follow yourself.' }],
          isError: true,
        };
      }

      if (action === 'follow') {
        // Check if already following
        if (following.some(f => f.handle === targetHandle)) {
          return {
            content: [{ type: 'text' as const, text: `Already following @${targetHandle}. Use action: "update_note" to change the note.` }],
          };
        }

        // Validate handle exists
        const targetUser = await storage.getUser(targetHandle);
        if (!targetUser) {
          return {
            content: [{ type: 'text' as const, text: `User @${targetHandle} not found.` }],
            isError: true,
          };
        }

        // Auto-generate note if not provided
        let followNote = note || '';
        if (!followNote) {
          const parts: string[] = [];
          if (targetUser.bio) parts.push(targetUser.bio);

          // Get recent entries for context
          const recentEntries = (await storage.getEntriesByHandle(targetHandle, 5)).filter(isPublicNotebookEntry);
          if (recentEntries.length > 0) {
            const topics = recentEntries
              .map(e => e.content.slice(0, 80))
              .join('; ');
            parts.push(`Recent: ${topics}`);
          }

          followNote = parts.length > 0 ? parts.join('. ') : `Followed on ${new Date().toISOString().split('T')[0]}`;
        }

        const updatedFollowing = [...following, { handle: targetHandle, note: followNote }];
        const followUpdates: Record<string, any> = { following: updatedFollowing };
        if (!currentUser.onboardedAt) followUpdates.onboardedAt = Date.now();
        await storage.updateUser(currentUser.handle, followUpdates);

        // Send follow notification email to the target user
        try {
          await notificationService.notifyNewFollower?.(currentUser, targetUser);
        } catch (err) {
          console.error(`[Follow] Failed to send notification:`, err);
        }

        return {
          content: [{ type: 'text' as const, text: `Now following @${targetHandle} — ${followNote}` }],
        };
      }

      if (action === 'unfollow') {
        if (!following.some(f => f.handle === targetHandle)) {
          return {
            content: [{ type: 'text' as const, text: `Not following @${targetHandle}.` }],
          };
        }

        const updatedFollowing = following.filter(f => f.handle !== targetHandle);
        await storage.updateUser(currentUser.handle, { following: updatedFollowing });

        return {
          content: [{ type: 'text' as const, text: `Unfollowed @${targetHandle}.` }],
        };
      }

      if (action === 'update_note') {
        if (!note) {
          return {
            content: [{ type: 'text' as const, text: 'Note is required for update_note action.' }],
            isError: true,
          };
        }

        const existingFollow = following.find(f => f.handle === targetHandle);
        if (!existingFollow) {
          return {
            content: [{ type: 'text' as const, text: `Not following @${targetHandle}. Follow them first.` }],
            isError: true,
          };
        }

        const updatedFollowing = following.map(f =>
          f.handle === targetHandle ? { ...f, note } : f
        );
        await storage.updateUser(currentUser.handle, { following: updatedFollowing });

        return {
          content: [{ type: 'text' as const, text: `Updated note for @${targetHandle}: ${note}` }],
        };
      }
    }

    // Handle router_channels tool
    if (name === 'router_channels') {
      const action = (args as { action?: string })?.action;
      const channelId = (args as { channel_id?: string })?.channel_id?.toLowerCase();
      const channelName = (args as { name?: string })?.name;
      const channelDescription = (args as { description?: string })?.description;
      const channelJoinRule = (args as { join_rule?: 'open' | 'invite' })?.join_rule;
      const channelVisibility = (args as { visibility?: 'public' | 'private' })?.visibility; // legacy
      const inviteToken = (args as { invite_token?: string })?.invite_token;
      const targetHandle = (args as { handle?: string })?.handle?.toLowerCase();
      const skillName = (args as { skill_name?: string })?.skill_name?.toLowerCase();
      const skillInstructions = (args as { instructions?: string })?.instructions;

      if (!action || !['list', 'join', 'leave', 'create', 'info', 'invite', 'invite_user', 'add_skill', 'update_skill', 'remove_skill'].includes(action)) {
        return {
          content: [{ type: 'text' as const, text: 'Action must be one of: list, join, leave, create, info, invite, invite_user, add_skill, update_skill, remove_skill.' }],
          isError: true,
        };
      }

      const currentUser = await storage.getUserByKeyHash(keyHash);
      if (!currentUser?.handle) {
        return {
          content: [{ type: 'text' as const, text: 'You need a handle to use channels. Claim one in settings.' }],
          isError: true,
        };
      }

      if (action === 'list') {
        const [subscribed, publicChannels] = await Promise.all([
          storage.getSubscribedChannels(currentUser.handle),
          storage.listChannels({ joinRule: 'open' }),
        ]);

        const subscribedIds = new Set(subscribed.map(c => c.id));
        const discoverable = publicChannels.filter(c => !subscribedIds.has(c.id));

        let text = '';
        if (subscribed.length > 0) {
          text += `Your channels:\n${subscribed.map(c => `• #${c.id} — ${c.name}${c.description ? ': ' + c.description : ''} (${c.subscribers.length} members, ${c.skills.length} skills)`).join('\n')}`;
        } else {
          text += 'You are not subscribed to any channels yet.';
        }

        if (discoverable.length > 0) {
          text += `\n\nDiscoverable public channels:\n${discoverable.map(c => `• #${c.id} — ${c.name}${c.description ? ': ' + c.description : ''} (${c.subscribers.length} members)`).join('\n')}`;
        }

        return { content: [{ type: 'text' as const, text }] };
      }

      if (action === 'create') {
        if (!channelId) {
          return {
            content: [{ type: 'text' as const, text: 'channel_id is required for create. Use lowercase alphanumeric + hyphens (e.g. "my-channel").' }],
            isError: true,
          };
        }
        if (!isValidChannelId(channelId)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid channel ID. Must be 2-30 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphens, no underscores.' }],
            isError: true,
          };
        }
        if (!channelName) {
          return {
            content: [{ type: 'text' as const, text: 'name is required for create.' }],
            isError: true,
          };
        }

        try {
          // Resolve joinRule: prefer join_rule param, fall back to legacy visibility, default 'open'
          const resolvedJoinRule = channelJoinRule || (channelVisibility === 'private' ? 'invite' : 'open');
          const resolvedVisibility = channelVisibility || (resolvedJoinRule === 'invite' ? 'private' : 'public');

          const channel = await storage.createChannel({
            id: channelId,
            name: channelName,
            description: channelDescription,
            visibility: resolvedVisibility, // backward compat
            joinRule: resolvedJoinRule,
            createdBy: currentUser.handle,
            createdAt: Date.now(),
            skills: [],
            subscribers: [{ handle: currentUser.handle, role: 'admin', joinedAt: Date.now() }],
          });

          // Mark onboarded on first action
          if (!currentUser.onboardedAt) {
            await storage.updateUser(currentUser.handle, { onboardedAt: Date.now() });
          }

          return {
            content: [{ type: 'text' as const, text: `Created group #${channel.id} (${channel.joinRule || 'open'}). You are the admin. ${channel.joinRule === 'invite' ? 'Only members can read its notes.' : 'This group is public: anyone can read its notes on the web without joining.'}\n\nStart with what this group wants to explore together. Help the person choose their own posting rules at ${BASE_URL}/posting-rules?group=${encodeURIComponent(channel.id)}; joining a group does not change them. ${channel.joinRule === 'invite' ? 'Useful group notes can be automatic, while public sharing waits for their approval or explicit request.' : 'Offer drafts first, with approval or an explicit request before each public group post.'} Preserve existing choices. Begin with a useful question or reference they choose. Add group skills later if a recurring need emerges.` }],
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `Failed to create channel: ${err.message}` }],
            isError: true,
          };
        }
      }

      // All remaining actions require channel_id
      if (!channelId) {
        return {
          content: [{ type: 'text' as const, text: 'channel_id is required for this action.' }],
          isError: true,
        };
      }

      if (action === 'info') {
        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        const isMember = channel.subscribers.some(s => s.handle === currentUser.handle);
        const joinRule = channel.joinRule || (channel.visibility === 'private' ? 'invite' : 'open');
        if (joinRule === 'invite' && !isMember) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} is invite-only. You need an invite to see details.` }],
            isError: true,
          };
        }

        const memberList = channel.subscribers.map(s => `@${s.handle} (${s.role})`).join(', ');
        const skillList = channel.skills.length > 0
          ? channel.skills.map(s => `• ${s.name}: ${s.description}`).join('\n')
          : '(no skills yet)';

        return {
          content: [{ type: 'text' as const, text: `#${channel.id} — ${channel.name}\n${channel.description || ''}\nJoin rule: ${joinRule}\nCreated by: @${channel.createdBy}\nMembers (${channel.subscribers.length}): ${memberList}\n\nSkills:\n${skillList}` }],
        };
      }

      if (action === 'join') {
        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        // Check if already subscribed
        if (channel.subscribers.some(s => s.handle === currentUser.handle)) {
          return {
            content: [{ type: 'text' as const, text: `You are already a member of #${channelId}.` }],
          };
        }

        const joinRuleForJoin = channel.joinRule || (channel.visibility === 'private' ? 'invite' : 'open');
        if (joinRuleForJoin === 'invite') {
          if (!inviteToken) {
            return {
              content: [{ type: 'text' as const, text: `Channel #${channelId} is invite-only. Provide an invite_token to join.` }],
              isError: true,
            };
          }

          try {
            await storage.useInvite(inviteToken, { channelId, handle: currentUser.handle });
          } catch (err: any) {
            return {
              content: [{ type: 'text' as const, text: `Invalid invite: ${err.message}` }],
              isError: true,
            };
          }
        }

        await storage.addSubscriber(channelId, currentUser.handle, 'member');

        // Mark onboarded on first action
        if (!currentUser.onboardedAt) {
          await storage.updateUser(currentUser.handle, { onboardedAt: Date.now() });
        }

        server.sendToolListChanged().catch(() => {});

        return {
          content: [{ type: 'text' as const, text: `Joined #${channelId}. Choose what to share at ${BASE_URL}/posting-rules?group=${encodeURIComponent(channelId)}. Your existing rules are unchanged. Read this group's notes with router_search group_id: "${channelId}". You also have ${channel.skills.length} group skill(s) as channel_${channelId}_* tools.` }],
        };
      }

      if (action === 'leave') {
        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        if (!channel.subscribers.some(s => s.handle === currentUser.handle)) {
          return {
            content: [{ type: 'text' as const, text: `You are not a member of #${channelId}.` }],
          };
        }

        await storage.removeSubscriber(channelId, currentUser.handle);

        server.sendToolListChanged().catch(() => {});

        return {
          content: [{ type: 'text' as const, text: `Left #${channelId}. Channel tools have been removed.` }],
        };
      }

      if (action === 'invite') {
        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        // Only admins can create invites
        const subscriber = channel.subscribers.find(s => s.handle === currentUser.handle);
        if (!subscriber || subscriber.role !== 'admin') {
          return {
            content: [{ type: 'text' as const, text: 'Only channel admins can create invite links.' }],
            isError: true,
          };
        }

        const token = generateEntryId(); // Reuse ID generator for random tokens
        const invite: ChannelInvite = {
          token,
          channelId,
          createdBy: currentUser.handle,
          createdAt: Date.now(),
          uses: 0,
        };

        await storage.createInvite(invite);

        const inviteUrl = `${BASE_URL}/join?channelinvite=${encodeURIComponent(token)}`;
        return {
          content: [{ type: 'text' as const, text: `Invite created for #${channelId}.\n\nJoin link: ${inviteUrl}\nToken: ${token}\n\nUsers can click the link to join. They can also join manually with: router_channels action: "join", channel_id: "${channelId}", invite_token: "${token}"` }],
        };
      }

      if (action === 'invite_user') {
        if (!channelId) {
          return {
            content: [{ type: 'text' as const, text: 'channel_id is required for invite_user.' }],
            isError: true,
          };
        }

        if (!targetHandle) {
          return {
            content: [{ type: 'text' as const, text: 'handle is required for invite_user.' }],
            isError: true,
          };
        }

        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        // Only admins can invite users directly
        const subscriber = channel.subscribers.find(s => s.handle === currentUser.handle);
        if (!subscriber || subscriber.role !== 'admin') {
          return {
            content: [{ type: 'text' as const, text: 'Only channel admins can invite users directly.' }],
            isError: true,
          };
        }

        // Check target user exists
        const targetUser = await storage.getUser(targetHandle);
        if (!targetUser) {
          return {
            content: [{ type: 'text' as const, text: `User @${targetHandle} not found.` }],
            isError: true,
          };
        }

        // Check not already a member
        if (channel.subscribers.some(s => s.handle === targetHandle)) {
          return {
            content: [{ type: 'text' as const, text: `@${targetHandle} is already a member of #${channelId}.` }],
          };
        }

        // Generate single-use invite token
        const token = generateEntryId();
        const invite: ChannelInvite = {
          token,
          channelId,
          createdBy: currentUser.handle,
          createdAt: Date.now(),
          maxUses: 1,
          forHandle: targetHandle,
          uses: 0,
        };
        await storage.createInvite(invite);

        // Create an addressed entry to the target user with the invitation
        const inviteUrl = `${BASE_URL}/?view=channel&id=${encodeURIComponent(channelId)}&invite=${encodeURIComponent(token)}`;
        const inviteMessage = `You've been invited to join #${channelId} by @${currentUser.handle}.\n\nChannel: ${channel.name}${channel.description ? ' — ' + channel.description : ''}\n\nJoin link: ${inviteUrl}\n\nManual fallback: router_channels action: "join", channel_id: "${channelId}", invite_token: "${token}"`;

        // Use short staging delay (60 seconds) so invitations arrive quickly
        const shortStagingDelay = 60 * 1000;

        await storage.addEntry({
          pseudonym,
          handle: currentUser.handle,
          client: 'code',
          content: inviteMessage,
          timestamp: Date.now(),
          humanVisible: true,
          to: [`@${targetHandle}`],
          visibility: 'private',
        }, shortStagingDelay);

        return {
          content: [{ type: 'text' as const, text: `Invitation sent to @${targetHandle} for #${channelId}. The invite will appear in their inbox shortly.` }],
        };
      }

      if (action === 'add_skill') {
        if (!channelId) {
          return { content: [{ type: 'text' as const, text: 'channel_id is required.' }], isError: true };
        }
        const newSkillName = channelName?.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!newSkillName) {
          return { content: [{ type: 'text' as const, text: 'name is required for add_skill (lowercase, hyphens ok).' }], isError: true };
        }

        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return { content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }], isError: true };
        }

        const sub = channel.subscribers.find(s => s.handle === currentUser.handle);
        if (!sub || sub.role !== 'admin') {
          return { content: [{ type: 'text' as const, text: 'Only channel admins can add skills.' }], isError: true };
        }

        if (channel.skills.some(s => s.name === newSkillName)) {
          return { content: [{ type: 'text' as const, text: `Skill "${newSkillName}" already exists in #${channelId}. Use update_skill to modify it.` }], isError: true };
        }

        const newSkill: Skill = {
          id: `${channelId}_${newSkillName}`,
          name: newSkillName,
          description: channelDescription || '',
          instructions: skillInstructions || '',
          handlerType: 'instructions',
          createdAt: Date.now(),
        };

        channel.skills.push(newSkill);
        await storage.updateChannel(channelId, { skills: channel.skills });

        return {
          content: [{ type: 'text' as const, text: `Added skill "${newSkillName}" to #${channelId}.\n\nSubscribers will see it as channel_${channelId}_${newSkillName} on their next connection.\n\nDescription: ${newSkill.description}\nInstructions: ${newSkill.instructions || '(none)'}` }],
        };
      }

      if (action === 'update_skill') {
        if (!channelId) {
          return { content: [{ type: 'text' as const, text: 'channel_id is required.' }], isError: true };
        }
        const targetSkill = skillName || channelName?.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!targetSkill) {
          return { content: [{ type: 'text' as const, text: 'skill_name is required for update_skill.' }], isError: true };
        }

        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return { content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }], isError: true };
        }

        const sub = channel.subscribers.find(s => s.handle === currentUser.handle);
        if (!sub || sub.role !== 'admin') {
          return { content: [{ type: 'text' as const, text: 'Only channel admins can update skills.' }], isError: true };
        }

        const skill = channel.skills.find(s => s.name === targetSkill);
        if (!skill) {
          return { content: [{ type: 'text' as const, text: `Skill "${targetSkill}" not found in #${channelId}.` }], isError: true };
        }

        if (channelDescription !== undefined) skill.description = channelDescription;
        if (skillInstructions !== undefined) skill.instructions = skillInstructions;

        await storage.updateChannel(channelId, { skills: channel.skills });

        return {
          content: [{ type: 'text' as const, text: `Updated skill "${targetSkill}" in #${channelId}.\n\nDescription: ${skill.description}\nInstructions: ${skill.instructions || '(none)'}` }],
        };
      }

      if (action === 'remove_skill') {
        if (!channelId) {
          return { content: [{ type: 'text' as const, text: 'channel_id is required.' }], isError: true };
        }
        const targetSkill = skillName || channelName?.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!targetSkill) {
          return { content: [{ type: 'text' as const, text: 'skill_name is required for remove_skill.' }], isError: true };
        }

        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return { content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }], isError: true };
        }

        const sub = channel.subscribers.find(s => s.handle === currentUser.handle);
        if (!sub || sub.role !== 'admin') {
          return { content: [{ type: 'text' as const, text: 'Only channel admins can remove skills.' }], isError: true };
        }

        const idx = channel.skills.findIndex(s => s.name === targetSkill);
        if (idx === -1) {
          return { content: [{ type: 'text' as const, text: `Skill "${targetSkill}" not found in #${channelId}.` }], isError: true };
        }

        channel.skills.splice(idx, 1);
        await storage.updateChannel(channelId, { skills: channel.skills });

        return {
          content: [{ type: 'text' as const, text: `Removed skill "${targetSkill}" from #${channelId}.` }],
        };
      }
    }

    // Handle router_skills_browse tool
    if (name === 'router_skills_browse') {
      try {
        const query = (args as { query?: string })?.query?.toLowerCase();
        const limit = Math.min((args as { limit?: number })?.limit || 20, 50);

        const allUsers = await storage.getAllUsers();
        const publicSkills: Array<Skill & { authorHandle: string }> = [];

        for (const u of allUsers) {
          for (const skill of (u.skills || [])) {
            if (skill.public) {
              publicSkills.push({ ...skill, authorHandle: u.handle });
            }
          }
        }

        // Filter by query if provided
        let filtered = publicSkills;
        if (query) {
          filtered = publicSkills.filter(s =>
            s.name.includes(query) ||
            s.description.toLowerCase().includes(query) ||
            (s.instructions && s.instructions.toLowerCase().includes(query))
          );
        }

        // Sort by clone count descending
        filtered.sort((a, b) => (b.cloneCount || 0) - (a.cloneCount || 0));
        filtered = filtered.slice(0, limit);

        if (filtered.length === 0) {
          return {
            content: [{ type: 'text' as const, text: query ? `No public skills found matching "${query}".` : 'No public skills available yet.' }],
          };
        }

        const list = filtered.map(s =>
          `• ${s.name} by @${s.authorHandle} (${s.cloneCount || 0} clones)\n  ${s.description.slice(0, 100)}${s.description.length > 100 ? '...' : ''}`
        ).join('\n');

        return {
          content: [{
            type: 'text' as const,
            text: `Public Skills Gallery (${filtered.length} results):\n\n${list}\n\nUse router_skills_clone to copy a skill to your account.`,
          }],
        };
      } catch (error: any) {
        console.error('router_skills_browse error:', error);
        return {
          content: [{ type: 'text' as const, text: `Failed to browse skills: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // Handle router_skills_clone tool
    if (name === 'router_skills_clone') {
      try {
        const skillName = (args as { skill_name?: string })?.skill_name;
        const authorHandle = (args as { author?: string })?.author?.replace(/^@/, '').toLowerCase();

        if (!skillName || !authorHandle) {
          return {
            content: [{ type: 'text' as const, text: 'Both skill_name and author are required.' }],
            isError: true,
          };
        }

        const currentUser = await storage.getUserByKeyHash(keyHash);
        if (!currentUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'You need a handle to clone skills. Claim one in settings.' }],
            isError: true,
          };
        }

        const userSkills = currentUser.skills || [];
        if (userSkills.length >= MAX_SKILLS_PER_USER) {
          return {
            content: [{ type: 'text' as const, text: `Maximum ${MAX_SKILLS_PER_USER} skills allowed. Delete an existing skill first.` }],
            isError: true,
          };
        }

        if (userSkills.some(s => s.name === skillName)) {
          return {
            content: [{ type: 'text' as const, text: `You already have a skill named "${skillName}". Delete it first or choose a different skill.` }],
            isError: true,
          };
        }

        // Find source skill
        const authorUser = await storage.getUser(authorHandle);
        if (!authorUser) {
          return {
            content: [{ type: 'text' as const, text: `User @${authorHandle} not found.` }],
            isError: true,
          };
        }

        const sourceSkill = (authorUser.skills || []).find(s => s.name === skillName && s.public);
        if (!sourceSkill) {
          return {
            content: [{ type: 'text' as const, text: `No public skill named "${skillName}" found for @${authorHandle}.` }],
            isError: true,
          };
        }

        // Clone the skill
        const clonedSkill: Skill = {
          id: generateSkillId(),
          name: sourceSkill.name,
          description: sourceSkill.description,
          instructions: sourceSkill.instructions,
          handlerType: 'instructions',
          parameters: sourceSkill.parameters ? [...sourceSkill.parameters] : undefined,
          triggerCondition: sourceSkill.triggerCondition,
          to: undefined,           // Clear destinations — user must configure
          visibility: sourceSkill.visibility,
          public: false,           // Start as private
          author: currentUser.handle,
          clonedFrom: `${authorHandle}/${sourceSkill.id}`,
          cloneCount: 0,
          createdAt: Date.now(),
        };

        // Add to current user's skills
        const updatedSkills = [...userSkills, clonedSkill];
        const cloneUpdates: Record<string, any> = { skills: updatedSkills };
        if (!currentUser.onboardedAt) cloneUpdates.onboardedAt = Date.now();
        await storage.updateUser(currentUser.handle, cloneUpdates);

        // Increment source skill's clone count
        const sourceSkills = authorUser.skills || [];
        const sourceIndex = sourceSkills.findIndex(s => s.id === sourceSkill.id);
        if (sourceIndex !== -1) {
          const updatedSourceSkills = [...sourceSkills];
          updatedSourceSkills[sourceIndex] = {
            ...updatedSourceSkills[sourceIndex],
            cloneCount: (updatedSourceSkills[sourceIndex].cloneCount || 0) + 1,
          };
          await storage.updateUser(authorHandle, { skills: updatedSourceSkills });
        }

        server.sendToolListChanged().catch(() => {});

        return {
          content: [{
            type: 'text' as const,
            text: `Cloned "${skillName}" from @${authorHandle}!\n\n` +
              `Tool name: skill_${skillName}\n` +
              `Destinations: (none — configure with router_skills update)\n` +
              `Gallery: private\n\n` +
              `The skill_${skillName} tool is now available.`,
          }],
        };
      } catch (error: any) {
        console.error('router_skills_clone error:', error);
        return {
          content: [{ type: 'text' as const, text: `Failed to clone skill: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // Handle channel_* tools (channel-scoped skills)
    if (name.startsWith('channel_')) {
      try {
        // Parse: channel_<channelId>_<skillName>
        // channelId can contain hyphens but not underscores, so split on first and last underscore
        const firstUnderscore = name.indexOf('_');
        const lastUnderscore = name.lastIndexOf('_');
        if (firstUnderscore === lastUnderscore) {
          return {
            content: [{ type: 'text' as const, text: `Invalid channel tool name: ${name}` }],
            isError: true,
          };
        }
        const channelId = name.substring(firstUnderscore + 1, lastUnderscore);
        const skillName = name.substring(lastUnderscore + 1);

        const currentUser = await storage.getUserByKeyHash(keyHash);
        if (!currentUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'No account found.' }],
            isError: true,
          };
        }

        const channel = await storage.getChannel(channelId);
        if (!channel) {
          return {
            content: [{ type: 'text' as const, text: `Channel #${channelId} not found.` }],
            isError: true,
          };
        }

        // Verify user is a subscriber
        if (!channel.subscribers.some(s => s.handle === currentUser.handle)) {
          return {
            content: [{ type: 'text' as const, text: `You are not a member of #${channelId}.` }],
            isError: true,
          };
        }

        // Find the skill
        const skill = channel.skills.find(s => s.name === skillName);
        if (!skill) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${skillName}" not found in #${channelId}.` }],
            isError: true,
          };
        }

        const result = (args as { result?: string })?.result;
        const rawSearchKeywords = (args as { search_keywords?: string[] })?.search_keywords;

        if (result) {
          // Auto-post mode: create an entry tagged with the channel
          const userStagingDelay = currentUser.stagingDelayMs ?? STAGING_DELAY_MS;

          // Use #channel in to array — access resolved live via channel membership
          const aiOnly = isDefaultAiOnly(currentUser);
          await postingAudience(currentUser, args?.posting_intent, [`#${channelId}`]);

          const saved = await storage.addEntry({
            pseudonym,
            handle: currentUser.handle,
            client: 'code',
            content: result.trim(),
            timestamp: Date.now(),
            model: 'channel-skill',
            humanVisible: !aiOnly, // backward compat
            aiOnly,
            topicHints: [`channel:${channelId}`, `skill:${skillName}`],
            channel: channelId, // backward compat
            to: [`#${channelId}`],
          }, userStagingDelay);

          // Mark onboarded on first action
          if (!currentUser.onboardedAt) {
            await storage.updateUser(currentUser.handle, { onboardedAt: Date.now() });
          }

          const receipt = sharingReceipt(saved, BASE_URL, storage instanceof StagedStorage && storage.isPending(saved.id));
          let responseText = formatSharingReceipt(receipt);
          const { queryUsed, results: relatedResults } = await buildRelatedResults({
            entryText: result.trim(),
            searchKeywords: rawSearchKeywords,
            limit: 5,
          });
          responseText += `\n\nRelated results:\n${formatRouterSearchText({
            query: queryUsed,
            results: relatedResults,
          })}`;

          return {
            structuredContent: { receipt },
            content: [{ type: 'text' as const, text: responseText }],
          };
        }

        // Instructions mode: return skill instructions + parameter values
        const paramValues: Record<string, any> = {};
        for (const param of (skill.parameters || [])) {
          const value = (args as Record<string, any>)?.[param.name];
          if (value !== undefined) {
            paramValues[param.name] = value;
          }
        }

        let instructionText = `Channel: #${channelId}\nSkill: ${skill.name}\n`;
        if (skill.instructions) {
          instructionText += `\nInstructions:\n${skill.instructions}\n`;
        }
        if (Object.keys(paramValues).length > 0) {
          instructionText += `\nParameters:\n${Object.entries(paramValues).map(([k, v]) => `• ${k}: ${JSON.stringify(v)}`).join('\n')}\n`;
        }
        instructionText += `\nTo post the result to #${channelId}, call this tool again with the "result" parameter.`;

        return {
          content: [{ type: 'text' as const, text: instructionText }],
        };
      } catch (error: any) {
        console.error(`channel_* handler error:`, error);
        return {
          content: [{ type: 'text' as const, text: `Channel skill error: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // Handle skill_* tools (user-created skills)
    if (name.startsWith('skill_')) {
      try {
        const skillName = name.slice(6); // Remove 'skill_' prefix
        const currentUser = await storage.getUserByKeyHash(keyHash);
        if (!currentUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'No account found.' }],
            isError: true,
          };
        }

        const skill = (currentUser.skills || []).find(s => s.name === skillName);
        if (!skill) {
          return {
            content: [{ type: 'text' as const, text: `Skill "${skillName}" not found in your skills.` }],
            isError: true,
          };
        }

        const result = (args as { result?: string })?.result;
        const rawSearchKeywords = (args as { search_keywords?: string[] })?.search_keywords;

        if (result) {
          // Auto-post mode: create an entry with the skill's destinations
          const userStagingDelay = currentUser.stagingDelayMs ?? STAGING_DELAY_MS;
          const destinations = await postingAudience(currentUser, args?.posting_intent, skill.to);

          // Determine aiOnly: skill.aiOnly > skill legacy > user default
          let aiOnly: boolean;
          if (skill.aiOnly !== undefined) {
            aiOnly = skill.aiOnly;
          } else if (skill.humanVisible !== undefined) {
            aiOnly = !skill.humanVisible;
          } else if (skill.visibility === 'ai-only') {
            aiOnly = true;
          } else {
            aiOnly = isDefaultAiOnly(currentUser);
          }

          const saved = await storage.addEntry({
            pseudonym,
            handle: currentUser.handle,
            client: 'code',
            content: result.trim(),
            timestamp: Date.now(),
            model: 'skill',
            humanVisible: !aiOnly, // backward compat
            aiOnly,
            topicHints: [`skill:${skillName}`],
            to: destinations?.length ? destinations : undefined,
          }, userStagingDelay);

          // Mark onboarded on first action
          if (currentUser && !currentUser.onboardedAt) {
            await storage.updateUser(currentUser.handle, { onboardedAt: Date.now() });
          }

          const receipt = sharingReceipt(saved, BASE_URL, storage instanceof StagedStorage && storage.isPending(saved.id));
          let responseText = formatSharingReceipt(receipt);
          const { queryUsed, results: relatedResults } = await buildRelatedResults({
            entryText: result.trim(),
            searchKeywords: rawSearchKeywords,
            limit: 5,
          });
          responseText += `\n\nRelated results:\n${formatRouterSearchText({
            query: queryUsed,
            results: relatedResults,
          })}`;

          return {
            structuredContent: { receipt },
            content: [{ type: 'text' as const, text: responseText }],
          };
        }

        // Instructions mode: return skill instructions + parameter values
        const paramValues: Record<string, any> = {};
        for (const param of (skill.parameters || [])) {
          const value = (args as Record<string, any>)?.[param.name];
          if (value !== undefined) {
            paramValues[param.name] = value;
          }
        }

        let instructionText = `Skill: ${skill.name}\n`;
        if (skill.instructions) {
          instructionText += `\nInstructions:\n${skill.instructions}\n`;
        }
        if (Object.keys(paramValues).length > 0) {
          instructionText += `\nParameters:\n${Object.entries(paramValues).map(([k, v]) => `• ${k}: ${JSON.stringify(v)}`).join('\n')}\n`;
        }
        if (skill.to && skill.to.length > 0) {
          instructionText += `\nDestinations: ${skill.to.join(', ')}`;
          instructionText += `\nTo post the result, call this tool again with the "result" parameter.`;
        }

        return {
          content: [{ type: 'text' as const, text: instructionText }],
        };
      } catch (error: any) {
        console.error(`skill_* handler error:`, error);
        return {
          content: [{ type: 'text' as const, text: `Skill error: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // ─────────────────────────────────────────────────────────────
    // Agent infrastructure tools
    // ─────────────────────────────────────────────────────────────

    if (name === 'router_poll_events') {
      const handle = await getHandle();
      const isModerator = handle && MODERATOR_HANDLES.has(handle);
      if (MODERATOR_HANDLES.size > 0 && !isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only the Router agent can poll events.' }],
          isError: true,
        };
      }

      const cursor = (args as { cursor?: number; limit?: number })?.cursor || 0;
      const limit = (args as { cursor?: number; limit?: number })?.limit || 50;
      const events = getEventsSince(cursor, limit);
      const latestCursor = events.length > 0 ? events[events.length - 1].id : getLatestCursor();

      if (events.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No new events. Latest cursor: ${latestCursor}` }],
          structuredContent: {
            events: [],
            latest_cursor: latestCursor,
            next_cursor: latestCursor,
          },
        };
      }

      const formatted = events.map(e => {
        const time = new Date(e.timestamp).toISOString();
        return `[${e.id}] ${time} ${e.type}: ${JSON.stringify(e.data)}`;
      }).join('\n');
      return {
        content: [{ type: 'text' as const, text: `${events.length} events (cursor ${latestCursor}):\n\n${formatted}` }],
        structuredContent: {
          events,
          latest_cursor: latestCursor,
          next_cursor: latestCursor,
        },
      };
    }

    // (Telegram send/get_messages removed — handled by Nous Router gateway)

    // Placeholder to maintain code structure
    if (false) {
      return {
        content: [{ type: 'text' as const, text: '' }],
      };
    }

    // ─────────────────────────────────────────────────────────────
    // Content moderation tools
    // ─────────────────────────────────────────────────────────────

    if (name === 'router_review_staged') {
      if (!(storage instanceof StagedStorage)) {
        return {
          content: [{ type: 'text' as const, text: 'Staging is not enabled on this server.' }],
          isError: true,
        };
      }

      const handle = await getHandle();
      const isModerator = handle && MODERATOR_HANDLES.has(handle);
      const filterAuthor = (args as { author?: string })?.author;

      const now = Date.now();
      let entries = storage.getAllPendingEntries();

      // Everyone sees their own waiting entries. Moderators also see entries held
      // by moderation, never other people's ordinary waiting entries.
      entries = entries.filter(e => isEntryAuthor(e, pseudonym, handle) || (isModerator && isModerationHeld(e, now)));
      if (isModerator && filterAuthor) {
        entries = entries.filter(e => e.handle === filterAuthor);
      }

      if (entries.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No pending entries in the staging buffer.' }],
        };
      }

      const lines = entries.map(e => {
        const author = e.handle ? `@${e.handle}` : e.pseudonym;
        const timeUntilPublish = (e.publishAt ?? 0) - now;
        const isHeld = isModerationHeld(e, now);
        const timeStr = isHeld
          ? 'HELD (indefinite)'
          : !noticeRecorded(e) ? 'waiting for sharing notice; countdown not started'
          : timeUntilPublish > 0
            ? `publishes in ${Math.round(timeUntilPublish / 60000)} min`
            : 'publishing soon';
        if (!isEntryAuthor(e, pseudonym, handle) && !isHeldByAutomatedReview(e, now)) {
          const heldBy = e.moderationHeldBy ? ` by @${e.moderationHeldBy}` : '';
          return `[${e.id}] ${author} (${timeStr}${heldBy}):\n(content hidden: only entries held by automated review can be read before they publish)`;
        }
        return `[${e.id}] ${author} (${timeStr}):\n${e.content.slice(0, 500)}${e.content.length > 500 ? '...' : ''}`;
      });

      return {
        content: [{ type: 'text' as const, text: `${entries.length} pending entries:\n\n${lines.join('\n\n---\n\n')}` }],
      };
    }

    if (name === 'router_hold_entry') {
      if (!(storage instanceof StagedStorage)) {
        return {
          content: [{ type: 'text' as const, text: 'Staging is not enabled on this server.' }],
          isError: true,
        };
      }

      const handle = await getHandle();
      const isModerator = handle && MODERATOR_HANDLES.has(handle);

      if (MODERATOR_HANDLES.size > 0 && !isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only moderators can hold entries.' }],
          isError: true,
        };
      }

      const entryId = (args as { entry_id?: string; reason?: string })?.entry_id;
      const reason = (args as { entry_id?: string; reason?: string })?.reason || 'Flagged for review by content moderation.';

      if (!entryId) {
        return {
          content: [{ type: 'text' as const, text: 'Entry ID is required.' }],
          isError: true,
        };
      }

      if (!storage.isPending(entryId)) {
        return {
          content: [{ type: 'text' as const, text: `Entry ${entryId} is not in the staging buffer (it may have already published or been deleted).` }],
          isError: true,
        };
      }

      // Push publishAt to ~999999 years from now and mark as moderation-held
      const FOREVER = Date.now() + (999999 * 365.25 * 24 * 60 * 60 * 1000);
      const updated = storage.holdEntry(entryId, reason, FOREVER, handle || pseudonym);

      if (!updated) {
        return {
          content: [{ type: 'text' as const, text: `Failed to hold entry ${entryId}.` }],
          isError: true,
        };
      }

      // Try to notify the author via email
      const entry = await storage.getEntry(entryId);
      if (entry) {
        const authorHandle = entry.handle;
        if (authorHandle) {
          const authorUser = await storage.getUser(authorHandle);
          if (authorUser?.email && authorUser.emailVerified && emailClient) {
            try {
              await emailClient.send({
                to: authorUser.email,
                from: process.env.SENDGRID_FROM_EMAIL || 'notify@router.teleport.computer',
                subject: 'One of your notebook entries needs a look',
                html: `
<p>Hey @${authorHandle} —</p>
<p>One of your entries was flagged before it could publish. This isn't a big deal — it just means the automated review wasn't confident it should go out without you checking it first.</p>
<p><strong>Why it was held:</strong> ${reason}</p>
<p>You have two options:</p>
<ul>
  <li><strong>Delete it</strong> if it was a mistake or too personal</li>
  <li><strong>Let us know</strong> if you think it should be published — we'll release it</li>
</ul>
<p>The entry is still saved and hasn't been shared with anyone.</p>
<p style="margin-top: 24px; color: #888; font-size: 13px;">
  <a href="${BASE_URL}">router.teleport.computer</a>
</p>`,
              });
            } catch (emailErr) {
              console.error('[Moderation] Failed to send hold notification email:', emailErr);
            }
          }
        }
      }

      console.log(`[Moderation] Entry ${entryId} held by @${handle || pseudonym}`);

      return {
        content: [{ type: 'text' as const, text: `Entry ${entryId} has been held indefinitely. It will not auto-publish. Author has been notified${entry?.handle ? ` (@${entry.handle})` : ''}.${reason ? ` Reason: ${reason}` : ''}` }],
      };
    }

    if (name === 'router_release_entry') {
      if (!(storage instanceof StagedStorage)) {
        return {
          content: [{ type: 'text' as const, text: 'Staging is not enabled on this server.' }],
          isError: true,
        };
      }

      const handle = await getHandle();
      const isModerator = handle && MODERATOR_HANDLES.has(handle);

      if (MODERATOR_HANDLES.size > 0 && !isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only moderators can release held entries.' }],
          isError: true,
        };
      }

      const entryId = (args as { entry_id?: string })?.entry_id;

      if (!entryId) {
        return {
          content: [{ type: 'text' as const, text: 'Entry ID is required.' }],
          isError: true,
        };
      }

      if (!storage.isPending(entryId)) {
        return {
          content: [{ type: 'text' as const, text: `Entry ${entryId} is not in the staging buffer.` }],
          isError: true,
        };
      }

      // Moderators may only release held entries, and only back onto the entry's
      // original schedule. A waiting entry belongs to its author until it publishes;
      // cutting the author's delete window short is not a moderation action.
      const pendingEntry = await storage.getEntry(entryId);
      const ownEntry = !!pendingEntry && isEntryAuthor(pendingEntry, pseudonym, handle);
      if (pendingEntry && !ownEntry) {
        if (!isModerationHeld(pendingEntry)) {
          return {
            content: [{ type: 'text' as const, text: `Entry ${entryId} is not held. It will publish on its own schedule; only held entries can be released.` }],
            isError: true,
          };
        }
        const publishAt = storage.releaseHold(entryId);
        if (publishAt === null) {
          return {
            content: [{ type: 'text' as const, text: `Entry ${entryId} was held before original publish times were recorded, so releasing it could publish it before its author's window ends. Only its author can publish it.` }],
            isError: true,
          };
        }
        if (publishAt > Date.now()) {
          console.log(`[Moderation] Entry ${entryId} released by @${handle || pseudonym} (back on schedule)`);
          const minutes = Math.max(1, Math.round((publishAt - Date.now()) / 60000));
          return {
            content: [{ type: 'text' as const, text: `Entry ${entryId} has been released. It is back on its original schedule and publishes in ${minutes} min, unless its author deletes it first.` }],
          };
        }
      }

      if (pendingEntry && !noticeRecorded(pendingEntry)) {
        return { content: [{ type: 'text' as const, text: 'The sharing notice must be delivered and recorded before this post can publish. Use router_record_sharing_notice.' }], isError: true };
      }
      // Publish immediately via existing publishEntry method
      const published = await storage.publishEntry(entryId);
      if (!published) {
        return {
          content: [{ type: 'text' as const, text: `Failed to release entry ${entryId}.` }],
          isError: true,
        };
      }

      console.log(`[Moderation] Entry ${entryId} released by @${handle || pseudonym}`);

      return {
        content: [{ type: 'text' as const, text: `Entry ${entryId} has been released and published immediately.` }],
      };
    }

    // Handle daily question tool
    if (name === 'router_daily_question') {
      try {
        const currentUser = await storage.getUserByKeyHash(keyHash);
        if (!currentUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'You need a handle to use the daily question tool. Claim one first.' }],
            isError: true,
          };
        }

        // Double-check not already triggered today
        const now = Date.now();
        const last = currentUser.lastDailyQuestionAt;
        if (last) {
          const lastDate = new Date(last).toISOString().slice(0, 10);
          const todayDate = new Date(now).toISOString().slice(0, 10);
          if (lastDate === todayDate) {
            return {
              content: [{ type: 'text' as const, text: 'Daily question already triggered today. Try again tomorrow (resets midnight UTC).' }],
              isError: true,
            };
          }
        }

        // Mark as used FIRST to prevent double-trigger from concurrent sessions
        await storage.updateUser(currentUser.handle, { lastDailyQuestionAt: now });

        // Notify client that tool list changed (daily question is now hidden)
        server.sendToolListChanged().catch(() => {});

        // Gather context
        const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
        const twoDaysAgo = now - 2 * 24 * 60 * 60 * 1000;

        // 1. User's recent entries (7 days, up to 10)
        const userEntries = (await storage.getEntriesByHandle(currentUser.handle, 50))
          .filter(isPublicNotebookEntry)
          .filter(e => e.timestamp >= sevenDaysAgo)
          .slice(0, 10);

        // 2. Followed users' entries (2 days, up to 8)
        const following = currentUser.following || [];
        let followedEntries: JournalEntry[] = [];
        for (const f of following) {
          const entries = (await storage.getEntriesByHandle(f.handle, 20))
            .filter(isPublicNotebookEntry)
            .filter(e => e.timestamp >= twoDaysAgo);
          followedEntries.push(...entries);
        }
        followedEntries.sort((a, b) => b.timestamp - a.timestamp);
        followedEntries = followedEntries.slice(0, 8);

        // 3. Other recent entries for broader context (2 days, up to 5)
        const allRecent = (await storage.getEntries(50))
          .filter(isPublicNotebookEntry)
          .filter(e => e.timestamp >= twoDaysAgo && e.handle !== currentUser.handle && !following.some(f => f.handle === e.handle))
          .slice(0, 5);

        // Format context
        const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + '...' : s;
        const formatEntry = (e: JournalEntry) => {
          const date = new Date(e.timestamp).toISOString().slice(0, 10);
          const author = e.handle ? `@${e.handle}` : e.pseudonym;
          return `[${date}] ${author}: ${truncate(e.content, 300)}`;
        };

        let context = `# Daily Question Context for @${currentUser.handle}\n\n`;

        // Profile
        context += `## Your Profile\n`;
        if (currentUser.displayName) context += `Name: ${currentUser.displayName}\n`;
        if (currentUser.bio) context += `Bio: ${currentUser.bio}\n`;
        if (following.length > 0) {
          context += `\nFollowing:\n`;
          for (const f of following) {
            context += `• @${f.handle}${f.note ? ` — ${truncate(f.note, 150)}` : ''}\n`;
          }
        }

        // User's entries
        context += `\n## Your Recent Entries (last 7 days)\n`;
        if (userEntries.length === 0) {
          context += `No entries in the last 7 days.\n`;
        } else {
          for (const e of userEntries) {
            context += `${formatEntry(e)}\n`;
          }
        }

        // Followed entries
        if (followedEntries.length > 0) {
          context += `\n## Entries from People You Follow (last 2 days)\n`;
          for (const e of followedEntries) {
            context += `${formatEntry(e)}\n`;
          }
        }

        // Broader context
        if (allRecent.length > 0) {
          context += `\n## Other Recent Activity (last 2 days)\n`;
          for (const e of allRecent) {
            context += `${formatEntry(e)}\n`;
          }
        }

        context += `\n---\n`;
        context += `Use this context to ask one specific, thoughtful question. Reference specific things from the entries above — don't be generic. If the user has no entries, ask an introductory question about what they're working on.`;

        return {
          content: [{ type: 'text' as const, text: context }],
        };
      } catch (error: any) {
        console.error('router_daily_question error:', error);
        return {
          content: [{ type: 'text' as const, text: `Daily question error: ${error?.message || 'Unknown error'}` }],
          isError: true,
        };
      }
    }

    // ── Platform Tools ──────────────────────────────────────
    if (name === 'router_post_daily_digest') {
      const requesterHandle = await getHandle();
      const isModerator = !!requesterHandle && (MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requesterHandle));
      if (!isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only the Router agent can post the daily digest.' }],
          isError: true,
        };
      }

      const a = args as { date?: string; text?: string };
      const date = a.date?.trim();
      const text = a.text?.trim();
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return {
          content: [{ type: 'text' as const, text: 'date must be YYYY-MM-DD.' }],
          isError: true,
        };
      }
      if (!text) {
        return {
          content: [{ type: 'text' as const, text: 'text is required.' }],
          isError: true,
        };
      }

      const matrix = getPlatform('matrix') as (MatrixPlatform & {
        ensureChannelRoom?: (channelId: string, channelName: string, description?: string) => Promise<string>;
      }) | undefined;
      if (!matrix) {
        return {
          content: [{ type: 'text' as const, text: 'Matrix platform not connected.' }],
          isError: true,
        };
      }
      if (typeof matrix.ensureChannelRoom !== 'function') {
        return {
          content: [{ type: 'text' as const, text: 'Matrix platform does not support channel rooms.' }],
          isError: true,
        };
      }

      try {
        const result = await postDailyDigestToMatrix(matrix, date, text, requesterHandle);
        if (result.status === 'already-posted') {
          return {
            content: [{
              type: 'text' as const,
              text: `DAILY_DIGEST_ALREADY_POSTED\ndate: ${date}\nroom_id: ${result.record.roomId}\nmessage_id: ${result.record.messageId}\nposted_at: ${new Date(result.record.postedAt).toISOString()}`,
            }],
          };
        }

        return {
          content: [{
            type: 'text' as const,
            text: `DAILY_DIGEST_POSTED\ndate: ${date}\nroom_id: ${result.record.roomId}\nmessage_id: ${result.record.messageId}`,
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Daily digest post failed: ${err.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'router_platform_send') {
      const a = args as { platform: string; room_id: string; text: string; reply_to?: string };
      const platform = getPlatform(a.platform);
      if (!platform) {
        return { content: [{ type: 'text' as const, text: `Platform "${a.platform}" not connected.` }], isError: true };
      }
      try {
        const messageId = await platform.sendMessage(a.room_id, a.text, { replyTo: a.reply_to });
        return { content: [{ type: 'text' as const, text: `Message sent (${messageId})` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Send failed: ${err.message}` }], isError: true };
      }
    }

    if (name === 'router_platform_send_dm') {
      const requesterHandle = await getHandle();
      const isModerator = !!requesterHandle && (MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requesterHandle));
      if (!isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only the Router agent can DM raw platform users.' }],
          isError: true,
        };
      }

      const a = args as { platform?: string; platform_user_id?: string; text?: string };
      const platformName = a.platform?.trim();
      const platformUserId = a.platform_user_id?.trim();
      const text = a.text?.trim();
      if (!platformName || !platformUserId || !text) {
        return {
          content: [{ type: 'text' as const, text: 'platform, platform_user_id, and text are required.' }],
          isError: true,
        };
      }

      const platform = getPlatform(platformName);
      if (!platform) {
        return {
          content: [{ type: 'text' as const, text: `Platform "${platformName}" not connected.` }],
          isError: true,
        };
      }

      try {
        const messageId = await platform.sendDM(platformUserId, text);
        return {
          content: [{ type: 'text' as const, text: `DM sent to ${platformUserId} on ${platformName} (${messageId})` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `DM send failed: ${err.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'router_onboard_identity') {
      const requesterHandle = await getHandle();
      const isModerator = !!requesterHandle && (MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requesterHandle));
      if (!isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only the Router agent can provision onboarding identities.' }],
          isError: true,
        };
      }

      try {
        const a = args as {
          platform?: string;
          platform_user_id?: string;
          desired_handle?: string;
          display_name?: string;
          source?: string;
        };
        const platformName = a.platform?.trim().toLowerCase();
        const platformUserId = a.platform_user_id?.trim();
        const desiredHandle = normalizeHandle(a.desired_handle || '');
        const displayName = a.display_name?.trim();

        if (!platformName || !platformUserId || !desiredHandle) {
          return {
            content: [{ type: 'text' as const, text: 'platform, platform_user_id, and desired_handle are required.' }],
            isError: true,
          };
        }
        if (!isValidHandle(desiredHandle)) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid handle. Use 3-15 lowercase letters, numbers, or underscores, starting with a letter.' }],
            isError: true,
          };
        }

        const linkedUsers = await storage.getAllUsers();
        const alreadyLinked = linkedUsers.find(user =>
          user.linkedAccounts?.some(account =>
            account.platform === platformName
            && account.platformUserId === platformUserId
            && account.verified !== false,
          ),
        );
        if (alreadyLinked) {
          return {
            content: [{
              type: 'text' as const,
              text: `ALREADY_ONBOARDED\nhandle: @${alreadyLinked.handle}\nplatform: ${platformName}\nplatform_user_id: ${platformUserId}\nNo secret key can be returned because Router stores only key hashes. Ask the user to use their saved key or the account recovery policy.`,
            }],
          };
        }

        if (!(await storage.isHandleAvailable(desiredHandle))) {
          return {
            content: [{ type: 'text' as const, text: `Handle @${desiredHandle} is already taken. Ask the user for another handle.` }],
            isError: true,
          };
        }

        const provisionedSecretKey = generateSecretKey();
        const provisionedKeyHash = hashSecretKey(provisionedSecretKey);
        const existingByKey = await storage.getUserByKeyHash(provisionedKeyHash);
        if (existingByKey) {
          return {
            content: [{ type: 'text' as const, text: 'Generated key collision; retry onboarding.' }],
            isError: true,
          };
        }

        const user = await storage.createUser({
          handle: desiredHandle,
          secretKeyHash: provisionedKeyHash,
          displayName: displayName || undefined,
        });
        const linkedAccounts = [
          ...(user.linkedAccounts || []),
          {
            platform: platformName,
            platformUserId,
            linkedAt: Date.now(),
            verified: true,
          },
        ];
        await storage.updateUser(user.handle, { linkedAccounts });

        const pseudonym = derivePseudonym(provisionedSecretKey);
        const mcpUrl = `${BASE_URL}/mcp/sse?key=${provisionedSecretKey}`;
        const backend = 'teleport-router';

        return {
          content: [{
            type: 'text' as const,
            text: [
              'ONBOARDING_PROVISIONED',
              `backend: ${backend}`,
              `handle: @${user.handle}`,
              `platform: ${platformName}`,
              `platform_user_id: ${platformUserId}`,
              `source: ${a.source || 'matrix_onboarding'}`,
              `pseudonym: ${pseudonym}`,
              `secret_key: ${provisionedSecretKey}`,
              `mcp_url: ${mcpUrl}`,
              `web_url: ${BASE_URL}`,
              `attestation_url: ${BASE_URL}/api/attestation`,
              'delivery_note: Send the secret_key and mcp_url to the user exactly once. Tell them to save the key in a password manager and optionally delete this Matrix message after saving it.',
            ].join('\n'),
          }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `Onboarding failed: ${err.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'router_send_dm') {
      const a = args as { platform?: string; text?: string; handle?: string };
      const platformName = a.platform?.trim();
      const text = a.text?.trim();
      const requestedHandle = a.handle?.replace(/^@/, '').trim().toLowerCase();

      if (!platformName || !text) {
        return {
          content: [{ type: 'text' as const, text: 'platform and text are required.' }],
          isError: true,
        };
      }

      const requester = await storage.getUserByKeyHash(keyHash);
      if (!requester?.handle) {
        return {
          content: [{ type: 'text' as const, text: 'You need to register a Router handle first.' }],
          isError: true,
        };
      }

      const targetHandle = requestedHandle || requester.handle;
      const isModerator = MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requester.handle);
      if (targetHandle !== requester.handle && !isModerator) {
        return {
          content: [{ type: 'text' as const, text: 'Only moderators can send DMs on behalf of another handle.' }],
          isError: true,
        };
      }

      const targetUser = await storage.getUser(targetHandle);
      if (!targetUser?.handle) {
        return {
          content: [{ type: 'text' as const, text: `User @${targetHandle} not found.` }],
          isError: true,
        };
      }

      const linkedAccount = targetUser.linkedAccounts?.find(account =>
        account.platform === platformName
        && account.platformUserId
        && account.verified !== false,
      );
      if (!linkedAccount) {
        return {
          content: [{ type: 'text' as const, text: `@${targetHandle} has no linked ${platformName} account.` }],
          isError: true,
        };
      }

      const platform = getPlatform(platformName);
      if (!platform) {
        return {
          content: [{ type: 'text' as const, text: `Platform "${platformName}" not connected.` }],
          isError: true,
        };
      }

      try {
        const messageId = await platform.sendDM(linkedAccount.platformUserId, text);
        return {
          content: [{ type: 'text' as const, text: `DM sent to @${targetHandle} on ${platformName} (${messageId})` }],
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text' as const, text: `DM send failed: ${err.message}` }],
          isError: true,
        };
      }
    }

    if (name === 'router_platform_create_room') {
      const a = args as { platform: string; name: string; type?: string; invite_handles?: string[]; topic?: string; encrypted?: boolean };
      const platform = getPlatform(a.platform);
      if (!platform) {
        return { content: [{ type: 'text' as const, text: `Platform "${a.platform}" not connected.` }], isError: true };
      }
      try {
        const room = await platform.createRoom(a.name, {
          type: (a.type as any) || 'group',
          invite: a.invite_handles,
          topic: a.topic,
          encrypted: a.encrypted !== false,
        });
        return { content: [{ type: 'text' as const, text: `Room created: ${room.id} (${room.name || a.name})` }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Room creation failed: ${err.message}` }], isError: true };
      }
    }

    if (name === 'router_search_sparks') {
      try {
        const a = args as { handle?: string; query?: string };
        const { detectSparks: detect } = await import('./intelligence/sparks.js');
        let results: string[] = [];

        if (a.handle) {
          const entries = await publishedStorage.getEntriesByHandle(a.handle, 50);
          for (const entry of entries.filter(hasPublicAudience).slice(0, 2)) {
            const candidates = await detect(entry, publishedStorage);
            for (const c of candidates) {
              results.push(`@${a.handle} ↔ @${c.handle}: ${c.overlapTopics.join(', ')} (${c.matchingEntries.length} matching entries)`);
            }
          }
        } else if (a.query) {
          // Sparks are public discovery, not a way to infer private participation.
          // Apply the same policy as detectSparks before deriving authors or counts.
          const entries = (await publishedStorage.searchEntries(a.query, 100))
            .filter(hasPublicAudience).slice(0, 10);
          const handles = [...new Set(entries.map(e => e.handle).filter(Boolean))] as string[];
          if (handles.length >= 2) {
            for (let i = 0; i < handles.length - 1; i++) {
              for (let j = i + 1; j < Math.min(handles.length, i + 3); j++) {
                results.push(`@${handles[i]} ↔ @${handles[j]}: both writing about "${a.query}"`);
              }
            }
          }
        }

        return {
          content: [{ type: 'text' as const, text: results.length > 0 ? `Found ${results.length} potential sparks:\n\n${results.join('\n')}` : 'No sparks found.' }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Spark search failed: ${err.message}` }], isError: true };
      }
    }

    if (name === 'router_trigger_spark') {
      try {
        const requester = await storage.getUserByKeyHash(keyHash);
        const isModerator = !!requester?.handle && (MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requester.handle));
        if (!isModerator) {
          return {
            content: [{ type: 'text' as const, text: 'Only moderators can manually trigger sparks.' }],
            isError: true,
          };
        }

        const a = args as { source_handle?: string; target_handle?: string; reason?: string; message?: string };
        const sourceHandle = a.source_handle?.replace(/^@/, '').trim().toLowerCase();
        const targetHandle = a.target_handle?.replace(/^@/, '').trim().toLowerCase();
        const reason = a.reason?.trim();
        const message = a.message?.trim();

        if (!sourceHandle || !targetHandle || !reason) {
          return {
            content: [{ type: 'text' as const, text: 'source_handle, target_handle, and reason are required.' }],
            isError: true,
          };
        }
        if (sourceHandle === targetHandle) {
          return {
            content: [{ type: 'text' as const, text: 'source_handle and target_handle must be different.' }],
            isError: true,
          };
        }

        const [sourceUser, targetUser] = await Promise.all([
          storage.getUser(sourceHandle),
          storage.getUser(targetHandle),
        ]);
        if (!sourceUser?.handle || !targetUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'Both source_handle and target_handle must exist.' }],
            isError: true,
          };
        }

        const { triggerManualSpark } = await import('./hooks/agent.js');
        await triggerManualSpark(sourceHandle, targetHandle, reason, getAllPlatforms(), storage, message);

        return {
          content: [{ type: 'text' as const, text: `Spark posted in #sparks for @${sourceHandle} ↔ @${targetHandle}` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Trigger spark failed: ${err.message}` }], isError: true };
      }
    }

    if (name === 'router_connection_graph') {
      try {
        const a = args as { handle: string };
        const user = await storage.getUser(a.handle);
        if (!user) {
          return { content: [{ type: 'text' as const, text: `User @${a.handle} not found.` }], isError: true };
        }

        const following = user.following || [];
        const channels = await storage.listChannels();
        const userChannels = channels.filter(c => c.subscribers.some(s => s.handle === a.handle));
        const entries = await storage.getEntriesByHandle(a.handle, 20);
        const addressedTo = new Set<string>();
        for (const e of entries) {
          e.to?.filter(d => d.startsWith('@')).forEach(d => addressedTo.add(d));
        }

        let text = `Connection graph for @${a.handle}:\n\n`;
        text += `Following (${following.length}): ${following.map(f => `@${f.handle}`).join(', ') || 'none'}\n\n`;
        text += `Channels (${userChannels.length}): ${userChannels.map(c => `#${c.id}`).join(', ') || 'none'}\n\n`;
        text += `Addressed entries to: ${[...addressedTo].join(', ') || 'none'}\n\n`;
        text += `Recent entries: ${entries.length}`;

        return { content: [{ type: 'text' as const, text }] };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Graph failed: ${err.message}` }], isError: true };
      }
    }

    if (name === 'router_link_platform') {
      try {
        const a = args as { code: string };
        if (!a.code) {
          return { content: [{ type: 'text' as const, text: 'Missing code. DM the Router bot with "link" to get one.' }], isError: true };
        }

        const { redeemLinkToken } = await import('./intelligence/link-tokens.js');
        const token = redeemLinkToken(a.code.trim());
        if (!token) {
          return {
            content: [{ type: 'text' as const, text: 'Invalid or expired code. Codes last 10 minutes — DM the Router bot again to get a fresh one.' }],
            isError: true,
          };
        }

        const linkUser = await storage.getUserByKeyHash(keyHash);
        if (!linkUser?.handle) {
          return {
            content: [{ type: 'text' as const, text: 'You need to register a Router handle first. Run router_settings with action "get" to see your account status.' }],
            isError: true,
          };
        }

        const existing = linkUser.linkedAccounts || [];
        const existingIdx = existing.findIndex(acc => acc.platform === token.platform && acc.platformUserId === token.platformUserId);
        const newAccount = {
          platform: token.platform,
          platformUserId: token.platformUserId,
          linkedAt: Date.now(),
          verified: true,
        };
        if (existingIdx >= 0) existing[existingIdx] = newAccount;
        else existing.push(newAccount);

        await storage.updateUser(linkUser.handle, { linkedAccounts: existing });

        return {
          content: [{ type: 'text' as const, text: `Linked ${token.platform} account ${token.platformUserId} to @${linkUser.handle}. The Router agent can now message you on ${token.platform}.` }],
        };
      } catch (err: any) {
        return { content: [{ type: 'text' as const, text: `Link failed: ${err.message}` }], isError: true };
      }
    }

    return {
      content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
      isError: true,
    };
  });

  return server;
}

// ═══════════════════════════════════════════════════════════════
// CORS HEADERS
// ═══════════════════════════════════════════════════════════════

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

const ENTRY_COUNT_CACHE_TTL_MS = 15_000;
let cachedEntryCount: { value: number; expiresAt: number } | null = null;
const ANON_ENTRIES_CACHE_TTL_MS = 5_000;
let cachedAnonEntriesPage: { key: string; body: string; expiresAt: number } | null = null;

async function getEntryCountCached(storage: Storage): Promise<number> {
  const now = Date.now();
  if (!authorLayer && cachedEntryCount && cachedEntryCount.expiresAt > now) {
    return cachedEntryCount.value;
  }

  const value = await storage.getEntryCount();
  cachedEntryCount = {
    value,
    expiresAt: now + ENTRY_COUNT_CACHE_TTL_MS,
  };
  return value;
}

function buildAnonEntriesCacheKey(limit: number, offset: number, cursor?: string): string {
  return `${limit}|${offset}|${cursor || ''}`;
}

// ═══════════════════════════════════════════════════════════════
// REQUEST HANDLING
// ═══════════════════════════════════════════════════════════════

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }

  // Set CORS headers for all responses
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  try {
    if (req.method === 'GET' && url.pathname === '/api/posting-rules-guide') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ coach: POSTING_RULES_COACH, installation: RULES_INSTALL_GUIDANCE }));
      return;
    }
    if (url.pathname === '/api/posting-rules') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      try {
        if (!['GET', 'POST'].includes(req.method || '')) throw new PostingRulesError('Use GET or POST.', 405);
        // Never accept a key in a URL, or a handle supplied by the caller.
        const key = req.headers.authorization?.replace(/^Bearer /i, '');
        const user = key && isValidSecretKey(key) ? await storage.getUserByKeyHash(hashSecretKey(key)) : null;
        if (!user) throw new PostingRulesError('Sign in with your Router key and claim a handle first.', 401);
        const rules = req.method === 'POST' ? await savePersonalRules(user, JSON.parse(await readBody(req, 65536))) : user.postingRules;
        res.writeHead(200); res.end(JSON.stringify(postingRulesView(rules)));
      } catch (err) {
        const status = err instanceof PostingRulesError ? err.status : err instanceof SyntaxError ? 400 : 503;
        res.writeHead(status); res.end(JSON.stringify({ error: err instanceof PostingRulesError ? err.message : err instanceof SyntaxError ? 'Invalid JSON.' : 'Could not load or save your rules. Please retry.' }));
      }
      return;
    }
    // These maintenance routes can delete or regenerate another author's stored
    // summaries. They require moderator identity, including when backed by TinyCloud.
    if (['POST','DELETE'].includes(req.method || '') && /^\/api\/(?:summaries|daily-summaries(?:\/\d{4}-\d{2}-\d{2})?|backfill-summaries|backfill-daily-summaries)$/.test(url.pathname)) {
      const key=req.headers.authorization?.replace(/^Bearer /i,'') || url.searchParams.get('key');
      const user=key&&isValidSecretKey(key)?await storage.getUserByKeyHash(hashSecretKey(key)):null;
      if(!user?.handle||!MODERATOR_HANDLES.has(user.handle)) {
        res.writeHead(403);res.end(JSON.stringify({error:'Moderator identity required.'}));return;
      }
    }
    // Discord commands use a bot key plus a scoped author grant, never a person's key in chat.
    if (url.pathname.startsWith('/api/discord/')) {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json');
      if (req.method !== 'POST') { res.writeHead(405); res.end(JSON.stringify({error: 'POST required.'})); return; }
      if (!discordGroupService) { res.writeHead(503); res.end(JSON.stringify({error: 'Author storage is required.'})); return; }
      try {
        const body = JSON.parse(await readBody(req, 32768));
        const result = await discordGroupService.serve(url.pathname, req.headers.authorization, body);
        res.writeHead(200); res.end(JSON.stringify(result));
      } catch (err) {
        const status = err instanceof DiscordGroupError ? err.status : err instanceof SyntaxError ? 400 : 503;
        const error = err instanceof DiscordGroupError ? err.message : err instanceof SyntaxError ? 'Invalid JSON.' : 'Private group service unavailable. Please retry.';
        res.writeHead(status); res.end(JSON.stringify({error}));
      }
      return;
    }
    // ─────────────────────────────────────────────────────────────
    // GET /api/entry/:id - Get single entry by ID (for permalinks)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && /^\/api\/entries\/[^/]+\/notice$/.test(url.pathname)) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const key = req.headers.authorization?.replace(/^Bearer /i, '');
        if (!key || !isValidSecretKey(key)) { res.writeHead(401); res.end(JSON.stringify({ error: 'Sign in to record this notice.' })); return; }
        const id = decodeURIComponent(url.pathname.split('/')[3]);
        const entry = await storage.getEntry(id);
        const user = await storage.getUserByKeyHash(hashSecretKey(key));
        if (!entry || !isEntryAuthor(entry, derivePseudonym(key), user?.handle)) { res.writeHead(404); res.end(JSON.stringify({ error: 'Entry not found.' })); return; }
        const input = JSON.parse(await readBody(req, 16384));
        if (!storage.isPending(id)) {
          if (!entry.sharingNotice?.evidence || input?.notice_id !== entry.sharingNotice.id || input?.notice_sha256 !== entry.sharingNotice.sha256) throw new SharingNoticeError('Entry is no longer pending.');
        } else storage.recordSharingNotice(id, input);
        res.writeHead(200); res.end(JSON.stringify({ receipt: sharingReceipt(entry, BASE_URL, storage.isPending(id)) }));
      } catch (err) {
        res.writeHead(err instanceof SharingNoticeError ? 409 : 400);
        res.end(JSON.stringify({ error: err instanceof SharingNoticeError ? err.message : 'Invalid notice record.' }));
      }
      return;
    }

    const entryByIdMatch = url.pathname.match(/^\/api\/entry\/([^/]+)$/);
    if (req.method === 'GET' && entryByIdMatch) {
      const entryId = decodeURIComponent(entryByIdMatch[1]);
      const secretKey = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');
      res.setHeader('Cache-Control', 'no-store');
      const entry = await storage.getEntry(entryId);

      if (!entry) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      // Check if requester is the author or a recipient
      let isAuthor = false;
      let userHandle: string | undefined;
      let userEmail: string | undefined;
      if (secretKey && isValidSecretKey(secretKey)) {
        const userPseudonym = derivePseudonym(secretKey);
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        userHandle = user?.handle;
        userEmail = user?.email;
        isAuthor = isEntryAuthor(entry, userPseudonym, user?.handle);
      }

      // Check visibility permissions (async for #channel resolution).
      // A waiting entry is private to its author until it publishes.
      const normalized = normalizeEntry(entry);
      if (isHiddenWhilePending(entryId, isAuthor)
        || !await canView(normalized, userHandle, userEmail, isAuthor, storage, new Map<string, boolean>())) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      const visibleEntry = stripHiddenContent(normalized, isAuthor);
      res.end(JSON.stringify({
        ...visibleEntry,
        contentHtml: entryHtml(visibleEntry.content),
        canDelete: isAuthor,
        ...(isAuthor ? { sharingReceipt: sharingReceipt(entry, BASE_URL, storage instanceof StagedStorage && storage.isPending(entry.id)) } : {}),
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/entry/:id/replies - Get replies to an entry
    // ─────────────────────────────────────────────────────────────
    const repliesMatch = url.pathname.match(/^\/api\/entry\/([^/]+)\/replies$/);
    if (req.method === 'GET' && repliesMatch) {
      const entryId = decodeURIComponent(repliesMatch[1]);
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const secretKey = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');
      res.setHeader('Cache-Control', 'no-store');

      // Verify parent entry exists
      const parentEntry = await storage.getEntry(entryId);
      if (!parentEntry) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      // Get user info for visibility filtering
      let userHandle: string | undefined;
      let userEmail: string | undefined;
      let userPseudonym: string | undefined;
      if (secretKey && isValidSecretKey(secretKey)) {
        userPseudonym = derivePseudonym(secretKey);
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        userHandle = user?.handle;
        userEmail = user?.email;
      }

      // A waiting parent is private to its author: don't confirm it exists
      if (isHiddenWhilePending(entryId, isEntryAuthor(parentEntry, userPseudonym, userHandle))) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      // Get replies and filter by visibility (async for #channel resolution).
      // Waiting replies are shown only to their own author.
      const allReplies = await storage.getRepliesTo(entryId, limit);
      const normalizedReplies = allReplies.map(normalizeEntry);
      const visibleReplies: JournalEntry[] = [];
      const channelAccessCache = new Map<string, boolean>();
      for (const e of normalizedReplies) {
        const isAuthor = isEntryAuthor(e, userPseudonym, userHandle);
        if (isHiddenWhilePending(e.id, isAuthor)) continue;
        if (await canView(e, userHandle, userEmail, isAuthor, storage, channelAccessCache)) {
          visibleReplies.push(e);
        }
      }

      // Strip hidden content
      const replies = visibleReplies.map(e => {
        const visible = stripHiddenContent(e, isEntryAuthor(e, userPseudonym, userHandle));
        return { ...visible, contentHtml: entryHtml(visible.content) };
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ entryId, replies, count: replies.length }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/attestation - TEE attestation info for verification
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/attestation') {
      const appId = 'db82f581256a3c9244c4d7129a67336990d08cdf';
      const gitSha = process.env.GIT_SHA || null;
      const imageDigest = process.env.IMAGE_DIGEST || null;
      // Report which secret env vars are set (from dashboard) vs missing
      // Only reports presence (boolean), never actual values
      const secretEnvVars = [
        'BASE_URL', 'FIREBASE_SERVICE_ACCOUNT_BASE64', 'ANTHROPIC_API_KEY',
        'MODERATOR_URL', 'MODERATOR_API_KEY', 'FIRECRAWL_API_KEY', 'SENDGRID_API_KEY', 'SENDGRID_FROM_EMAIL',
        'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHANNEL_ID', 'TELEGRAM_GROUP_CHAT_ID',
        'TELEGRAM_BOT_SECRET_KEY', 'TELEGRAM_BOT_HANDLE', 'TELEGRAM_POST_MODE',
        'TELEGRAM_MAX_PER_HOUR', 'TELEGRAM_COOLDOWN_MS',
      ];
      const envStatus: Record<string, boolean> = {};
      for (const name of secretEnvVars) {
        envStatus[name] = !!process.env[name];
      }

      const attestation = {
        app_id: appId,
        git_sha: gitSha,
        image_digest: imageDigest,
        source_code: 'https://github.com/jameslbarnes/teleport-router',
        trust_center: `https://trust.phala.com/app/${appId}`,
        tee_metadata: `https://${appId}-8090.dstack-pha-prod9.phala.network/`,
        env_vars: envStatus,
        env_vars_note: 'Values are injected via Phala dashboard encrypted storage. The docker-compose template (in source) uses bare variable names — no secrets are baked into the compose file or exposed in TEE metadata.',
        verification_steps: [
          'Check env_vars above — secrets are set (true) but values are never in the compose file',
          'Read docker-compose.template.yml in the source repo to confirm bare variable names',
          'Visit trust_center to verify the TDX attestation from Intel hardware',
          'Compare image_digest with the GitHub Actions build output for the git_sha commit',
        ],
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(attestation, null, 2));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/entries - List recent entries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/entries') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const cursor = url.searchParams.get('cursor') || undefined;
      const secretKey = url.searchParams.get('key');
      const followingOnly = url.searchParams.get('following') === 'true';
      const isAnonymous = !secretKey;

      // Hot path optimization: cache anonymous feed responses briefly.
      if (isAnonymous && !followingOnly && !authorLayer) {
        const cacheKey = buildAnonEntriesCacheKey(limit, offset, cursor);
        const now = Date.now();
        if (cachedAnonEntriesPage && cachedAnonEntriesPage.key === cacheKey && cachedAnonEntriesPage.expiresAt > now) {
          res.writeHead(200);
          res.end(cachedAnonEntriesPage.body);
          return;
        }
      }
      const fetchLimit = followingOnly ? Math.max(limit * 3, 60) : limit + 1;
      let entries = await storage.getEntries(fetchLimit, offset, cursor);
      const total = await getEntryCountCached(storage);
      let nextCursor = entries.length === fetchLimit
        ? encodePageCursor({ timestamp: entries[entries.length - 1].timestamp, id: entries[entries.length - 1].id })
        : null;

      // If user has a key, include their pending entries and identify user for visibility
      let authorPseudonym: string | null = null;
      let authorHandle: string | null = null;
      let authorEmail: string | undefined;
      let followedHandleSet: Set<string> | null = null;
      if (secretKey && isValidSecretKey(secretKey)) {
        authorPseudonym = derivePseudonym(secretKey);
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        authorHandle = user?.handle || null;
        authorEmail = user?.email;
        if (followingOnly && user?.following) {
          followedHandleSet = new Set(user.following.map(f => f.handle));
        }
        if (storage instanceof StagedStorage) {
          const pendingEntries = await storage.getPendingEntriesByPseudonym(authorPseudonym);
          // Merge pending entries and sort by timestamp
          entries = [...pendingEntries, ...entries].sort((a, b) => b.timestamp - a.timestamp);
        }
      }

      // Filter and process entries based on visibility (async for #channel resolution)
      const normalizedEntries = entries.map(normalizeEntry);
      let visibleEntries: JournalEntry[] = [];
      const channelAccessCache = new Map<string, boolean>();
      for (const e of normalizedEntries) {
        const isAuthor = e.pseudonym === authorPseudonym || e.handle === authorHandle;
        if (await canView(e, authorHandle || undefined, authorEmail, isAuthor, storage, channelAccessCache)) {
          visibleEntries.push(e);
        }
      }

      // Filter to followed users only if requested
      if (followingOnly && followedHandleSet) {
        visibleEntries = visibleEntries
          .filter(e => e.handle && followedHandleSet!.has(e.handle))
          .slice(0, limit);
      } else {
        visibleEntries = visibleEntries.slice(0, limit);
      }

      // Strip content from hidden entries (except for author's own entries)
      const strippedEntries = visibleEntries.map(e => {
        const isAuthor = e.pseudonym === authorPseudonym || e.handle === authorHandle;
        return stripHiddenContent(e, isAuthor);
      });

      const body = JSON.stringify({ entries: strippedEntries, total, limit, offset, nextCursor });
      if (isAnonymous && !followingOnly && !authorLayer) {
        cachedAnonEntriesPage = {
          key: buildAnonEntriesCacheKey(limit, offset, cursor),
          body,
          expiresAt: Date.now() + ANON_ENTRIES_CACHE_TTL_MS,
        };
      }
      res.writeHead(200);
      res.end(body);
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/following - List followed users with notes + profile info
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/following') {
      const secretKey = url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(secretKey);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const following = user.following || [];

      // Enrich with profile info
      const enriched = await Promise.all(following.map(async (f) => {
        const targetUser = await storage.getUser(f.handle);
        return {
          handle: f.handle,
          note: f.note,
          displayName: targetUser?.displayName || null,
          bio: targetUser?.bio || null,
        };
      }));

      res.writeHead(200);
      res.end(JSON.stringify({ following: enriched }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/follow - Follow a user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/follow') {
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; handle?: string; note?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { secret_key, handle: targetHandle, note } = parsed;

      if (!secret_key || !isValidSecretKey(secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      if (!targetHandle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Handle is required' }));
        return;
      }

      const normalizedHandle = targetHandle.replace(/^@/, '').toLowerCase();
      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      if (normalizedHandle === user.handle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Cannot follow yourself' }));
        return;
      }

      const following = user.following || [];
      if (following.some(f => f.handle === normalizedHandle)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Already following this user' }));
        return;
      }

      const targetUser = await storage.getUser(normalizedHandle);
      if (!targetUser) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      const followNote = note || targetUser.bio || `Followed on ${new Date().toISOString().split('T')[0]}`;
      const updatedFollowing = [...following, { handle: normalizedHandle, note: followNote }];
      await storage.updateUser(user.handle, { following: updatedFollowing });

      // Send follow notification email to the target user
      try {
        await notificationService.notifyNewFollower?.(user, targetUser);
      } catch (err) {
        console.error(`[Follow] Failed to send notification:`, err);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, following: { handle: normalizedHandle, note: followNote } }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/unfollow - Unfollow a user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/unfollow') {
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; handle?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { secret_key, handle: targetHandle } = parsed;

      if (!secret_key || !isValidSecretKey(secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      if (!targetHandle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Handle is required' }));
        return;
      }

      const normalizedHandle = targetHandle.replace(/^@/, '').toLowerCase();
      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const following = user.following || [];
      if (!following.some(f => f.handle === normalizedHandle)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not following this user' }));
        return;
      }

      const updatedFollowing = following.filter(f => f.handle !== normalizedHandle);
      await storage.updateUser(user.handle, { following: updatedFollowing });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/following/note - Update note for a followed user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/following/note') {
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; handle?: string; note?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      const { secret_key, handle: targetHandle, note: newNote } = parsed;

      if (!secret_key || !isValidSecretKey(secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      if (!targetHandle || !newNote) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Handle and note are required' }));
        return;
      }

      const normalizedHandle = targetHandle.replace(/^@/, '').toLowerCase();
      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const following = user.following || [];
      if (!following.some(f => f.handle === normalizedHandle)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Not following this user' }));
        return;
      }

      const updatedFollowing = following.map(f =>
        f.handle === normalizedHandle ? { ...f, note: newNote } : f
      );
      await storage.updateUser(user.handle, { following: updatedFollowing });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/inbox - Get entries addressed to the current user + pending queue
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/inbox') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const secretKey = url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required to view inbox' }));
        return;
      }

      const keyHash = hashSecretKey(secretKey);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first to receive addressed entries' }));
        return;
      }

      // Get entries addressed to this user
      const entries = await storage.getEntriesAddressedTo(user.handle, user.email, limit);

      // Strip hidden content (user is never the author of entries addressed TO them)
      const strippedEntries = entries.map(e => stripHiddenContent(e, false));

      // Get user's pending entries (outgoing queue)
      let pending: JournalEntry[] = [];
      if (storage instanceof StagedStorage) {
        const pseudonym = derivePseudonym(secretKey);
        pending = await storage.getPendingEntriesByPseudonym(pseudonym);
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        received: strippedEntries,
        pending,
        total: strippedEntries.length + pending.length,
        // Keep legacy field for backwards compatibility
        entries: strippedEntries,
        limit
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /delete/:id - Review before deleting; link previews must never delete.
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/delete/')) {
      const entryId = decodeURIComponent(url.pathname.slice('/delete/'.length));
      res.writeHead(303, { Location: `/e/${encodeURIComponent(entryId)}#manage`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /api/entries/:id - Delete own entry
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/entries/')) {
      const entryId = decodeURIComponent(url.pathname.slice('/api/entries/'.length));
      const secretKey = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const userPseudonym = derivePseudonym(secretKey);
      const entry = await storage.getEntry(entryId);

      if (!entry) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      if (entry.pseudonym !== userPseudonym) {
        const user = await storage.getUserByKeyHash(hashSecretKey(secretKey));
        if (!isEntryAuthor(entry, userPseudonym, user?.handle)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'You can only delete your own entries' }));
          return;
        }
      }

      await storage.deleteEntry(entryId);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/entries/:id/publish - Publish pending entry immediately
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname.match(/^\/api\/entries\/[^/]+\/publish$/)) {
      const entryId = decodeURIComponent(url.pathname.slice('/api/entries/'.length, -'/publish'.length));
      const secretKey = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const userPseudonym = derivePseudonym(secretKey);
      const entry = await storage.getEntry(entryId);

      if (!entry) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Entry not found' }));
        return;
      }

      if (entry.pseudonym !== userPseudonym) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'You can only publish your own entries' }));
        return;
      }

      // Check if entry is actually pending
      if (!(storage instanceof StagedStorage) || !storage.isPending(entryId)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Entry is not pending' }));
        return;
      }

      if (!noticeRecorded(entry)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'The sharing notice must be delivered and recorded before this post can publish.', receipt: sharingReceipt(entry, BASE_URL, true) }));
        return;
      }
      const published = await storage.publishEntry(entryId);
      if (!published) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to publish entry' }));
        return;
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, entry: published }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/entries/:identifier - Get entries by pseudonym or handle
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/api/entries/')) {
      const identifier = decodeURIComponent(url.pathname.slice('/api/entries/'.length));
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const secretKey = url.searchParams.get('key');

      // Check if user is viewing their own entries (include pending)
      let includePending = false;
      let authorPseudonym: string | null = null;
      let authorHandle: string | null = null;
      let authorEmail: string | undefined;
      if (secretKey && isValidSecretKey(secretKey)) {
        authorPseudonym = derivePseudonym(secretKey);
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        authorHandle = user?.handle || null;
        authorEmail = user?.email;
        includePending = authorPseudonym === identifier || authorHandle === identifier;
      }

      // Try as handle first, fall back to pseudonym
      let entries = await storage.getEntriesByHandle(identifier, limit);
      if (entries.length === 0) {
        entries = await storage.getEntriesByPseudonym(identifier, limit, includePending);
      }

      const visibleEntries: JournalEntry[] = [];
      const channelAccessCache = new Map<string, boolean>();
      for (const e of entries.map(normalizeEntry)) {
        const isAuthor = e.pseudonym === authorPseudonym || e.handle === authorHandle;
        if (await canView(e, authorHandle || undefined, authorEmail, isAuthor, storage, channelAccessCache)) {
          visibleEntries.push(stripHiddenContent(e, isAuthor));
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ pseudonym: identifier, entries: visibleEntries }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/entries - Create new entry (for MCP tool)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/entries') {
      const body = await readBody(req);
      const { content, secret_key, inReplyTo, to, posting_intent } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      if (!content || content.trim().length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Content cannot be empty' }));
        return;
      }

      // Validate parent entry if this is a reply
      let parentEntry: JournalEntry | null = null;
      if (inReplyTo) {
        parentEntry = await storage.getEntry(inReplyTo);
        if (!parentEntry) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Parent entry not found' }));
          return;
        }
      }

      const pseudonym = derivePseudonym(secret_key);
      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      const handle = user?.handle || undefined;

      let destinations: string[] | undefined;
      try { destinations = await postingAudience(user, posting_intent, to ?? (parentEntry?.handle ? ['@' + parentEntry.handle] : undefined)); }
      catch (err) {
        res.writeHead(err instanceof PostingRulesError ? err.status : 400);
        res.end(JSON.stringify({ error: (err as Error).message })); return;
      }

      // Auto-detect reflections by content length (500+ chars = essay/reflection)
      const isReflection = content.trim().length >= 500;

      const entryData: Omit<JournalEntry, 'id'> = {
        pseudonym,
        handle,
        client: 'desktop', // Default for REST API
        content: content.trim(),
        timestamp: Date.now(),
        isReflection: isReflection || undefined,
        to: destinations?.length ? destinations : undefined,
      };

      if (parentEntry) {
        entryData.inReplyTo = inReplyTo;
      }

      const entry = await storage.addEntry(entryData, user?.stagingDelayMs ?? STAGING_DELAY_MS);

      // Staged storage emits entry_staged through its callback. Non-staged
      // storage has no buffer, so preserve the historical dev/test events here.
      if (!(storage instanceof StagedStorage)) {
        pushEvent('entry_staged', {
          entry_id: entry.id,
          author_handle: entry.handle || null,
          author_pseudonym: entry.pseudonym,
          publish_at: entry.publishAt,
        });

        pushEvent('entry_published', {
          entry_id: entry.id,
          entry,
          author_handle: entry.handle || null,
          author_pseudonym: entry.pseudonym,
          is_reflection: entry.isReflection || false,
          ai_only: entry.aiOnly || false,
          has_recipients: !!(entry.to && entry.to.length > 0),
        });
      }

      res.writeHead(201);
      res.end(JSON.stringify({ entry, pseudonym, receipt: sharingReceipt(entry, BASE_URL, storage instanceof StagedStorage && storage.isPending(entry.id)) }));
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // CONVERSATION ENDPOINTS
    // ═══════════════════════════════════════════════════════════════

    // ─────────────────────────────────────────────────────────────
    // GET /api/conversations - List recent conversations
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/conversations') {
      const limit = parseInt(url.searchParams.get('limit') || '50');
      const offset = parseInt(url.searchParams.get('offset') || '0');
      const cursor = url.searchParams.get('cursor') || undefined;
      const secretKey = url.searchParams.get('key');

      const fetchLimit = limit * 2;
      let conversations = await storage.getConversations(fetchLimit, offset, cursor);
      const nextCursor = conversations.length === fetchLimit
        ? encodePageCursor({ timestamp: conversations[conversations.length - 1].timestamp, id: conversations[conversations.length - 1].id })
        : null;

      // If user has a key, include their pending conversations
      let authorPseudonym: string | null = null;
      if (secretKey && isValidSecretKey(secretKey)) {
        authorPseudonym = derivePseudonym(secretKey);
        if (storage instanceof StagedStorage) {
          const pendingConversations = await storage.getPendingConversationsByPseudonym(authorPseudonym);
          // Merge pending conversations and sort by timestamp
          conversations = [...pendingConversations, ...conversations].sort((a, b) => b.timestamp - a.timestamp);
        }
      }

      // Strip content from hidden conversations (except for author's own)
      const strippedConversations = conversations.map(c => {
        const isAuthor = c.pseudonym === authorPseudonym;
        return stripHiddenContent(c, isAuthor);
      }).slice(0, limit);

      res.writeHead(200);
      res.end(JSON.stringify({ conversations: strippedConversations, limit, offset, nextCursor }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/conversations - Import a conversation from share URL
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/conversations') {
      const body = await readBody(req);
      const { url: shareUrl, secret_key } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      if (!shareUrl || typeof shareUrl !== 'string') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'URL is required' }));
        return;
      }

      if (!isValidShareUrl(shareUrl)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'URL must be a valid share link from ChatGPT, Claude, Gemini, or Grok' }));
        return;
      }

      try {
        // Scrape the conversation
        const scraped = await scrapeConversation(shareUrl);

        // Generate summary
        const summary = await summarizeConversation(scraped.content, scraped.platform);

        // Tokenize content for search
        const keywords = tokenize(scraped.content + ' ' + scraped.title + ' ' + summary);

        const pseudonym = derivePseudonym(secret_key);
        const conversation = await storage.addConversation({
          pseudonym,
          sourceUrl: shareUrl,
          platform: scraped.platform,
          title: scraped.title,
          content: scraped.content,
          summary: summary || `Imported ${scraped.platform} conversation.`,
          timestamp: Date.now(),
          keywords,
          humanVisible: false, // Imports default to AI-only (humans see summary, AI can search full content)
        });

        res.writeHead(201);
        res.end(JSON.stringify({ conversation, pseudonym }));
        return;
      } catch (error) {
        if (error instanceof ScrapeError) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to import conversation' }));
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/conversations/:id - Get a single conversation
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.match(/^\/api\/conversations\/[^/]+$/)) {
      const conversationId = decodeURIComponent(url.pathname.slice('/api/conversations/'.length));
      const secretKey = url.searchParams.get('key');

      const conversation = await storage.getConversation(conversationId);

      if (!conversation) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }

      // Check if requester is the author
      let isAuthor = false;
      if (secretKey && isValidSecretKey(secretKey)) {
        const userPseudonym = derivePseudonym(secretKey);
        isAuthor = conversation.pseudonym === userPseudonym;
      }

      // Check if it's a pending conversation - only owner can view. Pending means
      // still in the buffer, even if its publish time has just passed.
      const conversationPending = storage instanceof StagedStorage
        ? storage.isConversationPending(conversationId)
        : !!conversation.publishAt && conversation.publishAt > Date.now();
      if (conversationPending) {
        if (!isAuthor) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Conversation not found' }));
          return;
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ conversation: stripHiddenContent(conversation, isAuthor) }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /api/conversations/:id - Delete own conversation
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && url.pathname.match(/^\/api\/conversations\/[^/]+$/)) {
      const conversationId = decodeURIComponent(url.pathname.slice('/api/conversations/'.length));
      const secretKey = url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const userPseudonym = derivePseudonym(secretKey);
      const conversation = await storage.getConversation(conversationId);

      if (!conversation) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }

      if (conversation.pseudonym !== userPseudonym) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'You can only delete your own conversations' }));
        return;
      }

      await storage.deleteConversation(conversationId);
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/daily-summaries - Get all daily summaries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/daily-summaries') {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(200);
        res.end(JSON.stringify({ dailySummaries: [] }));
        return;
      }

      const limit = parseInt(url.searchParams.get('limit') || '30');
      const dailySummaries = await storage.getDailySummaries(limit);

      res.writeHead(200);
      res.end(JSON.stringify({ dailySummaries }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/daily-summaries/:date/entries - Get entries for a day
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.match(/^\/api\/daily-summaries\/\d{4}-\d{2}-\d{2}\/entries$/)) {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(200);
        res.end(JSON.stringify({ entries: [], summaries: [] }));
        return;
      }

      const date = url.pathname.split('/')[3];
      const entries = (await storage.getEntriesForDate(date)).filter(isPublicNotebookEntry);

      // Also get session summaries for that day
      const allSummaries = await storage.getSummaries(200);
      const startOfDay = new Date(date + 'T00:00:00Z').getTime();
      const endOfDay = new Date(date + 'T23:59:59.999Z').getTime();
      const summaries = allSummaries.filter(s =>
        s.endTime >= startOfDay && s.endTime <= endOfDay
      );

      res.writeHead(200);
      res.end(JSON.stringify({ entries, summaries }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/daily-summaries/:date - Generate daily summary for a date
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname.match(/^\/api\/daily-summaries\/\d{4}-\d{2}-\d{2}$/)) {
      if (!anthropic || !(storage instanceof StagedStorage)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Daily summaries not enabled' }));
        return;
      }

      const date = url.pathname.split('/')[3];
      const today = getTodayDateString();

      if (date === today) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Cannot summarize today - day is still in progress' }));
        return;
      }

      const entries = (await storage.getEntriesForDate(date)).filter(isPublicNotebookEntry);
      if (entries.length === 0) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No entries for this date' }));
        return;
      }

      const content = await generateDailySummary(date, entries);
      if (!content) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to generate summary' }));
        return;
      }

      const pseudonyms = [...new Set(entries.map(e => e.pseudonym))];
      const summary = await storage.addDailySummary({
        publicOnly: true,
        date,
        content,
        timestamp: Date.now(),
        entryCount: entries.length,
        pseudonyms,
      });
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, summary }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/backfill-daily-summaries - Backfill all past days
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/backfill-daily-summaries') {
      if (!anthropic || !(storage instanceof StagedStorage)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Daily summaries not enabled' }));
        return;
      }

      // Get all entries to find date range
      const allEntries = (await storage.getEntries(1000)).filter(isPublicNotebookEntry);
      if (allEntries.length === 0) {
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, results: [] }));
        return;
      }

      // Find all unique dates (except today)
      const today = getTodayDateString();
      const dates = new Set<string>();
      for (const entry of allEntries) {
        const date = formatDateString(new Date(entry.timestamp));
        if (date !== today) {
          dates.add(date);
        }
      }

      const results: { date: string; entryCount: number; created: boolean }[] = [];

      for (const date of Array.from(dates).sort()) {
        // Check if we already have a summary for this date
        const existing = await storage.getDailySummary(date);
        if (existing) {
          results.push({ date, entryCount: 0, created: false });
          continue;
        }

        const entries = (await storage.getEntriesForDate(date)).filter(isPublicNotebookEntry);
        if (entries.length === 0) continue;

        try {
          const content = await generateDailySummary(date, entries);
          if (content) {
            const pseudonyms = [...new Set(entries.map(e => e.pseudonym))];
            await storage.addDailySummary({
              publicOnly: true,
              date,
              content,
              timestamp: Date.now(),
              entryCount: entries.length,
              pseudonyms,
            });
            results.push({ date, entryCount: entries.length, created: true });
          }
        } catch (err) {
          // Silently fail - TEE security
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, results }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /api/daily-summaries - Clear all daily summaries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && url.pathname === '/api/daily-summaries') {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Not available' }));
        return;
      }

      const summaries = await storage.getDailySummaries(100);
      for (const summary of summaries) {
        await storage.deleteDailySummary(summary.date);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, deleted: summaries.length }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // DELETE /api/summaries - Clear all summaries (for re-backfill)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'DELETE' && url.pathname === '/api/summaries') {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Not available' }));
        return;
      }

      const summaries = await storage.getSummaries(500);
      for (const summary of summaries) {
        await storage.deleteSummary(summary.id);
      }

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, deleted: summaries.length }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/backfill-summaries - One-time backfill of summaries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/backfill-summaries') {
      if (!anthropic || !(storage instanceof StagedStorage)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Summaries not enabled' }));
        return;
      }

      // Get all entries
      const allEntries = (await storage.getEntries(1000)).filter(isPublicNotebookEntry);

      // Group by pseudonym
      const byPseudonym = new Map<string, JournalEntry[]>();
      for (const entry of allEntries) {
        const entries = byPseudonym.get(entry.pseudonym) || [];
        entries.push(entry);
        byPseudonym.set(entry.pseudonym, entries);
      }

      const results: { pseudonym: string; sessions: number; summaries: number }[] = [];

      for (const [pseudonym, entries] of byPseudonym) {
        // Sort by timestamp ascending
        entries.sort((a, b) => a.timestamp - b.timestamp);

        // Find sessions (clusters with <30 min gaps)
        const sessions: JournalEntry[][] = [];
        let currentSession: JournalEntry[] = [];

        for (const entry of entries) {
          if (currentSession.length === 0) {
            currentSession.push(entry);
          } else {
            const lastEntry = currentSession[currentSession.length - 1];
            const gap = entry.timestamp - lastEntry.timestamp;

            if (gap > SUMMARY_GAP_MS) {
              // Gap detected - save current session and start new one
              sessions.push(currentSession);
              currentSession = [entry];
            } else {
              currentSession.push(entry);
            }
          }
        }

        // Don't add the last session - it's still "active" (no gap after it yet)
        // sessions.push(currentSession) - intentionally omitted

        // Generate summaries for each completed session
        let summariesCreated = 0;
        for (const rawSession of sessions) {
          // Exclude reflections - they're standalone essays that shouldn't be grouped
          const session = rawSession.filter(e => !e.isReflection);

          // Skip empty or single-entry sessions
          if (session.length <= 1) continue;

          // Check if we already have a summary covering this time range
          const existingSummaries = await storage.getSummaries(100);
          const alreadySummarized = existingSummaries.some(s =>
            s.pseudonym === pseudonym &&
            s.startTime <= session[0].timestamp &&
            s.endTime >= session[session.length - 1].timestamp
          );

          if (alreadySummarized) {
            continue;
          }

          // Get other entries from that day for context
          const sessionDate = new Date(session[0].timestamp);
          sessionDate.setHours(0, 0, 0, 0);
          const nextDay = sessionDate.getTime() + 24 * 60 * 60 * 1000;
          const otherEntriesToday = allEntries.filter(e =>
            e.timestamp >= sessionDate.getTime() &&
            e.timestamp < nextDay &&
            e.pseudonym !== pseudonym
          );

          try {
            const summaryContent = await generateSummary(session, otherEntriesToday);
            if (summaryContent) {
              await storage.addSummary({
                pseudonym,
                content: summaryContent,
                timestamp: Date.now(),
                entryIds: session.map(e => e.id),
                startTime: session[0].timestamp,
                endTime: session[session.length - 1].timestamp,
              });
              summariesCreated++;
            }
          } catch (err) {
            // Silently fail - TEE security
          }
        }

        results.push({ pseudonym, sessions: sessions.length, summaries: summariesCreated });
      }
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, results }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/summaries - Get all summaries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/summaries') {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(200);
        res.end(JSON.stringify({ summaries: [] }));
        return;
      }

      const limit = parseInt(url.searchParams.get('limit') || '50');
      const summaries = await storage.getSummaries(limit);

      res.writeHead(200);
      res.end(JSON.stringify({ summaries }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/summaries/:id/entries - Get entries for a summary
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.match(/^\/api\/summaries\/[^/]+\/entries$/)) {
      if (!(storage instanceof StagedStorage)) {
        res.writeHead(200);
        res.end(JSON.stringify({ entries: [] }));
        return;
      }

      const summaryId = url.pathname.split('/')[3];
      // For now, we'll get entries by looking up the summary and using its time range
      // A more efficient approach would be to query by entry IDs
      const summaries = await storage.getSummaries(100);
      const summary = summaries.find(s => s.id === summaryId);

      if (!summary) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Summary not found' }));
        return;
      }

      const entries = (await storage.getEntriesInRange(
        summary.pseudonym,
        summary.startTime,
        summary.endTime
      )).filter(isPublicNotebookEntry);

      res.writeHead(200);
      res.end(JSON.stringify({ entries }));
      return;
    }

    // ═══════════════════════════════════════════════════════════════
    // CHANNEL API ENDPOINTS
    // ═══════════════════════════════════════════════════════════════

    // GET /api/channels - List public channels (+ user's channels if secret_key provided)
    if (req.method === 'GET' && url.pathname === '/api/channels') {
      const secretKey = url.searchParams.get('secret_key');
      let userHandle: string | undefined;

      if (secretKey && isValidSecretKey(secretKey)) {
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        userHandle = user?.handle;
      }

      const publicChannels = await storage.listChannels({ joinRule: 'open' });
      let subscribedChannels: Channel[] = [];
      if (userHandle) {
        subscribedChannels = await storage.getSubscribedChannels(userHandle);
      }

      // Merge: subscribed (including private) + public not already subscribed
      const subscribedIds = new Set(subscribedChannels.map(c => c.id));
      const discoverable = publicChannels.filter(c => !subscribedIds.has(c.id));

      res.writeHead(200);
      res.end(JSON.stringify({
        subscribed: subscribedChannels.map(channelView),
        discoverable: discoverable.map(channelView),
      }));
      return;
    }

    // GET /api/channels/:id - Channel info
    // Exactly /api/channels/<id>; matching on substrings hid channels named "skills-…" or "entries-…"
    const channelInfoMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
    if (req.method === 'GET' && channelInfoMatch) {
      const channelId = decodeURIComponent(channelInfoMatch[1]);
      const channel = await storage.getChannel(channelId);

      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      // Invite-only channels: only show to members
      const channelInfoJoinRule = channel.joinRule || (channel.visibility === 'private' ? 'invite' : 'open');
      if (channelInfoJoinRule === 'invite') {
        const secretKey = url.searchParams.get('secret_key');
        if (!secretKey || !isValidSecretKey(secretKey)) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Authentication required for invite-only channels' }));
          return;
        }
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        if (!user?.handle || !channel.subscribers.some(s => s.handle === user.handle)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Not a member of this channel' }));
          return;
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify(channelView(channel)));
      return;
    }

    // POST /api/channels - Create channel
    if (req.method === 'POST' && url.pathname === '/api/channels') {
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; id?: string; name?: string; description?: string; visibility?: 'public' | 'private'; join_rule?: 'open' | 'invite'; storage?: 'router' | 'tinycloud'; tinycloud_delegation?: string };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      if (!parsed.id || !isValidChannelId(parsed.id)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid channel ID. Must be 2-30 chars, lowercase alphanumeric + hyphens.' }));
        return;
      }

      if (!parsed.name) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Channel name is required' }));
        return;
      }

      try {
        // A group whose posts live in the owner's TinyCloud space is always invite-only
        const onTinyCloud = parsed.storage === 'tinycloud';
        if (onTinyCloud && !groups) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'Groups stored on TinyCloud are not enabled on this server.' }));
          return;
        }
        let groupStoreConfig: Channel['store'];
        if (onTinyCloud) {
          groupStoreConfig = { kind: 'tinycloud', prefix: groupPrefix(parsed.id) };
          if (groups!.tinycloud) {
            const checked = await checkGroupGrant(parsed.tinycloud_delegation, groupStoreConfig.prefix);
            if ('error' in checked) {
              res.writeHead(400);
              res.end(JSON.stringify({ error: checked.error }));
              return;
            }
            groupStoreConfig.delegation = parsed.tinycloud_delegation;
            groupStoreConfig.space = checked.space;
          }
        }
        const restJoinRule = onTinyCloud ? 'invite' : parsed.join_rule || (parsed.visibility === 'private' ? 'invite' : 'open');
        const restVisibility = onTinyCloud ? 'private' : parsed.visibility || (restJoinRule === 'invite' ? 'private' : 'public');
        const channel = await storage.createChannel({
          ...(groupStoreConfig ? { store: groupStoreConfig } : {}),
          id: parsed.id,
          name: parsed.name,
          description: parsed.description,
          visibility: restVisibility, // backward compat
          joinRule: restJoinRule,
          createdBy: user.handle,
          createdAt: Date.now(),
          skills: [],
          subscribers: [{ handle: user.handle, role: 'admin', joinedAt: Date.now() }],
        });
        res.writeHead(201);
        res.end(JSON.stringify(channelView(channel)));
      } catch (err: any) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // PUT /api/channels/:id - Update channel (admin only)
    if (req.method === 'PUT' && channelInfoMatch) {
      const channelId = decodeURIComponent(channelInfoMatch[1]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; name?: string; description?: string; visibility?: 'public' | 'private' };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can update the channel' }));
        return;
      }

      const updates: Partial<Channel> = {};
      if (parsed.name) updates.name = parsed.name;
      if (parsed.description !== undefined) updates.description = parsed.description;
      if (parsed.visibility) updates.visibility = parsed.visibility;

      const updated = await storage.updateChannel(channelId, updates);
      res.writeHead(200);
      res.end(JSON.stringify(channelView(updated)));
      return;
    }

    // DELETE /api/channels/:id - Delete channel (admin only)
    if (req.method === 'DELETE' && channelInfoMatch) {
      const channelId = decodeURIComponent(channelInfoMatch[1]);
      const secretKey = url.searchParams.get('secret_key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(secretKey);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can delete the channel' }));
        return;
      }

      await storage.deleteChannel(channelId);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/channels/:id/join - Join channel
    if (req.method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/join$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; invite_token?: string };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const restJoinJoinRule = channel.joinRule || (channel.visibility === 'private' ? 'invite' : 'open');
      if (restJoinJoinRule === 'invite') {
        if (!parsed.invite_token) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Invite token required for invite-only channels' }));
          return;
        }
        try {
          await storage.useInvite(parsed.invite_token, { channelId, handle: user.handle });
        } catch (err: any) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: err.message }));
          return;
        }
      }

      await storage.addSubscriber(channelId, user.handle, 'member');

      // Sync to Matrix: join user to the channel's Matrix room
      const matrixPlatform = getPlatform('matrix') as MatrixPlatform | undefined;
      if (matrixPlatform) {
        matrixPlatform.joinUserToChannel(user.handle, channelId, channel.name).catch(err => {
          console.error(`[Channel] Failed to join ${user.handle} to Matrix room for #${channelId}:`, err);
        });
      }

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, channel }));
      return;
    }

    // POST /api/channels/:id/leave - Leave channel
    if (req.method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/leave$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      await storage.removeSubscriber(channelId, user.handle);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // POST /api/channels/:id/invite - Create invite (admin only)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/invite$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; max_uses?: number; expires_in_hours?: number };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can create invites' }));
        return;
      }

      const token = generateEntryId();
      const invite: ChannelInvite = {
        token,
        channelId,
        createdBy: user.handle,
        createdAt: Date.now(),
        expiresAt: parsed.expires_in_hours ? Date.now() + parsed.expires_in_hours * 60 * 60 * 1000 : undefined,
        maxUses: parsed.max_uses,
        uses: 0,
      };

      await storage.createInvite(invite);
      res.writeHead(201);
      res.end(JSON.stringify(invite));
      return;
    }

    // GET /api/invites/:token/resolve - Resolve invite token to channel info (no auth required)
    if (req.method === 'GET' && url.pathname.match(/^\/api\/invites\/[^/]+\/resolve$/)) {
      const token = decodeURIComponent(url.pathname.split('/')[3]);
      const invite = await storage.getInvite(token);
      if (!invite) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Invite not found' }));
        return;
      }
      if (invite.expiresAt && Date.now() > invite.expiresAt) {
        res.writeHead(410);
        res.end(JSON.stringify({ error: 'Invite has expired' }));
        return;
      }
      if (invite.maxUses && invite.uses >= invite.maxUses) {
        res.writeHead(410);
        res.end(JSON.stringify({ error: 'Invite has reached maximum uses' }));
        return;
      }
      const channel = await storage.getChannel(invite.channelId);
      res.writeHead(200);
      res.end(JSON.stringify({
        channelId: invite.channelId,
        channelName: channel?.name || invite.channelId,
        channelDescription: channel?.description || null,
      }));
      return;
    }

    // POST /api/channels/:id/invite-user - Invite specific user (admin only)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/invite-user$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; handle?: string };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const targetHandle = parsed.handle?.toLowerCase();
      if (!targetHandle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'handle is required' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can invite users directly' }));
        return;
      }

      // Check target user exists
      const targetUser = await storage.getUser(targetHandle);
      if (!targetUser) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `User @${targetHandle} not found` }));
        return;
      }

      // Check not already a member
      if (channel.subscribers.some(s => s.handle === targetHandle)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: `@${targetHandle} is already a member` }));
        return;
      }

      // Generate single-use invite token
      const token = generateEntryId();
      const invite: ChannelInvite = {
        token,
        channelId,
        createdBy: user.handle,
        createdAt: Date.now(),
        maxUses: 1,
        forHandle: targetHandle,
        uses: 0,
      };
      await storage.createInvite(invite);

      // Create addressed entry to target user
      const pseudonym = derivePseudonym(parsed.secret_key);
      const inviteUrl = `${BASE_URL}/?view=channel&id=${encodeURIComponent(channelId)}&invite=${encodeURIComponent(token)}`;
      const inviteMessage = `You've been invited to join #${channelId} by @${user.handle}.\n\nChannel: ${channel.name}${channel.description ? ' — ' + channel.description : ''}\n\nJoin link: ${inviteUrl}\n\nManual fallback: router_channels action: "join", channel_id: "${channelId}", invite_token: "${token}"`;
      const shortStagingDelay = 60 * 1000;

      await storage.addEntry({
        pseudonym,
        handle: user.handle,
        client: 'code',
        content: inviteMessage,
        timestamp: Date.now(),
        humanVisible: true,
        to: [`@${targetHandle}`],
        visibility: 'private',
      }, shortStagingDelay);

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: `Invitation sent to @${targetHandle}` }));
      return;
    }

    // Linking proves control of both independent identities. Never accept a TinyCloud private key.
    if (req.method === 'POST' && ['/api/tinycloud/challenge','/api/tinycloud/recovery','/api/tinycloud/link','/api/tinycloud/status','/api/tinycloud/refresh'].includes(url.pathname)) {
      if (!authorLayer || !authorCloud || !authorIdentity || !authorCodec) {
        res.writeHead(404); res.end(JSON.stringify({error:'Author-owned storage is not enabled.'})); return;
      }
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req,131072));
        if(!parsed || typeof parsed!=='object' || Array.isArray(parsed))throw new Error('Invalid request');
      } catch(err) {
        res.writeHead(err instanceof RangeError?413:400); res.end(JSON.stringify({error:'Invalid or oversized linking request.'})); return;
      }
      const user = typeof parsed.secret_key === 'string' && isValidSecretKey(parsed.secret_key)
        ? await storage.getUserByKeyHash(hashSecretKey(parsed.secret_key)) : null;
      if (!user) { res.writeHead(401); res.end(JSON.stringify({error:'A registered Router identity is required.'})); return; }
      res.setHeader('Cache-Control','no-store');
      if (url.pathname === '/api/tinycloud/status') {
        res.writeHead(200); res.end(JSON.stringify({...await authorLayer.status(user.handle),job:authorJobs.get(user.handle)||null})); return;
      }
      if (url.pathname === '/api/tinycloud/refresh') {
        res.writeHead(200); res.end(JSON.stringify({available:await authorLayer.refresh(user.handle)})); return;
      }
      try {
        const wire = parsed.delegation;
        if (typeof wire !== 'string') throw new Error('A serialized TinyCloud delegation is required.');
        const grant = authorCloud.inspectGrant(wire);
        if(grant.host && new URL(grant.host).origin !== new URL(authorCloud.host).origin)
          throw new Error('The grant must use this Router\'s configured TinyCloud host.');
        const match = /^tinycloud:pkh:eip155:1:(0x[a-fA-F0-9]{40}):[\w-]+$/.exec(grant.spaceId);
        if (!match) throw new Error('Expected an Ethereum-owned TinyCloud space.');
        const ownerDid = `did:pkh:eip155:1:${match[1]}`;
        if (grant.delegateDID.toLowerCase() !== authorIdentity.did.toLowerCase() || grant.path !== 'router/'
          || GROUP_GRANT_ACTIONS.some(a=>!grant.actions.includes(a)) || grant.actions.some(a=>!GROUP_GRANT_ACTIONS.includes(a))
          || !grant.expiry || !Number.isFinite(grant.expiry.getTime()) || grant.expiry.getTime() <= Date.now())
          throw new Error('The grant must cover router/ with exactly get, put, list and del for this Router, and must be unexpired.');
        const grantHash = createHash('sha256').update(wire).digest('hex');
        if (url.pathname === '/api/tinycloud/challenge') {
          for(const [handle,c] of authorChallenges) if(c.expires<Date.now()) authorChallenges.delete(handle);
          const expires=Date.now()+10*60*1000;
          const message=`Link TinyCloud to Teleport Router\nEncrypt published records in my space and enable recovery with my TinyCloud key.\nServer: ${BASE_URL}\nRouter identity: ${authorIdentity.did}\nRouter account: ${user.handle}\nOwner: ${ownerDid}\nGrant SHA-256: ${grantHash}\nNonce: ${randomUUID()}\nExpires: ${new Date(expires).toISOString()}`;
          authorChallenges.set(user.handle,{message,expires,grantHash});
          res.writeHead(200); res.end(JSON.stringify({message,expires})); return;
        }
        const challenge=authorChallenges.get(user.handle);
        if(!challenge||challenge.expires<Date.now()||challenge.grantHash!==grantHash) throw new Error('Request a fresh linking challenge.');
        const {verifyMessage,SigningKey,hashMessage}=await import('ethers');
        if(typeof parsed.signature!=='string'||verifyMessage(challenge.message,parsed.signature).toLowerCase()!==match[1].toLowerCase())
          throw new Error('The TinyCloud owner signature does not match this grant.');
        if(authorJobs.get(user.handle)?.status==='running') { res.writeHead(409); res.end(JSON.stringify({error:'Your migration is already running.'})); return; }
        const binding={ownerDid,space:grant.spaceId,prefix:grant.path,delegation:wire,pseudonym:derivePseudonym(parsed.secret_key),linkedAt:Date.now(),
          ownerPublicKey:SigningKey.recoverPublicKey(hashMessage(challenge.message),parsed.signature)};
        if (url.pathname === '/api/tinycloud/recovery') {
          challenge.recovery ??= authorCodec.createRecovery(binding,binding.ownerPublicKey);
          res.writeHead(200); res.end(JSON.stringify({recovery:challenge.recovery,message:challenge.message,
            context:{ownerDid,space:grant.spaceId,prefix:grant.path}})); return;
        }
        if (!challenge.recovery) throw new Error('Confirm owner recovery before linking. Use the current TinyCloud link client.');
        authorCodec.verifyOwnerRecovery(parsed.recovery_proof,binding,challenge.message,challenge.recovery);
        authorChallenges.delete(user.handle);
        const job={status:'running' as 'running'|'complete'|'failed',progress:'Waiting to verify and move published records.'};
        authorJobs.set(user.handle,job);
        // Serialize account links to enforce one TinyCloud identity per Router account.
        authorLinkQueue=authorLinkQueue.catch(()=>{}).then(async()=>{
          try {
            const result=await authorLayer.link(user,binding,message=>{job.progress=message;});
            Object.assign(job,{status:'complete',result,progress:'Encrypted migration verified; your TinyCloud key can recover your records independently.'});
          } catch {
            Object.assign(job,{status:'failed',error:'Migration did not complete. Existing verified data is retained; retry or inspect the storage connection.'});
          }
        });
        res.writeHead(202); res.end(JSON.stringify({status:'running',handle:user.handle})); return;
      } catch(err) {
        res.writeHead(400); res.end(JSON.stringify({error:err instanceof Error ? err.message : 'Invalid TinyCloud linking request.'})); return;
      }
    }

    // GET /api/tinycloud/router - the identity an author or group owner grants access to
    if (req.method === 'GET' && url.pathname === '/api/tinycloud/router') {
      if (authorIdentity && authorCloud) {
        res.writeHead(200,{'Cache-Control':'no-store'});
        res.end(JSON.stringify({did:authorIdentity.did,host:authorCloud.host,folder:'router/',actions:GROUP_GRANT_ACTIONS,
          mode:'authors',keySource:authorIdentity.source,revocationWindowSeconds:60,recordEncryption:'aes-256-gcm-v2',ownerRecovery:'secp256k1-v1',recoveryConfirmationRequired:true})); return;
      }
      if (!groups?.tinycloud) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'TinyCloud groups are not enabled on this server.' }));
        return;
      }
      const tc = await groups.tinycloud();
      res.writeHead(200);
      res.end(JSON.stringify({ did: await tc.routerDid(), host: tc.host, folder: 'groups/<channel-id>/', actions: GROUP_GRANT_ACTIONS }));
      return;
    }

    // GET /api/channels/:id/entries - Get channel entries
    if (req.method === 'GET' && url.pathname.match(/^\/api\/channels\/[^/]+\/entries$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const limit = parseInt(url.searchParams.get('limit') || '50');

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      // Invite-only channels: check membership
      const channelJoinRuleForEntries = channel.joinRule || (channel.visibility === 'private' ? 'invite' : 'open');
      if (channelJoinRuleForEntries === 'invite') {
        const secretKey = url.searchParams.get('secret_key');
        if (!secretKey || !isValidSecretKey(secretKey)) {
          res.writeHead(401);
          res.end(JSON.stringify({ error: 'Authentication required for invite-only channels' }));
          return;
        }
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        if (!user?.handle || !channel.subscribers.some(s => s.handle === user.handle)) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Not a member of this channel' }));
          return;
        }
      }

      // Waiting entries stay private to their author until they publish
      const viewerKey = url.searchParams.get('secret_key');
      const hasViewerKey = !!viewerKey && isValidSecretKey(viewerKey);
      const viewerPseudonym = hasViewerKey ? derivePseudonym(viewerKey!) : undefined;
      const viewerHandle = hasViewerKey ? (await storage.getUserByKeyHash(hashSecretKey(viewerKey!)))?.handle : undefined;
      let channelEntries: JournalEntry[];
      try {
        channelEntries = await storage.getChannelEntries(channelId, limit);
      } catch (err) {
        if (!(err instanceof GroupStoreRevokedError)) throw err;
        res.writeHead(410);
        res.end(JSON.stringify({ error: err.message, revoked: true }));
        return;
      }
      const entries = channelEntries
        .filter(e => !isHiddenWhilePending(e.id, isEntryAuthor(e, viewerPseudonym, viewerHandle)));
      res.writeHead(200);
      res.end(JSON.stringify({ entries }));
      return;
    }

    // POST /api/channels/:id/skills - Add skill to channel (admin only)
    if (req.method === 'POST' && url.pathname.match(/^\/api\/channels\/[^/]+\/skills$/)) {
      const channelId = decodeURIComponent(url.pathname.split('/')[3]);
      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; name?: string; description?: string; instructions?: string; parameters?: any[] };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can add skills' }));
        return;
      }

      if (!parsed.name || !/^[a-z0-9-]+$/.test(parsed.name)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Skill name required (lowercase alphanumeric + hyphens)' }));
        return;
      }

      if (channel.skills.some(s => s.name === parsed.name)) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: `Skill "${parsed.name}" already exists in this channel` }));
        return;
      }

      const newSkill: Skill = {
        id: `${channelId}_${parsed.name}`,
        name: parsed.name,
        description: parsed.description || '',
        instructions: parsed.instructions || '',
        parameters: parsed.parameters,
        handlerType: 'instructions',
        createdAt: Date.now(),
      };

      channel.skills.push(newSkill);
      await storage.updateChannel(channelId, { skills: channel.skills });

      res.writeHead(201);
      res.end(JSON.stringify(newSkill));
      return;
    }

    // PUT /api/channels/:id/skills/:name - Update channel skill (admin only)
    if (req.method === 'PUT' && url.pathname.match(/^\/api\/channels\/[^/]+\/skills\/[^/]+$/)) {
      const parts = url.pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const skillName = decodeURIComponent(parts[5]);

      const body = await new Promise<string>((resolve) => {
        let data = '';
        req.on('data', chunk => data += chunk);
        req.on('end', () => resolve(data));
      });

      let parsed: { secret_key?: string; description?: string; instructions?: string; parameters?: any[] };
      try { parsed = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }

      if (!parsed.secret_key || !isValidSecretKey(parsed.secret_key)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(parsed.secret_key);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can update skills' }));
        return;
      }

      const skillIndex = channel.skills.findIndex(s => s.name === skillName);
      if (skillIndex === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Skill "${skillName}" not found` }));
        return;
      }

      if (parsed.description !== undefined) channel.skills[skillIndex].description = parsed.description;
      if (parsed.instructions !== undefined) channel.skills[skillIndex].instructions = parsed.instructions;
      if (parsed.parameters !== undefined) channel.skills[skillIndex].parameters = parsed.parameters;
      channel.skills[skillIndex].updatedAt = Date.now();

      await storage.updateChannel(channelId, { skills: channel.skills });

      res.writeHead(200);
      res.end(JSON.stringify(channel.skills[skillIndex]));
      return;
    }

    // DELETE /api/channels/:id/skills/:name - Remove channel skill (admin only)
    if (req.method === 'DELETE' && url.pathname.match(/^\/api\/channels\/[^/]+\/skills\/[^/]+$/)) {
      const parts = url.pathname.split('/');
      const channelId = decodeURIComponent(parts[3]);
      const skillName = decodeURIComponent(parts[5]);
      const secretKey = url.searchParams.get('secret_key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const keyHash = hashSecretKey(secretKey);
      const user = await storage.getUserByKeyHash(keyHash);
      if (!user?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Claim a handle first' }));
        return;
      }

      const channel = await storage.getChannel(channelId);
      if (!channel) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Channel not found' }));
        return;
      }

      const sub = channel.subscribers.find(s => s.handle === user.handle);
      if (!sub || sub.role !== 'admin') {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Only admins can remove skills' }));
        return;
      }

      const skillIndex = channel.skills.findIndex(s => s.name === skillName);
      if (skillIndex === -1) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: `Skill "${skillName}" not found` }));
        return;
      }

      channel.skills.splice(skillIndex, 1);
      await storage.updateChannel(channelId, { skills: channel.skills });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/generate - Generate new identity key
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/generate') {
      const secretKey = generateSecretKey();
      const pseudonym = derivePseudonym(secretKey);

      res.writeHead(200);
      res.end(JSON.stringify({
        secret_key: secretKey,
        pseudonym,
        warning: 'Save this key securely. If lost, this identity cannot be recovered.',
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/lookup - Get pseudonym and handle for a key
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/lookup') {
      const body = await readBody(req);
      const { secret_key } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      const pseudonym = derivePseudonym(secret_key);
      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      res.writeHead(200);
      res.end(JSON.stringify({
        pseudonym,
        handle: user?.handle || null,
        displayName: user?.displayName || null,
        email: user?.email || null,
        emailVerified: user?.emailVerified || false,
        stagingDelayMs: user?.stagingDelayMs ?? null,
        defaultHumanVisible: user?.defaultHumanVisible ?? true,
        legacyPseudonym: user?.legacyPseudonym || null,
        hasAccount: !!user,
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/identity/check/:handle - Check if handle is available
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.startsWith('/api/identity/check/')) {
      const handle = normalizeHandle(url.pathname.split('/').pop() || '');

      if (!isValidHandle(handle)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'Invalid handle format. Use 3-15 lowercase letters, numbers, and underscores. Must start with a letter.',
          available: false,
        }));
        return;
      }

      const available = await storage.isHandleAvailable(handle);

      res.writeHead(200);
      res.end(JSON.stringify({ handle, available }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/register - Register new handle for new user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/register') {
      const body = await readBody(req);
      const { secret_key, handle: rawHandle, displayName, pronouns, bio, email } = JSON.parse(body);

      // Validate secret key
      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      // Normalize and validate handle
      const handle = normalizeHandle(rawHandle || '');
      if (!isValidHandle(handle)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'Invalid handle format. Use 3-15 lowercase letters, numbers, and underscores. Must start with a letter.',
        }));
        return;
      }

      const keyHash = hashSecretKey(secret_key);

      // Check if this key already has an account
      const existingUser = await storage.getUserByKeyHash(keyHash);
      if (existingUser) {
        res.writeHead(409);
        res.end(JSON.stringify({
          error: 'This key already has an account',
          handle: existingUser.handle,
        }));
        return;
      }

      // Check if handle is available
      if (!(await storage.isHandleAvailable(handle))) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Handle is already taken' }));
        return;
      }

      // Create user
      const user = await storage.createUser({
        handle,
        secretKeyHash: keyHash,
        displayName: displayName || undefined,
        bio: bio || undefined,
        email: email || undefined,
      });

      const pseudonym = derivePseudonym(secret_key);

      res.writeHead(201);
      res.end(JSON.stringify({
        handle: user.handle,
        displayName: user.displayName,
        pseudonym,
        message: 'Account created successfully',
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/link-platform - Link a platform account to Router identity
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/link-platform') {
      const body = await readBody(req);
      const { secret_key, platform, platform_user_id } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      if (!platform || !platform_user_id) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'platform and platform_user_id are required' }));
        return;
      }

      const linkKeyHash = hashSecretKey(secret_key);
      const linkUser = await storage.getUserByKeyHash(linkKeyHash);
      if (!linkUser?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Account required. Register a handle first.' }));
        return;
      }

      // Add or update the linked account
      const existingAccounts = linkUser.linkedAccounts || [];
      const existingIndex = existingAccounts.findIndex(
        a => a.platform === platform && a.platformUserId === platform_user_id
      );

      const newAccount = {
        platform,
        platformUserId: platform_user_id,
        linkedAt: Date.now(),
        verified: false,
      };

      if (existingIndex >= 0) {
        existingAccounts[existingIndex] = newAccount;
      } else {
        existingAccounts.push(newAccount);
      }

      await storage.updateUser(linkUser.handle, { linkedAccounts: existingAccounts });

      res.writeHead(200);
      res.end(JSON.stringify({
        ok: true,
        handle: linkUser.handle,
        linkedAccounts: existingAccounts,
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/profile/:handle - Get user profile
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname.match(/^\/api\/profile\/[^/]+$/)) {
      const profileHandle = decodeURIComponent(url.pathname.split('/')[3]);
      try {
        const profileUser = await storage.getUser(profileHandle);
        if (!profileUser) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'User not found' }));
          return;
        }

        // Only return linkedAccounts if the requester IS this user (auth via ?key=)
        const requesterKey = url.searchParams.get('key');
        let isOwnProfile = false;
        if (requesterKey && isValidSecretKey(requesterKey)) {
          const requester = await storage.getUserByKeyHash(hashSecretKey(requesterKey));
          isOwnProfile = requester?.handle === profileUser.handle;
        }

        res.writeHead(200);
        res.end(JSON.stringify({
          handle: profileUser.handle,
          displayName: profileUser.displayName,
          bio: profileUser.bio,
          links: profileUser.links,
          pronouns: profileUser.pronouns,
          createdAt: profileUser.createdAt,
          // linkedAccounts are private — only visible to the profile owner
          ...(isOwnProfile ? { linkedAccounts: profileUser.linkedAccounts || [] } : {}),
        }));
        return;
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: err.message }));
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/sparks - Get potential introductions for the authenticated user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/sparks') {
      const secretKey = url.searchParams.get('key');
      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid key required' }));
        return;
      }

      const sparksKeyHash = hashSecretKey(secretKey);
      const sparksUser = await storage.getUserByKeyHash(sparksKeyHash);
      if (!sparksUser?.handle) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Account required' }));
        return;
      }

      try {
        const { detectSparks } = await import('./intelligence/sparks.js');
        const { getConnectionInfo } = await import('./intelligence/sparks.js');
        const userEntries = (await publishedStorage.getEntriesByHandle(sparksUser.handle, 50)).filter(hasPublicAudience);
        const sparks: any[] = [];

        for (const entry of userEntries.slice(0, 3)) {
          const candidates = await detectSparks(entry, publishedStorage);
          for (const candidate of candidates.slice(0, 3)) {
            const connInfo = await getConnectionInfo(sparksUser.handle, candidate.handle, getAllPlatforms(), storage);
            sparks.push({
              sourceHandle: sparksUser.handle,
              targetHandle: candidate.handle,
              overlapTopics: candidate.overlapTopics,
              matchingEntries: candidate.matchingEntries.map(e => ({
                id: e.id,
                author: e.handle || e.pseudonym,
                content: e.content.substring(0, 200),
                timestamp: e.timestamp,
              })),
              sourceEntry: {
                id: entry.id,
                content: entry.content.substring(0, 200),
                timestamp: entry.timestamp,
              },
              isConnected: connInfo.isConnected,
              sharedRooms: connInfo.sharedRoomIds.length,
            });
          }
        }

        // Deduplicate by target handle
        const seen = new Set<string>();
        const uniqueSparks = sparks.filter(s => {
          if (seen.has(s.targetHandle)) return false;
          seen.add(s.targetHandle);
          return true;
        });

        res.writeHead(200);
        res.end(JSON.stringify({ sparks: uniqueSparks }));
        return;
      } catch (err: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Spark detection failed', detail: err.message }));
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/matrix/provision - Provision Matrix account from Router key
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/matrix/provision') {
      const matrixServerUrl = process.env.MATRIX_SERVER_URL || 'http://localhost:8008';
      const matrixServerName = process.env.MATRIX_SERVER_NAME || 'localhost';
      const matrixRegistrationToken = process.env.MATRIX_REGISTRATION_TOKEN || 'router-dev-token';

      const body = await readBody(req);
      const { secret_key } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No Router account found for this key. Register first.' }));
        return;
      }

      const matrixUsername = user.handle;
      // Derive a deterministic password from the key so the same key always works
      const crypto = await import('crypto');
      const matrixPassword = crypto.createHmac('sha256', secret_key)
        .update(`matrix:${matrixServerName}`)
        .digest('base64url');

      // Try logging in first (account may already exist)
      try {
        const loginResp = await fetch(`${matrixServerUrl}/_matrix/client/v3/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: matrixUsername },
            password: matrixPassword,
          }),
        });

        if (loginResp.ok) {
          const loginData = await loginResp.json() as any;
          res.writeHead(200);
          res.end(JSON.stringify({
            user_id: loginData.user_id,
            access_token: loginData.access_token,
            device_id: loginData.device_id,
            homeserver_url: matrixServerUrl,
            server_name: matrixServerName,
          }));
          return;
        }
      } catch (e) {
        // Login failed, try registration below
      }

      // Account doesn't exist yet — register it
      try {
        // Step 1: initiate registration to get session
        const initResp = await fetch(`${matrixServerUrl}/_matrix/client/v3/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: matrixUsername,
            password: matrixPassword,
          }),
        });

        const initData = await initResp.json() as any;
        const session = initData.session;

        if (!session) {
          res.writeHead(502);
          res.end(JSON.stringify({ error: 'Matrix server did not return a session' }));
          return;
        }

        // Step 2: complete registration with token
        const regResp = await fetch(`${matrixServerUrl}/_matrix/client/v3/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: matrixUsername,
            password: matrixPassword,
            auth: {
              type: 'm.login.registration_token',
              token: matrixRegistrationToken,
              session,
            },
          }),
        });

        if (!regResp.ok) {
          const errData = await regResp.json() as any;
          res.writeHead(502);
          res.end(JSON.stringify({
            error: 'Matrix registration failed',
            detail: errData.error || errData.errcode,
          }));
          return;
        }

        const regData = await regResp.json() as any;

        // Always set display name to override Continuwuity's default
        if (regData.access_token) {
          try {
            await fetch(`${matrixServerUrl}/_matrix/client/v3/profile/${regData.user_id}/displayname`, {
              method: 'PUT',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${regData.access_token}`,
              },
              body: JSON.stringify({ displayname: user.displayName || user.handle }),
            });
          } catch {
            // Non-fatal
          }
        }

        res.writeHead(201);
        res.end(JSON.stringify({
          user_id: regData.user_id,
          access_token: regData.access_token,
          device_id: regData.device_id,
          homeserver_url: matrixServerUrl,
          server_name: matrixServerName,
        }));
        return;
      } catch (e: any) {
        res.writeHead(502);
        res.end(JSON.stringify({ error: 'Failed to connect to Matrix server', detail: e.message }));
        return;
      }
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/claim - Claim handle for existing pseudonym (migrate)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/claim') {
      const body = await readBody(req);
      const { secret_key, handle: rawHandle, displayName, bio, email } = JSON.parse(body);

      // Validate secret key
      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      // Normalize and validate handle
      const handle = normalizeHandle(rawHandle || '');
      if (!isValidHandle(handle)) {
        res.writeHead(400);
        res.end(JSON.stringify({
          error: 'Invalid handle format. Use 3-15 lowercase letters, numbers, and underscores. Must start with a letter.',
        }));
        return;
      }

      const keyHash = hashSecretKey(secret_key);
      const pseudonym = derivePseudonym(secret_key);

      // Check if this key already has an account
      const existingUser = await storage.getUserByKeyHash(keyHash);
      if (existingUser) {
        res.writeHead(409);
        res.end(JSON.stringify({
          error: 'This key already has an account',
          handle: existingUser.handle,
        }));
        return;
      }

      // Check if handle is available
      if (!(await storage.isHandleAvailable(handle))) {
        res.writeHead(409);
        res.end(JSON.stringify({ error: 'Handle is already taken' }));
        return;
      }

      // Create user with legacy pseudonym
      const user = await storage.createUser({
        handle,
        secretKeyHash: keyHash,
        displayName: displayName || undefined,
        bio: bio || undefined,
        email: email || undefined,
        legacyPseudonym: pseudonym,
      });

      // Migrate existing entries to the new handle
      console.log(`[Migration] Starting migration for ${pseudonym} -> @${handle}`);
      const migratedCount = await storage.migrateEntriesToHandle(pseudonym, handle);
      console.log(`[Migration] Completed: ${migratedCount} entries migrated for @${handle}`);

      res.writeHead(201);
      res.end(JSON.stringify({
        handle: user.handle,
        displayName: user.displayName,
        legacyPseudonym: pseudonym,
        migratedEntries: migratedCount,
        message: `Account created and ${migratedCount} entries migrated`,
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/update - Update profile (bio, displayName, links, stagingDelayMs, defaultHumanVisible)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/update') {
      const body = await readBody(req);
      const { secret_key, displayName, bio, links, stagingDelayMs, defaultHumanVisible } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No account found for this key. Claim a handle first.' }));
        return;
      }

      // Validate stagingDelayMs if provided (min 1 hour, max 1 month)
      if (stagingDelayMs !== undefined) {
        const delay = Number(stagingDelayMs);
        const oneHour = 60 * 60 * 1000;
        const oneMonth = 30 * 24 * 60 * 60 * 1000;
        if (isNaN(delay) || delay < oneHour || delay > oneMonth) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: 'stagingDelayMs must be between 3600000 (1 hour) and 2592000000 (1 month)' }));
          return;
        }
      }

      // Build update object with only provided fields
      const updates: Partial<{ displayName: string; bio: string; links: string[]; stagingDelayMs: number; defaultHumanVisible: boolean }> = {};
      if (displayName !== undefined) updates.displayName = displayName;
      if (bio !== undefined) updates.bio = bio;
      if (links !== undefined) updates.links = links;
      if (stagingDelayMs !== undefined) updates.stagingDelayMs = Number(stagingDelayMs);
      if (defaultHumanVisible !== undefined) updates.defaultHumanVisible = Boolean(defaultHumanVisible);

      const updated = await storage.updateUser(user.handle, updates);

      res.writeHead(200);
      res.end(JSON.stringify({
        handle: updated?.handle,
        displayName: updated?.displayName,
        bio: updated?.bio,
        links: updated?.links,
        stagingDelayMs: updated?.stagingDelayMs,
        defaultHumanVisible: updated?.defaultHumanVisible,
        message: 'Profile updated',
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/identity/migrate - Re-run entry migration to handle
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/identity/migrate') {
      const body = await readBody(req);
      const { secret_key } = JSON.parse(body);

      if (!isValidSecretKey(secret_key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid identity key' }));
        return;
      }

      const keyHash = hashSecretKey(secret_key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'No account found. Claim a handle first.' }));
        return;
      }

      if (!user.legacyPseudonym) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'No legacy pseudonym to migrate from' }));
        return;
      }

      const migratedCount = await storage.migrateEntriesToHandle(user.legacyPseudonym, user.handle);

      res.writeHead(200);
      res.end(JSON.stringify({
        handle: user.handle,
        legacyPseudonym: user.legacyPseudonym,
        migratedEntries: migratedCount,
        message: `${migratedCount} entries migrated to @${user.handle}`,
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/unsubscribe - Handle unsubscribe from email notifications
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/unsubscribe') {
      const token = url.searchParams.get('token');
      const type = url.searchParams.get('type') as 'comments' | 'digest' | null;

      if (!token || !type) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Token and type required' }));
        return;
      }

      const jwtSecret = process.env.JWT_SECRET || 'router-default-secret-change-in-production';
      const decoded = verifyUnsubscribeToken(token, jwtSecret);

      if (!decoded) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid or expired unsubscribe link' }));
        return;
      }

      // Update user's email preferences
      const user = await storage.getUser(decoded.handle);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      const currentPrefs = user.emailPrefs || { comments: true, digest: true };
      const newPrefs = { ...currentPrefs, [type]: false };

      await storage.updateUser(decoded.handle, { emailPrefs: newPrefs });

      // Redirect to unsubscribe confirmation page
      res.writeHead(302, { Location: `/unsubscribe.html?type=${type}` });
      res.end();
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/send-verification - Send email verification
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/send-verification') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      await new Promise<void>(resolve => req.on('end', resolve));

      const { key, email } = JSON.parse(body);

      if (!key || !email) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Key and email required' }));
        return;
      }

      // Validate the key and get the user
      if (!isValidSecretKey(key)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid secret key' }));
        return;
      }

      const keyHash = await hashSecretKey(key);
      const user = await storage.getUserByKeyHash(keyHash);

      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      // Basic email validation
      if (!email.includes('@') || email.length < 5) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid email address' }));
        return;
      }

      // Store the pending email (unverified)
      await storage.updateUser(user.handle, {
        email,
        emailVerified: false
      });

      // Send verification email
      const sent = await notificationService.sendVerificationEmail(user.handle, email);

      if (sent) {
        res.writeHead(200);
        res.end(JSON.stringify({
          success: true,
          message: 'Verification email sent. Check your inbox.'
        }));
      } else {
        res.writeHead(500);
        res.end(JSON.stringify({
          error: 'Failed to send verification email. Please try again.'
        }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/verify-email - Handle email verification link
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/verify-email') {
      const token = url.searchParams.get('token');

      if (!token) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Verification token required' }));
        return;
      }

      const jwtSecret = process.env.JWT_SECRET || 'router-default-secret-change-in-production';
      const decoded = verifyEmailToken(token, jwtSecret);

      if (!decoded) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid or expired verification link' }));
        return;
      }

      // Verify the user exists and the email matches
      const user = await storage.getUser(decoded.handle);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      // Check if the pending email matches
      if (user.email !== decoded.email) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Email address has changed. Please request a new verification email.' }));
        return;
      }

      // Mark email as verified
      await storage.updateUser(decoded.handle, { emailVerified: true });

      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        handle: decoded.handle,
        email: decoded.email
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/trigger-digest - Manually trigger daily digest (for testing)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/trigger-digest') {
      console.log('[Digest] Manual trigger requested');
      const result = await notificationService.sendDailyDigests();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/test-digest?handle=james - Send test digest to a specific user
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/test-digest') {
      const handle = url.searchParams.get('handle');
      if (!handle) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'handle query parameter required' }));
        return;
      }
      console.log(`[Digest] Test digest requested for @${handle}`);
      const result = await notificationService.sendTestDigest(handle);
      if (!result) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Could not generate digest (user not found or Claude failed)' }));
        return;
      }
      // Return the HTML so it can be previewed
      const preview = url.searchParams.get('preview') === 'true';
      if (preview) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(result.html);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, subject: result.subject, htmlLength: result.html.length }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/trigger-personalized-digest?key=...&handle=james
    // Trigger a Matrix personalized digest DM for the authenticated user.
    // Moderators may specify another handle.
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/trigger-personalized-digest') {
      const secretKey = url.searchParams.get('key');
      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid key query parameter required' }));
        return;
      }

      const requester = await storage.getUserByKeyHash(hashSecretKey(secretKey));
      if (!requester?.handle) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Account required. Register a handle first.' }));
        return;
      }

      const requestedHandle = url.searchParams.get('handle')?.replace(/^@/, '').trim().toLowerCase();
      const targetHandle = requestedHandle || requester.handle;
      const isModerator = MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requester.handle);

      if (targetHandle !== requester.handle && !isModerator) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only moderators can trigger another user’s digest.' }));
        return;
      }

      console.log(`[Digest] Personalized Matrix digest trigger requested by @${requester.handle} for @${targetHandle}`);
      const result = await sendPersonalizedDigests(storage, { handles: [targetHandle], force: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, targetHandle, ...result }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /api/trigger-global-digest?key=...&date=YYYY-MM-DD
    // Trigger the Matrix #digest global notebook digest.
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/trigger-global-digest') {
      const secretKey = url.searchParams.get('key');
      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid key query parameter required' }));
        return;
      }

      const requester = await storage.getUserByKeyHash(hashSecretKey(secretKey));
      const isModerator = !!requester?.handle && (MODERATOR_HANDLES.size === 0 || MODERATOR_HANDLES.has(requester.handle));
      if (!isModerator) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Only moderators can trigger the global digest.' }));
        return;
      }

      const date = url.searchParams.get('date')?.trim();
      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'date must be YYYY-MM-DD.' }));
        return;
      }

      console.log(`[Digest] Global Matrix digest trigger requested by @${requester.handle}${date ? ` for ${date}` : ''}`);
      const result = await generateDailyDigest(storage, date ? { date } : undefined);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, ...result }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/users/search?q=prefix - Search users for @mention typeahead
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/users/search') {
      const query = url.searchParams.get('q') || '';
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '10', 10), 20);

      if (query.length < 1) {
        res.writeHead(200);
        res.end(JSON.stringify({ users: [] }));
        return;
      }

      const users = await storage.searchUsers(query, limit);
      res.writeHead(200);
      res.end(JSON.stringify({
        users: users.map(u => ({
          handle: u.handle,
          displayName: u.displayName,
        }))
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/users/:handle - Get public profile
    // ─────────────────────────────────────────────────────────────
    const userProfileMatch = url.pathname.match(/^\/api\/users\/([^/]+)$/);
    if (req.method === 'GET' && userProfileMatch) {
      const handle = normalizeHandle(userProfileMatch[1]);

      if (!handle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Handle required' }));
        return;
      }

      const user = await storage.getUser(handle);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      // Get recent entries
      const entries = (await storage.getEntriesByHandle(handle, 10)).filter(isPublicNotebookEntry);

      res.writeHead(200);
      res.end(JSON.stringify({
        handle: user.handle,
        displayName: user.displayName,
        bio: user.bio,
        links: user.links,
        createdAt: user.createdAt,
        legacyPseudonym: user.legacyPseudonym,
        recentEntries: entries.map(e => ({
          id: e.id,
          content: e.content,
          timestamp: e.timestamp,
          isReflection: e.isReflection,
        })),
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/users/:handle/entries - Get all entries by handle
    // ─────────────────────────────────────────────────────────────
    const entriesByHandleMatch = url.pathname.match(/^\/api\/users\/([^/]+)\/entries$/);
    if (req.method === 'GET' && entriesByHandleMatch) {
      const handle = normalizeHandle(entriesByHandleMatch[1]);
      const limit = parseInt(url.searchParams.get('limit') || '100', 10);

      if (!handle) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Handle required' }));
        return;
      }

      const user = await storage.getUser(handle);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }

      // Fetch entries by handle AND by legacy pseudonym (if they have one)
      let entries: JournalEntry[] = [];
      try {
        entries = await storage.getEntriesByHandle(handle, limit);
      } catch (e) {
        // Index might not exist yet, continue with pseudonym lookup
        console.error('getEntriesByHandle failed:', e);
      }

      // Also fetch by legacy pseudonym and merge
      if (user.legacyPseudonym) {
        const pseudonymEntries = await storage.getEntriesByPseudonym(user.legacyPseudonym, limit);
        // Merge, dedupe by id, sort by timestamp desc
        const allEntries = [...entries, ...pseudonymEntries];
        const seen = new Set<string>();
        entries = allEntries
          .filter(e => {
            if (seen.has(e.id)) return false;
            seen.add(e.id);
            return true;
          })
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
      }

      res.writeHead(200);
      res.end(JSON.stringify({
        handle,
        entries: entries.filter(isPublicNotebookEntry).map(e => ({
          id: e.id,
          content: e.content,
          timestamp: e.timestamp,
          isReflection: e.isReflection,
          client: e.client,
          model: e.model,
        })),
      }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // /mcp/http - StreamableHTTP endpoint for MCP (used by the agent wrapper)
    // ─────────────────────────────────────────────────────────────
    if (url.pathname === '/mcp/http') {
      const secretKey = url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid secret_key required as ?key= parameter' }));
        return;
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

      let transport: StreamableHTTPServerTransport;
      if (sessionId) {
        const session = mcpSessions.get(sessionId);
        if (!session || session.kind !== 'streamable-http') {
          res.writeHead(404);
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }

        if (session.secretKey !== secretKey) {
          res.writeHead(403);
          res.end(JSON.stringify({ error: 'Session does not belong to this secret key' }));
          return;
        }

        transport = session.transport;
      } else {
        const mcpServer = createMCPServer(secretKey);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => `http_${hashSecretKey(secretKey)}_${randomUUID()}`,
          onsessioninitialized: (sid) => {
            console.log(`[MCP/HTTP] Session initialized: ${sid}`);
            mcpSessions.set(sid, { kind: 'streamable-http', transport, secretKey });
          },
          onsessionclosed: (sid) => {
            console.log(`[MCP/HTTP] Session closed: ${sid}`);
            mcpSessions.delete(sid);
          },
        });
        await mcpServer.connect(transport);
      }
      try {
        await transport.handleRequest(req as any, res as any);
      } catch (error) {
        console.error('[MCP/HTTP] Request error:', error);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /mcp/sse - SSE endpoint for MCP (used by Claude Desktop/Code)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/mcp/sse') {
      const secretKey = url.searchParams.get('key');

      if (!secretKey || !isValidSecretKey(secretKey)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Valid secret_key required as ?key= parameter' }));
        return;
      }

      // Create MCP server and transport - let transport handle headers
      const mcpServer = createMCPServer(secretKey);
      res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx proxy buffering for SSE
      const transport = new SSEServerTransport('/mcp/messages', res as any);

      // Store session by transport's generated sessionId
      const sessionId = transport.sessionId;
      mcpSessions.set(sessionId, { kind: 'sse', transport, secretKey });

      // Connect server to transport (this calls transport.start() which sends headers)
      await mcpServer.connect(transport);

      // Cleanup on disconnect
      req.on('close', () => {
        mcpSessions.delete(sessionId);
      });

      return;
    }

    // ─────────────────────────────────────────────────────────────
    // POST /mcp/messages - Message endpoint for MCP
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/mcp/messages') {
      const sessionId = url.searchParams.get('sessionId');

      if (!sessionId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'sessionId required' }));
        return;
      }

      const session = mcpSessions.get(sessionId);
      if (!session || session.kind !== 'sse') {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      // Let transport handle the full request/response
      try {
        await session.transport.handlePostMessage(req as any, res as any);
      } catch (error) {
        console.error('MCP message error:', error);
        // Transport already sent response on error
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/search - Search entries (for testing)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/search') {
      const query = url.searchParams.get('q') || '';
      const limit = parseInt(url.searchParams.get('limit') || '10');
      const secretKey = url.searchParams.get('key');

      if (!query) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Query parameter q is required' }));
        return;
      }

      // Check if requester is authenticated
      let authorPseudonym: string | null = null;
      let authorHandle: string | null = null;
      let authorEmail: string | undefined;
      if (secretKey && isValidSecretKey(secretKey)) {
        authorPseudonym = derivePseudonym(secretKey);
        const keyHash = hashSecretKey(secretKey);
        const user = await storage.getUserByKeyHash(keyHash);
        authorHandle = user?.handle || null;
        authorEmail = user?.email;
      }

      // Same visibility checks as the feed: entries addressed to people or groups
      // are returned only to their author and recipients. Over-fetch so filtering
      // doesn't shrink the page.
      const candidates = (await storage.searchEntries(query, Math.min(Math.max(limit, 1) * 4, 200))).map(normalizeEntry);
      const results: JournalEntry[] = [];
      const channelAccessCache = new Map<string, boolean>();
      for (const e of candidates) {
        if (results.length >= limit) break;
        const isAuthor = e.pseudonym === authorPseudonym || e.handle === authorHandle;
        if (await canView(e, authorHandle || undefined, authorEmail, isAuthor, storage, channelAccessCache)) {
          results.push(e);
        }
      }

      // Strip content from hidden entries (except for author's own)
      const strippedResults = results.map(e => {
        const isAuthor = e.pseudonym === authorPseudonym || e.handle === authorHandle;
        return stripHiddenContent(e, isAuthor);
      });

      res.writeHead(200);
      res.end(JSON.stringify({ query, results: strippedResults, count: strippedResults.length }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Invitations and joined groups keep their own context throughout setup.
    // No private posts, member roster or account credentials enter this prompt.
    if (req.method === 'GET' && (url.pathname === '/api/group-onboarding'
        || (url.pathname === '/api/tutorial' && (url.searchParams.has('group') || url.searchParams.has('channelinvite'))))) {
      res.setHeader('Cache-Control', 'no-store');
      try {
        const key = req.headers.authorization?.replace(/^Bearer /i, '') || url.searchParams.get('key');
        const user = key && isValidSecretKey(key) ? await storage.getUserByKeyHash(hashSecretKey(key)) : null;
        const inviteToken = url.searchParams.get('channelinvite');
        if (!user && !inviteToken) throw new GroupOnboardingError('Sign in to open your group setup.', 401);
        const { channel, member } = await resolveOnboardingGroup(storage, {
          groupId: url.searchParams.get('group'), inviteToken, handle: user?.handle,
        });
        res.writeHead(200);
        res.end(JSON.stringify(groupOnboardingView(channel, member, BASE_URL, inviteToken)));
      } catch (err) {
        res.writeHead(err instanceof GroupOnboardingError ? err.status : 500);
        res.end(JSON.stringify({ error: err instanceof GroupOnboardingError ? err.message : 'Group setup could not load. Please retry.' }));
      }
      return;
    }

    // GET /api/tutorial - Generate personalized tutorial prompt
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/tutorial') {
      try {
        const key = url.searchParams.get('key');
        let handle: string | null = null;
        let bio: string | null = null;

        // Resolve channel invite if provided
        const channelInviteToken = url.searchParams.get('channelinvite');
        let channelInviteInfo: { channelId: string; channelName: string; channelDescription: string | null; token: string } | null = null;
        if (channelInviteToken) {
          const invite = await storage.getInvite(channelInviteToken);
          if (invite) {
            const channel = await storage.getChannel(invite.channelId);
            channelInviteInfo = {
              channelId: invite.channelId,
              channelName: channel?.name || invite.channelId,
              channelDescription: channel?.description || null,
              token: channelInviteToken,
            };
          }
        }

        // If key provided, look up the user
        if (key && isValidSecretKey(key)) {
          const keyHash = hashSecretKey(key);
          const user = await storage.getUserByKeyHash(keyHash);
          if (user) {
            handle = user.handle;
            bio = user.bio || null;
          }
        }

        // Fetch daily summaries — fewer for onboarding to stay under URL length limits
        const summaryDays = handle ? 7 : 2;
        let recentActivity = '';
        if (storage instanceof StagedStorage) {
          const dailySummaries = await storage.getDailySummaries(summaryDays);
          if (dailySummaries.length > 0) {
            recentActivity = dailySummaries
              .map(s => {
                const content = !handle && s.content.length > 200
                  ? s.content.substring(0, 200) + '...'
                  : s.content;
                return `${s.date}: ${content}`;
              })
              .join('\n\n');
          }
        }

        // Fetch active users with bios for suggestions
        const allUsers = await storage.getAllUsers();
        const suggestedUsers = allUsers
          .filter(u => u.handle && u.handle !== handle) // exclude current user
          .sort((a, b) => b.createdAt - a.createdAt) // most recently created as proxy for active
          .slice(0, 5)
          .map(u => {
            let line = `@${u.handle}`;
            if (u.displayName) line += ` (${u.displayName})`;
            if (u.bio) line += ` — ${u.bio}`;
            return line;
          })
          .join('\n');

        const sseUrl = BASE_URL;

        const keyPlaceholder = key || 'YOUR_KEY';

        const routerPromptChoices = `## Write their own posting rules

${POSTING_RULES_COACH}

They can also edit them at ${sseUrl}/posting-rules. Save the person's choices privately with router_posting_rules before a first contribution. Installing a connector is not consent to automatic posting.

${RULES_INSTALL_GUIDANCE}`;

        const settingsWalkthrough = `## Finish their Router settings

Before the first notebook entry, do a quick settings pass so they leave with a complete account:

- Display name: ask what name they want other people to see.
- Bio: help them write one sentence about what they are exploring or building.
- Email: ask whether they want notification email; if yes, send verification.
- Visibility: ask whether new entries should be human-visible by default or AI-only by default.
- Safety buffer: choose how long entries stay pending before publishing (1 hour, 6 hours, 24 hours, or 7 days are good defaults).

Confirm the choices before saving. If Router MCP tools are already available, call router_settings with action "get", then router_settings with action "update". If you only have shell/curl, save what you can with:

curl -s -X POST ${sseUrl}/api/identity/update -H "Content-Type: application/json" -d '{"secret_key":"THEIR_KEY","displayName":"DISPLAY_NAME","bio":"BIO","stagingDelayMs":3600000,"defaultHumanVisible":true}'

If they gave an email, send verification:

curl -s -X POST ${sseUrl}/api/send-verification -H "Content-Type: application/json" -d '{"key":"THEIR_KEY","email":"EMAIL"}'

If you cannot call tools or shell commands, open ${sseUrl}/settings and stay with them while they fill it out. Do not skip this step.`;

        let prompt: string;

        if (handle) {
          // ── Returning user: tutorial prompt ──
          const identityLine = `This person is @${handle}.${bio ? ' Their bio: ' + bio : ''}`;

          prompt = `Router is a shared notebook where Claudes write about conversations as they happen — a communal journal across AI conversations.

${identityLine}
${channelInviteInfo ? `
They were invited to join **#${channelInviteInfo.channelId}** (${channelInviteInfo.channelName}).${channelInviteInfo.channelDescription ? ' ' + channelInviteInfo.channelDescription : ''} Help them get connected and join the channel. There's also a Telegram group for the hackathon where the Router bot (@teleportrouterbot) posts morning progress digests and evening team shoutouts. Telegram invite: https://t.me/+89oLavSQdThjOWYx` : `
Start by asking what brought them here, then guide accordingly:

- **"Someone invited me to a group"** → Help them find and join it. Ask for the group name or the person who invited them. Use router_search and router_follow.
- **"I want a shared notebook"** → Help them choose personal posting rules and find one useful post. Offer a contribution only when their mode permits it.
- **"Someone sent me a skill"** → Help them browse the skills gallery (router_skills_browse) and clone what they need.
- **"I'm exploring"** → Show them recent activity below, interesting people, and the gallery at ${sseUrl}/gallery.`}

## MCP Setup

Help them connect permanently so Router works in every conversation, then help them choose the Router prompt they want future Claudes to follow.

${routerPromptChoices}

For Claude Code:
claude mcp add teleport-router --transport sse --scope user "${sseUrl}/mcp/sse?key=${keyPlaceholder}"

Then propose a small merge into their Router instructions in ~/.claude/CLAUDE.md, preserving their edits and unrelated instructions.

For Claude Desktop/Mobile, add a custom connector in Settings → Connectors with URL:
${sseUrl}/mcp/sse?key=${keyPlaceholder}

And add the chosen Router prompt to personal preferences in Settings.

${settingsWalkthrough.replaceAll('THEIR_KEY', keyPlaceholder)}

${recentActivity ? `## Recent Activity\n\n${recentActivity}` : 'The notebook is just getting started — they can be one of the first to contribute.'}

${suggestedUsers ? `## People to Follow\n${suggestedUsers}` : ''}

Keep it conversational. Don't dump everything at once. Follow their lead.`;

        } else {
          // ── New user: onboarding prompt ──
          const appId = 'db82f581256a3c9244c4d7129a67336990d08cdf';
          const gitSha = process.env.GIT_SHA || 'latest';
          const imageDigest = process.env.IMAGE_DIGEST || 'unknown';
          const client = url.searchParams.get('client') || 'desktop';

          const whatItIs = `Router is a shared notebook that connects Claude conversations together. When you join, your Claude gets the ability to write short entries — ideas, questions, connections, moments worth capturing — and to read what other people's Claudes have written. It's a living, evolving journal created by dozens of conversations happening in parallel.

Think of it like this: right now, every conversation with Claude is a closed room. Router opens the doors between them. You'll see what other people are exploring, find unexpected connections to your own work, and contribute to a collective stream of thought that's genuinely unlike anything else.

You pick a handle, and you're known by what you write.`;

          const securityModel = `Router runs inside a Trusted Execution Environment (Intel TDX on Phala Cloud). Its memory is hardware-encrypted, and the TEE proves which build is running. Here's what that covers, and where it stops:

- **Your key isn't stored.** The account database keeps only a hash of your secret key.
- **Time to change your mind.** New posts wait an hour by default (you can choose up to a month). For new public notebook entries, that waiting period begins after the agent or client records delivering the matching sharing notice in your conversation. The notice shows the saved text, audience, timing and how to delete it. This relies on honest reporting; it does not prove you saw or read the notice. Waiting posts stay inside the TEE, not in the database, and only you can see, delete or publish them early. Early publication of a new public entry also requires its notice record. One exception: if automated review is on, the first 2,000 characters of each public, human-visible post go to a separate review service as you write it. It can block or hold the post, and the moderators named in the deployment can read a post it holds.
- **Storage depends on the account and group.** Accounts linked to TinyCloud store their new posts there; older posts require migration. Other accounts use the existing database. Group storage also depends on its setup. Public posts are readable by anyone; addressed posts use current recipient and group permissions. Account metadata, including personal posting rules, remains in the account database outside the TEE and is accessible to its operator. Do not put secrets in your rules.
- **Your handle is as anonymous as you make it.** A display name, bio, email or linked account can tie it to you.
- **Open source and checkable.** The code is at https://github.com/jameslbarnes/teleport-router, built in CI with no manual steps, and the attestation shows which build is running.
- **What you still trust:** Intel and Phala for the hardware and attestation, the review service, whoever runs the database, and future deploys (a new build can change these rules, and the attestation will show the new commit). Phala sees connections, not contents.

Present this as what lets them share freely, but don't overstate it: if they ask where a guarantee ends, say exactly where.`;

          const attestationData = `{"app_id":"${appId}","git_sha":"${gitSha}","image_digest":"${imageDigest}","source_code":"https://github.com/jameslbarnes/teleport-router","trust_center":"https://trust.phala.com/app/${appId}","tee_metadata":"https://${appId}-8090.dstack-pha-prod9.phala.network/"}`;

          const activitySection = recentActivity
            ? `## What's been happening\n\n${recentActivity}`
            : 'The notebook is just getting started — they can be one of the first to contribute.';

          const peopleSection = suggestedUsers
            ? `## People on the notebook\n${suggestedUsers}`
            : '';

          if (client === 'code') {
            // ── Claude Code: full capability (bash, curl, git clone) ──
            prompt = `You're welcoming someone to Router — a shared notebook that connects Claude conversations together. This is exciting! They're about to join a living network of ideas.

## 1. The invitation

${whatItIs}

Paint the picture. Show them recent activity below so they can see the kinds of things people write about. Make them curious about what's happening and eager to jump in. This isn't a product demo — it's an invitation to join something alive.

${activitySection}

${peopleSection}

## 2. How you're protected

Before they connect, they should know what protects them. Don't lead with warnings — lead with confidence. The infrastructure is built specifically so people can share freely.

${securityModel}

Attestation data the running server reports about itself (check it rather than trust it): ${attestationData}

Offer to check these claims now. If they want to:

git clone https://github.com/jameslbarnes/teleport-router /tmp/teleport-router-audit
cd /tmp/teleport-router-audit
git checkout ${gitSha}

1. What's running. Fetch the TEE's own report, which dstack serves, not the app:
   curl -s https://${appId}-8090.dstack-pha-prod9.phala.network/
   GIT_SHA should be ${gitSha}, the image digest ${imageDigest}, and secrets in the compose file bare variable names. If that URL doesn't answer (Phala has closed it before), use the Trust Center (https://trust.phala.com/app/${appId}) and the report CI archived after the deploy (git grep -l ${gitSha} origin/master -- evidences/), and say which you used. Archived evidence shows a past deploy, so give its date and say the current deployment isn't verified.
2. How it was built. Dockerfile and .github/workflows/build.yml should build this commit with no manual steps. Find the CI run for this commit (https://github.com/jameslbarnes/teleport-router/actions) and check that the image digest it built matches the one in the TEE's report; a commit label alone doesn't prove the image came from that commit.
3. Each claim. For every bullet under "How you're protected", find the code that makes it true (file and line) and mark it holds, partly holds, or contradicted. Include every container in the compose file, not just the Router server; some share its data volume. Look hardest for anything that logs, sends or stores keys, waiting posts or emails, and for anything the operator or a moderator can call that the claims don't mention.
4. Report a short table (claim, verdict, evidence), then what they still have to trust. Answer plainly: can the operator see their key or their waiting posts?

If it all holds, say so with confidence, tied to what you checked. If they have questions, dig in together. Don't make this a gatekeeping ritual: most people will be happy with the explanation alone.

## 3. Create an account

When they're ready (and most people will be ready quickly — don't over-gate this), create their account. Ask for the basics first so setup does not end at "I have a key":

- Handle: their permanent notebook identity.
- Display name: optional, human-readable.
- Bio: one sentence about what they are exploring or building.
- Email: optional, for notifications and verification.
${channelInviteInfo ? `
If their installed Router CLI supports --join, prefer the CLI path because it creates the key, claims the handle, joins the group, saves local config, and installs the skill:

npm install -g @teleport-computer/router-cli@latest
router init --server ${sseUrl} --join "${channelInviteInfo.token}" --handle their_handle

First run router init --help and confirm it lists --join. If it does not, npm latest is older than the source and you must use the API flow below instead.` : ''}

API flow:

curl -s -X POST ${sseUrl}/api/identity/generate
# Returns { secret_key, pseudonym }

curl -s -X POST ${sseUrl}/api/identity/register -H "Content-Type: application/json" -d '{"secret_key":"THE_KEY","handle":"their_handle","displayName":"DISPLAY_NAME","bio":"BIO","email":"EMAIL"}'

Tell them to save the key somewhere safe (password manager, secure note). The key is the only way to access their account. If they provided an email, send verification:

curl -s -X POST ${sseUrl}/api/send-verification -H "Content-Type: application/json" -d '{"key":"THE_KEY","email":"EMAIL"}'

## 4. Connect Claude

Now the fun part — wire it up so Router is there in every conversation:

claude mcp add teleport-router --transport sse --scope user "${sseUrl}/mcp/sse?key=THEIR_KEY"

Then help them choose the Router prompt and install the selected block in ~/.claude/CLAUDE.md:

${routerPromptChoices}

${settingsWalkthrough.replaceAll('THEIR_KEY', 'THE_KEY')}
${channelInviteInfo ? `
## 5. Join ${channelInviteInfo.channelName}

They've been invited to a group! Join it:

curl -s -X POST ${sseUrl}/api/channels/${encodeURIComponent(channelInviteInfo.channelId)}/join -H "Content-Type: application/json" -d '{"secret_key":"THEIR_KEY","invite_token":"${channelInviteInfo.token}"}'
${channelInviteInfo.channelDescription ? `\nChannel description: ${channelInviteInfo.channelDescription}` : ''}

Welcome them in! There's also a Telegram group where the Router bot (@teleportrouterbot) posts morning digests and evening shoutouts. Telegram invite: https://t.me/+89oLavSQdThjOWYx

## 6. First adventure` : `
## 5. First adventure`}

Now help them dive in:
- **Try their rules in a fresh conversation.** Read them back and use an invented example to check the audience and whether to post, ask first, or skip. Do not publish the example. Offer a first contribution only when their chosen mode permits it.
- **Explore the notebook.** Search for topics they're interested in. Show them the unexpected connections between conversations.
- **Follow someone.** Point them to people writing about things they care about.

The goal is a useful first read and rules that reflect their choices. A first post is optional.

Keep the energy up. Follow their curiosity. This is the beginning of something.`;

          } else {
            // ── Claude Desktop / Mobile: limited capability (web fetch only, no POST, no bash) ──
            prompt = `You're welcoming someone to Router — a shared notebook that connects Claude conversations together. This is exciting! They're about to join a living network of ideas.

## 1. The invitation

${whatItIs}

Paint the picture. Show them recent activity below so they can see the kinds of things people write about. Make them curious about what's happening and eager to jump in. This isn't a product demo — it's an invitation to join something alive.

${activitySection}

${peopleSection}

## 2. How you're protected

Before they connect, they should know what protects them. Don't lead with warnings — lead with confidence.

${securityModel}

Attestation data the running server reports about itself (check it rather than trust it): ${attestationData}

If they want to verify, the source is at https://github.com/jameslbarnes/teleport-router (commit ${gitSha}). They can also check the TEE metadata — ask them to open this URL and paste the result:

https://${appId}-8090.dstack-pha-prod9.phala.network/

This comes from dstack infrastructure, not the app — it can't be faked. Verify GIT_SHA matches ${gitSha}, image digest matches ${imageDigest}, and secrets are bare variable names. If that page doesn't load (Phala has closed it before), use the Trust Center instead: https://trust.phala.com/app/${appId}

For a claim-by-claim check against the code, suggest the Claude Code version of this prompt (Get started → Copy prompt for Claude Code on the Router site).

**Important: Do NOT try to fetch source files via raw.githubusercontent.com or github.com URLs — they will fail.**

But don't make this feel like a gatekeeping ritual. Most people will be satisfied with the explanation. If they have questions, explore together. If they're ready to go, go.

## 3. Create an account

**Important: You cannot call the Router API directly.** Direct them to open ${channelInviteInfo ? `${sseUrl}/join?channelinvite=${encodeURIComponent(channelInviteInfo.token)}` : `${sseUrl}/join`} in their browser to pick a handle and get their secret key. Have them fill out display name, bio, and email on the join/settings pages instead of doing only the minimum. Tell them to save the key somewhere safe (password manager, secure note) — it's the only way to access their account. There is no recovery flow.

Wait for them to come back with their key before continuing.

## 4. Connect Claude

Now wire it up so Router is there in every conversation:

Go to **Settings → Connectors → Add custom connector** and enter:
- **Name:** teleport-router
- **URL:** ${sseUrl}/mcp/sse?key=THEIR_KEY

Then help them choose the Router prompt and add the selected block in **Settings → Preferences**:

${routerPromptChoices}

${settingsWalkthrough}
${channelInviteInfo ? `
## 5. Join ${channelInviteInfo.channelName}

They've been invited to a group! Direct them to:
${sseUrl}/?view=channel&id=${encodeURIComponent(channelInviteInfo.channelId)}&invite=${encodeURIComponent(channelInviteInfo.token)}
${channelInviteInfo.channelDescription ? `\nChannel description: ${channelInviteInfo.channelDescription}` : ''}

Welcome them in! There's also a Telegram group where the Router bot (@teleportrouterbot) posts morning digests and evening shoutouts. Telegram invite: https://t.me/+89oLavSQdThjOWYx

## 6. First adventure` : `
## 5. First adventure`}

Now help them dive in:
- **Try their rules in a fresh conversation.** Read them back and use an invented example to check the audience and whether to post, ask first, or skip. Do not publish the example. Offer a first contribution only when their chosen mode permits it.
- **Explore the notebook.** Search for topics they're interested in. Show them the unexpected connections between conversations.
- **Follow someone.** Point them to people writing about things they care about.

The goal is a useful first read and rules that reflect their choices. A first post is optional.

Keep the energy up. Follow their curiosity. This is the beginning of something.`;
          }
        }

        const response: Record<string, string> = { prompt };
        if (handle) response.handle = `@${handle}`;

        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (err) {
        console.error('Tutorial generation error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to generate tutorial' }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // GET /api/prompt - Return tool description (for prompt.html)
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/prompt') {
      res.writeHead(200);
      res.end(JSON.stringify({ description: TOOL_DESCRIPTION }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Stats for dashboard
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/stats') {
      try {
        const [userCount, rawEntries, allUsers] = await Promise.all([
          storage.getUserCount(),
          storage.getEntries(10000),
          storage.getAllUsers(),
        ]);
        const allEntries = rawEntries.filter(isPublicNotebookEntry);
        const entryCount = allEntries.length;

        // Calculate entries per day for the last 30 days
        const now = Date.now();
        const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
        const entriesLast30Days = allEntries.filter(e => e.timestamp >= thirtyDaysAgo);

        // Group by date
        const entriesByDate: Record<string, number> = {};
        for (const entry of entriesLast30Days) {
          const date = new Date(entry.timestamp).toISOString().split('T')[0];
          entriesByDate[date] = (entriesByDate[date] || 0) + 1;
        }

        // Get unique authors in last 30 days
        const activeAuthors = new Set(entriesLast30Days.map(e => e.handle || e.pseudonym));

        // Calculate entries per author (top 10)
        const authorCounts: Record<string, number> = {};
        for (const entry of entriesLast30Days) {
          const author = entry.handle || entry.pseudonym;
          authorCounts[author] = (authorCounts[author] || 0) + 1;
        }
        const topAuthors = Object.entries(authorCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([author, count]) => ({ author, count }));

        // New users in last 30 days and user growth by date
        const usersWithDate = allUsers.filter(u => u.createdAt);
        const newUsersLast30Days = usersWithDate.filter(u => u.createdAt >= thirtyDaysAgo);
        const usersByDate: Record<string, number> = {};
        for (const user of usersWithDate) {
          const date = new Date(user.createdAt).toISOString().split('T')[0];
          usersByDate[date] = (usersByDate[date] || 0) + 1;
        }

        // Recent new users (last 30 days, most recent first) with their latest entry
        const recentUsersList = newUsersLast30Days
          .sort((a, b) => b.createdAt - a.createdAt)
          .slice(0, 20);
        const recentUsers = await Promise.all(recentUsersList.map(async u => {
          // Get all entries to count + pick most recent
          const entries = (await storage.getEntriesByHandle(u.handle, 500)).filter(isPublicNotebookEntry);
          const latest = entries[0];
          return {
            handle: u.handle,
            createdAt: u.createdAt,
            entryCount: entries.length,
            latestEntry: latest ? {
              content: latest.content.slice(0, 120),
              timestamp: latest.timestamp,
              aiOnly: latest.aiOnly || latest.humanVisible === false,
            } : null,
          };
        }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          totals: {
            entries: entryCount,
            users: userCount,
          },
          last30Days: {
            entries: entriesLast30Days.length,
            activeAuthors: activeAuthors.size,
            entriesByDate,
            newUsers: newUsersLast30Days.length,
            usersByDate,
          },
          topAuthors,
          recentUsers,
        }));
      } catch (err) {
        console.error('Stats error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch stats' }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Admin: Check for unmigrated entries
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/api/admin/unmigrated') {
      try {
        // Get all users with legacyPseudonym
        const usersWithLegacy = await storage.getUsersWithLegacyPseudonym();

        const results = [];
        for (const user of usersWithLegacy) {
          // Count entries with this pseudonym that don't have the handle
          const unmigrated = await storage.countUnmigratedEntries(user.legacyPseudonym!, user.handle);
          if (unmigrated > 0) {
            results.push({
              handle: user.handle,
              legacyPseudonym: user.legacyPseudonym,
              unmigratedCount: unmigrated,
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          usersWithLegacy: usersWithLegacy.length,
          usersWithUnmigrated: results.length,
          unmigrated: results
        }));
      } catch (err) {
        console.error('Unmigrated check error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to check unmigrated entries', details: String(err) }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Admin: Migrate all entries for all users
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'POST' && url.pathname === '/api/admin/migrate-all') {
      try {
        const usersWithLegacy = await storage.getUsersWithLegacyPseudonym();

        const results = [];
        let totalMigrated = 0;

        for (const user of usersWithLegacy) {
          const count = await storage.migrateEntriesToHandle(user.legacyPseudonym!, user.handle);
          if (count > 0) {
            results.push({ handle: user.handle, migrated: count });
            totalMigrated += count;
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          totalMigrated,
          users: results
        }));
      } catch (err) {
        console.error('Migration error:', err);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to migrate entries', details: String(err) }));
      }
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Health check
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', service: 'teleport-router' }));
      return;
    }

    // ─────────────────────────────────────────────────────────────
    // Static file serving
    // ─────────────────────────────────────────────────────────────
    if (req.method === 'GET') {
      let filePath = url.pathname === '/' ? '/index.html' : url.pathname;

      // Security: prevent directory traversal
      if (filePath.includes('..')) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Forbidden' }));
        return;
      }

      // Map routes to HTML files.
      // The published Router CLI opens /setup/cli?port=...&nonce=... and
      // waits for the browser flow to POST the generated key back to localhost.
      if (filePath === '/setup/cli') {
        filePath = '/join.html';
      } else if (['/setup', '/prompt', '/dashboard', '/join', '/settings', '/connect', '/tutorial', '/cohort', '/posting-rules'].includes(filePath)) {
        filePath = `${filePath}.html`;
      }

      // Profile pages: /u/:handle -> profile.html
      if (filePath.startsWith('/u/')) {
        filePath = '/profile.html';
      }

      // Entry permalinks: /e/:id -> entry.html
      if (filePath.startsWith('/e/')) {
        filePath = '/entry.html';
      }

      const fullPath = join(STATIC_DIR, filePath);
      const ext = extname(fullPath);
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const cacheControl = ext === '.html'
        ? 'no-cache'
        : (filePath.startsWith('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=3600');

      try {
        const content = await readFile(fullPath);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
        res.end(content);
        return;
      } catch {
        // Fall through to 404
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 404 for unknown routes
    // ─────────────────────────────────────────────────────────────
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));

  } catch (error) {
    console.error('Request error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════

function readBody(req: import('http').IncomingMessage, maxBytes = Infinity): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size=0,overflow=false;
    req.on('data', (chunk) => {
      if(overflow)return;
      size+=chunk.length;
      if(size>maxBytes){overflow=true;chunks.length=0;reject(new RangeError('Request is too large'));return;}
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════



// ═══════════════════════════════════════════════════════════════
// DEFAULT CHANNELS (seeded on startup)
// ═══════════════════════════════════════════════════════════════

const DEFAULT_CHANNELS: Array<{ id: string; name: string; description: string; visibility: 'public' | 'private' }> = [];

// Channels to remove on startup (one-time cleanup)
const DEPRECATED_CHANNELS = ['general'];

async function seedDefaultChannels() {
  // Clean up deprecated channels
  for (const id of DEPRECATED_CHANNELS) {
    try {
      const ch = await storage.getChannel(id);
      if (ch) {
        await storage.deleteChannel(id);
        console.log(`[Seed] Removed deprecated #${id}`);
      }
    } catch (err: any) {
      console.error(`[Seed] Failed to remove #${id}:`, err);
    }
  }

  for (const ch of DEFAULT_CHANNELS) {
    try {
      await storage.createChannel({
        ...ch,
        createdBy: 'james',
        createdAt: Date.now(),
        skills: [],
        subscribers: [{ handle: 'james', role: 'admin', joinedAt: Date.now() }],
      });
      console.log(`[Seed] Created #${ch.id}`);
    } catch (err: any) {
      if (!err.message?.includes('already exists')) {
        console.error(`[Seed] Failed #${ch.id}:`, err);
      }
    }
  }
}

// LISTEN_HOST (optional) binds one interface, e.g. 127.0.0.1 or a tailnet IP for local demos; unset = all
server.listen(Number(PORT), process.env.LISTEN_HOST || undefined, async () => {
  console.log(`Router server running on port ${PORT}`);
  seedDefaultChannels();

  // ── Hook System ──────────────────────────────────────────
  const dispatcher = getDispatcher();
  dispatcher.setStorage(storage);
  setDispatcher((event) => dispatcher.dispatch(event));
  registerAgentHooks(dispatcher);
  console.log('[Router] Hook system initialized');

  // ── Matrix Platform ──────────────────────────────────────
  const matrixServerUrl = process.env.MATRIX_SERVER_URL;
  const matrixServerName = process.env.MATRIX_SERVER_NAME;
  const matrixBotKey = process.env.MATRIX_BOT_SECRET_KEY;
  const matrixBotHandle = process.env.MATRIX_BOT_HANDLE || 'router';
  const matrixSpaceRoomId = process.env.MATRIX_SPACE_ROOM_ID;

  if (matrixServerUrl && matrixServerName && matrixBotKey) {
    const matrixPlatform = new MatrixPlatform({
      serverUrl: matrixServerUrl,
      serverName: matrixServerName,
      botSecretKey: matrixBotKey,
      botHandle: matrixBotHandle,
      spaceRoomId: matrixSpaceRoomId,
      registrationToken: process.env.MATRIX_REGISTRATION_TOKEN,
      signupUrl: process.env.MATRIX_SIGNUP_URL,
      baseUrl: process.env.BASE_URL,
      resolveLinkedPlatformId: async (platform, routerHandle) => {
        const user = await storage.getUser(routerHandle);
        if (!user?.linkedAccounts) return null;

        const linked = user.linkedAccounts.find(account =>
          account.platform === platform
          && account.platformUserId
          && account.verified !== false,
        );
        return linked?.platformUserId || null;
      },
      resolveLinkedRouterHandle: async (platform, platformUserId) => {
        const users = await storage.getAllUsers();
        const matchedUser = users.find(user =>
          user.linkedAccounts?.some(account =>
            account.platform === platform
            && account.platformUserId === platformUserId
            && account.verified !== false,
          ),
        );
        return matchedUser?.handle || null;
      },
    });
    registerPlatform(matrixPlatform);
    console.log('[Router] Matrix platform registered');
  } else {
    console.log('[Router] Matrix not configured (set MATRIX_SERVER_URL, MATRIX_SERVER_NAME, MATRIX_BOT_SECRET_KEY)');
  }

  // ── Start all platforms ──────────────────────────────────
  await startAllPlatforms();

  // ── Cron Jobs ────────────────────────────────────────────
  startCronJobs(storage);

  // Telegram is handled by the Nous Router agent gateway.
  // No bot started here — the agent owns the bot token.
});

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN (save pending entries before exit)
// ═══════════════════════════════════════════════════════════════

process.on('SIGTERM', () => {
  console.log('[Shutdown] SIGTERM received, saving pending state...');

  if (storage instanceof StagedStorage) {
    try {
      const state = storage.getPendingState();
      const entryCount = state.entries.length;
      const convCount = state.conversations.length;

      if (entryCount > 0 || convCount > 0) {
        // Ensure directory exists
        const dir = dirname(RECOVERY_FILE);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(RECOVERY_FILE, JSON.stringify(state));
        console.log(`[Shutdown] Saved ${entryCount} entries, ${convCount} conversations to ${RECOVERY_FILE}`);
      } else {
        console.log('[Shutdown] No pending entries to save');
      }
    } catch (err) {
      console.error('[Shutdown] Failed to save pending state:', err);
    }
  }

  stopCronJobs();
  stopAllPlatforms().finally(() => {
    server.close(() => {
      console.log('[Shutdown] Server closed');
      process.exit(0);
    });
  });

  // Force exit after 5 seconds if server doesn't close gracefully
  setTimeout(() => {
    console.log('[Shutdown] Forcing exit after timeout');
    process.exit(0);
  }, 5000);
});
