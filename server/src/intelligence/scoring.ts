/**
 * Entry Scoring and Editorial Hook Pipeline
 *
 * Platform-agnostic intelligence for evaluating entries.
 * Extracted from telegram/filter.ts — same pipeline, no platform dependencies.
 *
 * Three stages:
 *   1. Hard rules (shouldRoute) — is this entry eligible for distribution?
 *   2. Haiku scoring (scoreEntry) — is it interesting enough?
 *   3. Opus hook writing (writeHook) — editorial context + web search
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Storage, JournalEntry } from '../storage.js';
import { ENTRY_SCORE_PROMPT, ENTRY_HOOK_PROMPT } from './prompts.js';
import { isPublicNotebookEntry } from '../public-views.js';

/** Extract a JSON object from a model response, handling fences and trailing text. */
export function extractJson(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '').trim();
  }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
    }
  }
  return s;
}

const MIN_CONTENT_LENGTH = 50;
const SCORE_THRESHOLD = 6;

/**
 * Hard rules: determine if an entry is eligible for distribution.
 * Returns true if the entry should be considered for routing to platforms.
 */
export function shouldRoute(entry: JournalEntry): boolean {
  if (entry.to && entry.to.length > 0) return false;
  if (entry.visibility === 'private') return false;
  if (entry.aiOnly === true || entry.humanVisible === false) return false;
  if (entry.content.length < MIN_CONTENT_LENGTH) return false;
  return true;
}

/**
 * Score an entry for interestingness (cheap Haiku call).
 * Returns the score (1-10) + search keywords, or null on error.
 */
export async function scoreEntry(
  entry: JournalEntry,
  anthropic: Anthropic,
): Promise<{ score: number; keywords: string[]; passesThreshold: boolean } | null> {
  try {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: ENTRY_SCORE_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Author: ${author}\n\nContent:\n${entry.content.slice(0, 1000)}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === 'text');
    if (!text) return null;

    const raw = (text as Anthropic.TextBlock).text;
    const parsed = JSON.parse(extractJson(raw));
    return {
      score: parsed.score,
      keywords: parsed.keywords || [],
      passesThreshold: parsed.score >= SCORE_THRESHOLD,
    };
  } catch (err) {
    console.error('[Intelligence/Scoring] Failed to score entry:', err);
    return null;
  }
}

export interface RecentPost {
  author: string;
  contentSnippet: string;
  hook?: string;
}

/**
 * Write an editorial hook combining the entry's insight with web context.
 * Returns the hook text, or null if Claude says SKIP or on error.
 */
export async function writeHook(
  entry: JournalEntry,
  relatedEntries: JournalEntry[],
  recentPosts: RecentPost[],
  anthropic: Anthropic,
  baseUrl = 'https://router.teleport.computer',
): Promise<string | null> {
  relatedEntries = relatedEntries.filter(isPublicNotebookEntry);
  try {
    const author = entry.handle ? `@${entry.handle}` : entry.pseudonym;

    const relatedContext =
      relatedEntries.length > 0
        ? relatedEntries
            .map((e) => {
              const a = e.handle ? `@${e.handle}` : e.pseudonym;
              const date = new Date(e.timestamp).toISOString().split('T')[0];
              return `[${a}, ${date}] ${e.content.slice(0, 300)}`;
            })
            .join('\n\n')
        : '(no related entries found)';

    const recentContext =
      recentPosts.length > 0
        ? recentPosts
            .slice(-5)
            .map((p) => `- ${p.author}: ${p.hook || p.contentSnippet.slice(0, 120)}...`)
            .join('\n')
        : '(none yet)';

    const systemPrompt = ENTRY_HOOK_PROMPT
      .replace('{related_entries}', relatedContext)
      .replace('{recent_posts}', recentContext);

    const permalink = `${baseUrl}/#entry-${entry.id}`;
    let messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: `Author: ${author}\nPermalink: ${permalink}\n\nEntry content:\n${entry.content.slice(0, 2000)}`,
      },
    ];

    const apiParams = {
      model: 'claude-opus-4-6' as const,
      max_tokens: 400,
      system: systemPrompt,
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
      ] as any[],
    };

    let response = await anthropic.messages.create({ ...apiParams, messages });

    // Handle web search tool-use loop
    let rounds = 0;
    const stopReason = () => response.stop_reason as string;
    while ((stopReason() === 'tool_use' || stopReason() === 'pause_turn') && rounds < 5) {
      rounds++;
      messages.push({ role: 'assistant', content: response.content });
      response = await anthropic.messages.create({ ...apiParams, messages });
    }

    const text = response.content.find((b) => b.type === 'text');
    if (!text) return null;
    const hook = (text as Anthropic.TextBlock).text.trim();

    if (hook === 'SKIP') return null;
    return hook;
  } catch (err) {
    console.error('[Intelligence/Scoring] Failed to write hook:', err);
    return null;
  }
}

/**
 * Full scoring pipeline: hard rules → score → search → hook.
 * Platform-agnostic: returns a decision, not formatted output.
 */
export async function evaluateEntry(
  entry: JournalEntry,
  anthropic: Anthropic | null,
  storage: Storage | null,
  recentPosts: RecentPost[] = [],
): Promise<{ route: boolean; hook?: string; score?: number; keywords?: string[] }> {
  if (!shouldRoute(entry)) return { route: false };
  if (entry.isReflection) return { route: true };
  if (!anthropic) return { route: true };

  const scoreResult = await scoreEntry(entry, anthropic);
  if (!scoreResult || !scoreResult.passesThreshold) {
    return { route: false, score: scoreResult?.score, keywords: scoreResult?.keywords };
  }

  // Search for related entries
  let relatedEntries: JournalEntry[] = [];
  if (storage && scoreResult.keywords.length > 0) {
    try {
      relatedEntries = (await storage.searchEntries(scoreResult.keywords.join(' '), 5))
        .filter((e) => e.id !== entry.id);
    } catch {
      // Non-fatal
    }
  }

  const hook = await writeHook(entry, relatedEntries, recentPosts, anthropic);
  return {
    route: !!hook,
    hook: hook || undefined,
    score: scoreResult.score,
    keywords: scoreResult.keywords,
  };
}
