/**
 * Spark Detection Engine
 *
 * The core of "make connections between people and ideas."
 *
 * A spark is a detected overlap between two users' interests, work,
 * or questions — surfaced from notebook entries and platform messages.
 *
 * The engine:
 *   1. Detects potential sparks when new content arrives
 *   2. Evaluates confidence using Claude
 *   3. Checks the connection graph (are they already connected?)
 *   4. Decides an action: introduce, suggest, nudge, or skip
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry, User } from '../storage.js';
import type { Platform } from '../platform/types.js';
import { SPARK_COPY_PROMPT, SPARK_EVALUATION_PROMPT } from './prompts.js';
import { extractJson } from './scoring.js';
import { hasPublicAudience } from '../public-views.js';

// ── Types ────────────────────────────────────────────────────

export type SparkConfidence = 'high' | 'moderate' | 'low' | 'skip';

export interface SparkCandidate {
  handle: string;
  matchingEntries: JournalEntry[];
  overlapTopics: string[];
}

export interface SparkAction {
  action: 'introduce' | 'suggest' | 'nudge' | 'skip';
  confidence: SparkConfidence;
  sourceHandle: string;
  targetHandle: string;
  reason: string;
  message?: string;
}

export interface SparkReplyTarget {
  /** Bot-noise room ID where the warm message should be posted. */
  roomId: string;
  /** Optional source-entry event in the room to reply to. */
  replyToEventId?: string;
}

export interface ConnectionInfo {
  handle: string;
  sharedRoomIds: string[];
  recentInteractions: number;
  isConnected: boolean;
}

export const SPARK_EVALUATION_MODEL = 'claude-haiku-4-5-20251001';
export const SPARK_COPY_MODEL = 'claude-opus-4-6';

export function formatEntryForSparkEvaluation(entry: JournalEntry): string {
  const date = new Date(entry.timestamp).toISOString().split('T')[0];

  if (entry.content.trim().length > 0) {
    return `[${date}] ${entry.content.slice(0, 300)}`;
  }

  if (entry.aiOnly) {
    const topics = [...(entry.topicHints || []), ...(entry.keywords || [])]
      .filter(Boolean)
      .slice(0, 8);
    const topicText = topics.length > 0 ? topics.join(', ') : 'no topics provided';
    return `[${date}] [AI-only entry] Topics: ${topicText}`;
  }

  return `[${date}]`;
}

// ── Detection ────────────────────────────────────────────────

/**
 * Detect potential sparks triggered by a new entry.
 * Searches the notebook for other users writing about overlapping topics.
 */
export async function detectSparks(
  entry: JournalEntry,
  storage: Storage,
  keywords?: string[],
): Promise<SparkCandidate[]> {
  const authorHandle = entry.handle;
  if (!authorHandle || !hasPublicAudience(entry)) return [];

  // Use provided keywords or extract from entry
  const searchTerms = keywords?.length
    ? keywords
    : [...(entry.topicHints || []), ...(entry.keywords || [])].slice(0, 5);

  if (searchTerms.length === 0) return [];

  // Search for related entries by other authors
  const relatedEntries = await storage.searchEntries(searchTerms.join(' '), 30);
  const otherEntries = relatedEntries.filter(e =>
    e.handle && e.handle !== authorHandle && hasPublicAudience(e)
  );

  // Group by author
  const byAuthor = new Map<string, JournalEntry[]>();
  for (const e of otherEntries) {
    if (!e.handle) continue;
    const existing = byAuthor.get(e.handle) || [];
    existing.push(e);
    byAuthor.set(e.handle, existing);
  }

  // Build candidates
  const candidates: SparkCandidate[] = [];
  for (const [handle, entries] of byAuthor) {
    // Find overlapping topics
    const theirTopics = new Set<string>();
    for (const e of entries) {
      e.topicHints?.forEach(t => theirTopics.add(t.toLowerCase()));
      e.keywords?.forEach(k => theirTopics.add(k.toLowerCase()));
    }
    const myTopics = new Set(searchTerms.map(t => t.toLowerCase()));
    const overlap = [...myTopics].filter(t => theirTopics.has(t));

    candidates.push({
      handle,
      matchingEntries: entries.slice(0, 3), // Keep top 3
      overlapTopics: overlap.length > 0 ? overlap : searchTerms.slice(0, 2),
    });
  }

  // Sort by number of matching entries (stronger signal)
  candidates.sort((a, b) => b.matchingEntries.length - a.matchingEntries.length);

  return candidates.slice(0, 5); // Top 5 candidates
}

// ── Evaluation ───────────────────────────────────────────────

/**
 * Evaluate a spark candidate using Claude to assess confidence.
 * Returns the recommended action.
 */
export async function evaluateSpark(
  sourceEntry: JournalEntry,
  candidate: SparkCandidate,
  connectionInfo: ConnectionInfo,
  anthropic: Anthropic,
): Promise<SparkAction> {
  const sourceHandle = sourceEntry.handle!;

  try {
    const sourceAuthor = `@${sourceHandle}`;
    const targetAuthor = `@${candidate.handle}`;

    const sourceContent = sourceEntry.content.slice(0, 500);
    const targetContent = candidate.matchingEntries
      .map(formatEntryForSparkEvaluation)
      .join('\n\n');

    const connectionContext = connectionInfo.isConnected
      ? `These two ARE already connected (${connectionInfo.sharedRoomIds.length} shared rooms, ${connectionInfo.recentInteractions} recent interactions).`
      : 'These two are NOT currently connected.';

    const response = await anthropic.messages.create({
      model: SPARK_EVALUATION_MODEL,
      max_tokens: 300,
      system: SPARK_EVALUATION_PROMPT,
      messages: [
        {
          role: 'user',
          content: `${sourceAuthor}'s new entry:\n${sourceContent}\n\n${targetAuthor}'s related entries:\n${targetContent}\n\nOverlapping topics: ${candidate.overlapTopics.join(', ')}\n\n${connectionContext}`,
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return { action: 'skip', confidence: 'skip', sourceHandle, targetHandle: candidate.handle, reason: 'No response' };

    const parsed = JSON.parse(extractJson((text as Anthropic.TextBlock).text));

    const confidence = parsed.confidence as SparkConfidence;
    const evaluationReason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : 'No rationale provided';

    if (confidence === 'skip') {
      return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: evaluationReason };
    }

    let action: SparkAction;

    // Decide action based on confidence and connection status
    if (connectionInfo.isConnected) {
      if (confidence === 'high' || confidence === 'moderate') {
        action = {
          action: 'nudge',
          confidence,
          sourceHandle,
          targetHandle: candidate.handle,
          reason: evaluationReason,
        };
        return await withSparkCopy(sourceEntry, candidate, connectionInfo, action, anthropic);
      }
      return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: 'Already connected, low confidence' };
    }

    // Not connected
    if (confidence === 'high') {
      action = {
        action: 'introduce',
        confidence,
        sourceHandle,
        targetHandle: candidate.handle,
        reason: evaluationReason,
      };
      return await withSparkCopy(sourceEntry, candidate, connectionInfo, action, anthropic);
    }

    if (confidence === 'moderate') {
      action = {
        action: 'suggest',
        confidence,
        sourceHandle,
        targetHandle: candidate.handle,
        reason: evaluationReason,
      };
      return await withSparkCopy(sourceEntry, candidate, connectionInfo, action, anthropic);
    }

    return { action: 'skip', confidence, sourceHandle, targetHandle: candidate.handle, reason: evaluationReason || 'Low confidence' };
  } catch (err) {
    console.error('[Intelligence/Sparks] Evaluation failed:', err);
    return { action: 'skip', confidence: 'skip', sourceHandle, targetHandle: candidate.handle, reason: 'Evaluation error' };
  }
}

async function withSparkCopy(
  sourceEntry: JournalEntry,
  candidate: SparkCandidate,
  connectionInfo: ConnectionInfo,
  action: SparkAction,
  anthropic: Anthropic,
): Promise<SparkAction> {
  const copy = await writeSparkCopy(sourceEntry, candidate, connectionInfo, action, anthropic);
  if (!copy) {
    return {
      action: 'skip',
      confidence: 'skip',
      sourceHandle: action.sourceHandle,
      targetHandle: action.targetHandle,
      reason: 'Spark copywriting error',
    };
  }

  return {
    ...action,
    reason: copy.topic,
    message: copy.message,
  };
}

async function writeSparkCopy(
  sourceEntry: JournalEntry,
  candidate: SparkCandidate,
  connectionInfo: ConnectionInfo,
  action: SparkAction,
  anthropic: Anthropic,
): Promise<{ topic: string; message: string } | null> {
  try {
    const targetContent = candidate.matchingEntries
      .map(formatEntryForSparkEvaluation)
      .join('\n\n');

    const connectionContext = connectionInfo.isConnected
      ? `These two are already connected (${connectionInfo.sharedRoomIds.length} shared rooms, ${connectionInfo.recentInteractions} recent interactions).`
      : 'These two are not currently connected.';

    const response = await anthropic.messages.create({
      model: SPARK_COPY_MODEL,
      max_tokens: 500,
      system: SPARK_COPY_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            `Action: ${action.action}`,
            `Source user: @${action.sourceHandle}`,
            `Target user: @${action.targetHandle}`,
            `Evaluator confidence: ${action.confidence}`,
            `Evaluator rationale: ${action.reason}`,
            `Connection status: ${connectionContext}`,
            `Overlapping topics: ${candidate.overlapTopics.join(', ') || '(none)'}`,
            '',
            `@${action.sourceHandle}'s new entry:`,
            sourceEntry.content.slice(0, 700),
            '',
            `@${action.targetHandle}'s related entries:`,
            targetContent || '(none)',
          ].join('\n'),
        },
      ],
    });

    const text = response.content.find(b => b.type === 'text');
    if (!text) return null;

    const parsed = JSON.parse(extractJson((text as Anthropic.TextBlock).text));
    const topic = typeof parsed.topic === 'string' && parsed.topic.trim()
      ? parsed.topic.trim()
      : action.reason;
    const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
    if (!message) return null;

    return { topic, message };
  } catch (err) {
    console.error('[Intelligence/Sparks] Copywriting failed:', err);
    return null;
  }
}

// ── Connection Graph ─────────────────────────────────────────

/**
 * Check the connection between two users across all platforms and the notebook.
 * Returns info about reusable private spark rooms and prior interaction signals.
 */
export async function getConnectionInfo(
  handleA: string,
  handleB: string,
  _platforms: Platform[],
  storage?: Storage,
): Promise<ConnectionInfo> {
  const sharedRoomIds: string[] = [];
  let recentInteractions = 0;

  // Check Router: do they follow each other?
  if (storage) {
    try {
      const userA = await storage.getUser(handleA);
      const userB = await storage.getUser(handleB);
      const aFollowsB = userA?.following?.some(f => f.handle === handleB) || false;
      const bFollowsA = userB?.following?.some(f => f.handle === handleA) || false;
      if (aFollowsB || bFollowsA) recentInteractions++;
    } catch {
      // Non-fatal
    }

    // Check Router: have they addressed entries to each other?
    try {
      const entriesA = await storage.getEntriesByHandle(handleA);
      const entriesB = await storage.getEntriesByHandle(handleB);
      const aToB = entriesA.filter(e => e.to?.includes(`@${handleB}`)).length;
      const bToA = entriesB.filter(e => e.to?.includes(`@${handleA}`)).length;
      recentInteractions += aToB + bToA;
    } catch {
      // Non-fatal
    }

    // Check Router: do they already have a dedicated private spark room?
    try {
      const pairRoomId = await storage.getSparkPairRoom(handleA, handleB);
      if (pairRoomId) {
        sharedRoomIds.push(pairRoomId);
        recentInteractions++;
      }
    } catch {
      // Non-fatal
    }
  }

  const isConnected = sharedRoomIds.length > 0 || recentInteractions > 0;

  return {
    handle: handleB,
    sharedRoomIds,
    recentInteractions,
    isConnected,
  };
}

// ── Execution ────────────────────────────────────────────────

/**
 * Post the spark's warm message in bot-noise — threaded as a reply to the
 * source entry's bot-noise post when an event id is available.
 */
export async function executeSpark(
  action: SparkAction,
  platforms: Platform[],
  target: SparkReplyTarget,
): Promise<void> {
  if (action.action === 'skip') return;
  if (!action.message) return;

  const platform = platforms.find(p => p.name === 'matrix') || platforms[0];
  if (!platform) {
    console.warn('[Intelligence/Sparks] No platform available to execute spark');
    return;
  }

  console.log(
    `[Sparks] Posting ${action.action} in #sparks: @${action.sourceHandle} ↔ @${action.targetHandle}`,
  );

  await platform.sendMessage(target.roomId, action.message, {
    replyTo: target.replyToEventId,
  });
}
