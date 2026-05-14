/**
 * "Should I speak?" classifier for proactive group chat participation.
 *
 * Evaluates every incoming message across multiple axes using a cheap
 * Haiku call, then applies adaptive cooldown and conversation flow
 * detection to decide whether the bot should respond.
 *
 * Design philosophy: silence is the default. Speaking needs justification.
 * The bot should act like a sharp person in a group chat — not a search
 * engine, not an assistant, not a know-it-all.
 *
 * EXCEPTION: explicit @mentions and direct replies always get through.
 * Those bypass the classifier entirely — if someone summons the bot,
 * it responds. Period.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BufferedMessage } from './types.js';
import type { MessageBuffer } from './buffer.js';
import type { RateLimiter } from './rate-limiter.js';
import { CLASSIFIER_SYSTEM_PROMPT } from './classifier-prompts.js';

// ─── Public types ───────────────────────────────────────────────────────────

export type SpeakIntent =
  | 'answer'
  | 'correct'
  | 'unstick'
  | 'add-context'
  | 'notebook-surface'
  | 'mention'
  | 'none';

export interface SpeakDecision {
  shouldSpeak: boolean;
  reason: string;
  confidence: number; // 0-1
  replyToMessageId?: number; // which message to reply to
  intent: SpeakIntent;
}

export interface ClassifierScores {
  is_question: number;
  is_wrong: number;
  is_stuck: number;
  is_relevant: number;
  is_directed: number;
  is_social: number;
}

interface ClassifierResult {
  scores: ClassifierScores;
  speak: boolean;
  confidence: number;
  reason: string;
  intent: SpeakIntent;
  trigger_message_index: number;
}

// ─── Adaptive cooldown ─────────────────────────────────────────────────────

/**
 * Tracks how "chatty" the bot has been recently and adjusts the
 * confidence threshold accordingly. Uses exponential decay.
 *
 * Math:
 *   chattiness(t) = Σ e^(-λ * (t - tᵢ))
 *   where tᵢ = timestamp of each time the bot spoke
 *   λ = ln(2) / halfLife
 *
 * With halfLife = 30 minutes:
 *   - Bot just spoke: chattiness ≈ 1.0 (from that one event)
 *   - Bot spoke 30 min ago: chattiness ≈ 0.5
 *   - Bot spoke 60 min ago: chattiness ≈ 0.25
 *   - Multiple recent messages stack: spoke 3 times in 10 min → chattiness ≈ 2.7
 *
 * Threshold = BASE_THRESHOLD + CHATTINESS_WEIGHT * chattiness
 *   - Base threshold: 0.3 (minimum confidence needed to speak)
 *   - At chattiness 1.0: threshold = 0.55
 *   - At chattiness 2.0: threshold = 0.80
 *   - At chattiness 3.0+: threshold = 0.90 (capped — only direct questions get through)
 *   - After 1 hour of silence: chattiness ≈ 0.06, threshold ≈ 0.31
 */

const HALF_LIFE_MS = 30 * 60 * 1000; // 30 minutes
const DECAY_LAMBDA = Math.LN2 / HALF_LIFE_MS; // ≈ 3.85e-7 per ms

/** Minimum confidence to speak, even when completely silent. */
const BASE_THRESHOLD = 0.3;

/** How much each unit of chattiness raises the threshold. */
const CHATTINESS_WEIGHT = 0.25;

/** Maximum threshold — even at extreme chattiness, direct questions still get through. */
const MAX_THRESHOLD = 0.90;

/** Override: is_directed messages above this score bypass adaptive cooldown entirely. */
const DIRECTED_BYPASS_SCORE = 0.8;

export class AdaptiveCooldown {
  /** Timestamps when the bot spoke. Pruned to last 24h. */
  private speakTimestamps: number[] = [];

  /**
   * Record that the bot spoke at this time.
   */
  recordSpeak(now = Date.now()): void {
    this.speakTimestamps.push(now);
    this.prune(now);
  }

  /**
   * Calculate current chattiness score using exponential decay.
   * Each past speak event contributes e^(-λΔt) to the score.
   */
  getChattiness(now = Date.now()): number {
    this.prune(now);
    let score = 0;
    for (const t of this.speakTimestamps) {
      const dt = now - t;
      score += Math.exp(-DECAY_LAMBDA * dt);
    }
    return score;
  }

  /**
   * Get the current confidence threshold needed to speak.
   */
  getThreshold(now = Date.now()): number {
    const chattiness = this.getChattiness(now);
    const threshold = BASE_THRESHOLD + CHATTINESS_WEIGHT * chattiness;
    return Math.min(threshold, MAX_THRESHOLD);
  }

  /**
   * Time in ms since the bot last spoke, or Infinity if never.
   */
  timeSinceLastSpeak(now = Date.now()): number {
    if (this.speakTimestamps.length === 0) return Infinity;
    return now - this.speakTimestamps[this.speakTimestamps.length - 1];
  }

  /** Remove timestamps older than 24 hours. */
  private prune(now: number): void {
    const cutoff = now - 24 * 60 * 60 * 1000;
    this.speakTimestamps = this.speakTimestamps.filter((t) => t > cutoff);
  }

  /** Get timestamps for state persistence. */
  getTimestamps(): number[] {
    return [...this.speakTimestamps];
  }

  /** Restore from persisted state. */
  restore(timestamps: number[]): void {
    this.speakTimestamps = timestamps.filter(
      (t) => Date.now() - t < 24 * 60 * 60 * 1000,
    );
  }
}

// ─── Conversation flow detection ────────────────────────────────────────────

interface FlowAnalysis {
  /** Two people are going back and forth rapidly. */
  isRapidExchange: boolean;
  /** The pair of senders in rapid exchange (if any). */
  exchangePair: [string, string] | null;
  /** A question has been unanswered for 2+ minutes. */
  hasUnansweredQuestion: boolean;
  /** Someone (not the question asker) already replied after the question. */
  questionAlreadyAnswered: boolean;
  /** How many messages since the bot last spoke. */
  messagesSinceBotSpoke: number;
}

/**
 * Analyze the conversation flow from the message buffer.
 * Detects rapid exchanges, unanswered questions, and pile-on risk.
 */
function analyzeFlow(
  messages: BufferedMessage[],
  botUsername?: string,
  now = Date.now(),
): FlowAnalysis {
  const result: FlowAnalysis = {
    isRapidExchange: false,
    exchangePair: null,
    hasUnansweredQuestion: false,
    questionAlreadyAnswered: false,
    messagesSinceBotSpoke: messages.length, // default: bot hasn't spoken
  };

  if (messages.length < 2) return result;

  // Find how many messages since the bot last spoke
  const botNames = new Set<string>();
  if (botUsername) {
    botNames.add(botUsername.toLowerCase());
    botNames.add('hermes');
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (botNames.has(messages[i].senderName.toLowerCase())) {
      result.messagesSinceBotSpoke = messages.length - 1 - i;
      break;
    }
  }

  // Detect rapid exchange: look at the last 6 messages
  const recentWindow = messages.slice(-6);
  if (recentWindow.length >= 4) {
    // Count consecutive pairs with < 30s gap from exactly 2 senders
    const senders = new Set(recentWindow.map((m) => m.senderName));
    const nonBotSenders = [...senders].filter(
      (s) => !botNames.has(s.toLowerCase()),
    );

    if (nonBotSenders.length === 2) {
      let rapidPairs = 0;
      for (let i = 1; i < recentWindow.length; i++) {
        const gap = recentWindow[i].timestamp - recentWindow[i - 1].timestamp;
        if (
          gap < 30_000 &&
          recentWindow[i].senderName !== recentWindow[i - 1].senderName
        ) {
          rapidPairs++;
        }
      }
      // 3+ rapid back-and-forth exchanges = they're in flow
      if (rapidPairs >= 3) {
        result.isRapidExchange = true;
        result.exchangePair = nonBotSenders as [string, string];
      }
    }
  }

  // Detect unanswered questions: look for messages ending with '?'
  // that have had no response for 2+ minutes
  const TWO_MINUTES_MS = 2 * 60 * 1000;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    // Skip bot messages
    if (botNames.has(msg.senderName.toLowerCase())) continue;

    const looksLikeQuestion =
      msg.text.trim().endsWith('?') ||
      /^(how|what|why|when|where|who|which|does|do|is|are|can|could|would|should|has|have|did)\b/i.test(
        msg.text.trim(),
      );

    if (!looksLikeQuestion) continue;

    const timeSinceQuestion = now - msg.timestamp;
    if (timeSinceQuestion < TWO_MINUTES_MS) {
      // Question is too recent — hasn't had time to be answered
      break;
    }

    // Check if anyone (other than the asker) replied after this question
    const repliesAfter = messages
      .slice(i + 1)
      .filter((m) => m.senderName !== msg.senderName);

    if (repliesAfter.length === 0) {
      result.hasUnansweredQuestion = true;
    } else {
      result.questionAlreadyAnswered = true;
    }
    break; // Only check the most recent question
  }

  return result;
}

// ─── LLM classifier call ────────────────────────────────────────────────────

/** How many recent messages to include in the classifier context. */
const CLASSIFIER_CONTEXT_MESSAGES = 15;

/** Extract a JSON object from a model response, handling fences. */
function extractJson(text: string): string {
  let s = text.trim();
  if (s.startsWith('```')) {
    s = s
      .replace(/^```(?:json)?\s*\n?/, '')
      .replace(/\n?```\s*$/, '')
      .trim();
  }
  const start = s.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return s;
}

/**
 * Call Haiku to score the latest messages on multiple axes.
 * Returns null on error (caller should treat as "don't speak").
 */
async function classifyMessages(
  chatContext: string,
  anthropic: Anthropic,
): Promise<ClassifierResult | null> {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      system: CLASSIFIER_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `Recent group chat:\n\n${chatContext}` },
      ],
    });

    const text = response.content.find((b) => b.type === 'text');
    if (!text) return null;

    const raw = (text as Anthropic.TextBlock).text;
    const parsed = JSON.parse(extractJson(raw));

    // Validate and normalize
    const scores: ClassifierScores = {
      is_question: clamp(parsed.scores?.is_question ?? 0),
      is_wrong: clamp(parsed.scores?.is_wrong ?? 0),
      is_stuck: clamp(parsed.scores?.is_stuck ?? 0),
      is_relevant: clamp(parsed.scores?.is_relevant ?? 0),
      is_directed: clamp(parsed.scores?.is_directed ?? 0),
      is_social: clamp(parsed.scores?.is_social ?? 0),
    };

    const validIntents: Set<string> = new Set([
      'answer',
      'correct',
      'unstick',
      'add-context',
      'notebook-surface',
      'mention',
      'none',
    ]);

    return {
      scores,
      speak: parsed.speak === true,
      confidence: clamp(parsed.confidence ?? 0),
      reason: parsed.reason || 'no reason given',
      intent: validIntents.has(parsed.intent) ? parsed.intent : 'none',
      trigger_message_index: Math.max(
        0,
        Math.floor(parsed.trigger_message_index ?? 0),
      ),
    };
  } catch (err) {
    console.error('[Classifier] Haiku classification failed:', err);
    return null;
  }
}

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

// ─── Singleton adaptive cooldown ────────────────────────────────────────────

/**
 * Module-level cooldown instance. Shared across all calls to shouldISpeak.
 * Can be restored from persisted state on startup.
 */
const adaptiveCooldown = new AdaptiveCooldown();

/** Export for state persistence and external recording. */
export function getAdaptiveCooldown(): AdaptiveCooldown {
  return adaptiveCooldown;
}

// ─── Main classifier ────────────────────────────────────────────────────────

const SILENT_DECISION: SpeakDecision = {
  shouldSpeak: false,
  reason: 'default silence',
  confidence: 0,
  intent: 'none',
};

/**
 * Check if a message is an explicit @mention or direct reply to the bot.
 * These ALWAYS get through — no classifier needed.
 */
export function isExplicitSummon(
  message: BufferedMessage,
  botUsername?: string,
): boolean {
  if (!botUsername) return false;
  const text = message.text.toLowerCase();
  const username = botUsername.toLowerCase();
  // Check for @mention in text
  if (text.includes(`@${username}`)) return true;
  // Also check common variations
  if (text.includes('@hermes')) return true;
  return false;
}

/**
 * Decide whether the bot should speak in response to the current
 * conversation state. This is the main entry point.
 *
 * IMPORTANT: Explicit @mentions and direct replies bypass this entirely.
 * The caller should check isExplicitSummon() first and route those to
 * the mention handler without consulting the classifier.
 *
 * Pipeline:
 * 1. Quick-reject: rate limiter, empty buffer
 * 2. LLM classification (Haiku): score on 6 axes
 * 3. Conversation flow analysis: rapid exchange, unanswered questions
 * 4. Adaptive cooldown: chattiness-adjusted threshold
 * 5. Final decision: combine all signals
 */
export async function shouldISpeak(
  buffer: MessageBuffer,
  rateLimiter: RateLimiter,
  anthropic: Anthropic,
  opts?: { botUsername?: string; forceCheck?: boolean },
): Promise<SpeakDecision> {
  const now = Date.now();
  const botUsername = opts?.botUsername;

  // ── Step 0: Quick rejects ──────────────────────────────────────────────

  if (buffer.size === 0) {
    return { ...SILENT_DECISION, reason: 'empty buffer' };
  }

  if (!rateLimiter.canPost(now) && !opts?.forceCheck) {
    return { ...SILENT_DECISION, reason: 'rate limited' };
  }

  const latest = buffer.latest();
  if (!latest) {
    return { ...SILENT_DECISION, reason: 'no latest message' };
  }

  // Don't evaluate our own messages
  if (
    botUsername &&
    latest.senderName.toLowerCase() === botUsername.toLowerCase()
  ) {
    return { ...SILENT_DECISION, reason: 'own message' };
  }

  // ── Step 1: LLM classification ─────────────────────────────────────────

  const chatContext = buffer.formatForContext(CLASSIFIER_CONTEXT_MESSAGES);
  const classification = await classifyMessages(chatContext, anthropic);

  if (!classification) {
    return { ...SILENT_DECISION, reason: 'classifier error' };
  }

  const { scores, confidence, reason, intent, trigger_message_index } =
    classification;

  console.log(
    `[Classifier] scores=${JSON.stringify(scores)} speak=${classification.speak} conf=${confidence.toFixed(2)} intent=${intent} reason="${reason}"`,
  );

  // If the LLM says don't speak with high confidence, respect that
  if (!classification.speak && confidence >= 0.7) {
    return {
      shouldSpeak: false,
      reason,
      confidence,
      intent: 'none',
    };
  }

  // ── Step 2: Conversation flow analysis ─────────────────────────────────

  const recentMessages = buffer.recent(CLASSIFIER_CONTEXT_MESSAGES);
  const flow = analyzeFlow(recentMessages, botUsername, now);

  console.log(
    `[Classifier] flow: rapidExchange=${flow.isRapidExchange} unanswered=${flow.hasUnansweredQuestion} answered=${flow.questionAlreadyAnswered} msgSinceBot=${flow.messagesSinceBotSpoke}`,
  );

  // Hard block: rapid exchange between two humans — don't interrupt
  if (flow.isRapidExchange && scores.is_directed < DIRECTED_BYPASS_SCORE) {
    return {
      shouldSpeak: false,
      reason: `${flow.exchangePair![0]} and ${flow.exchangePair![1]} are in rapid exchange — staying silent`,
      confidence: 0.9,
      intent: 'none',
    };
  }

  // Hard block: question already answered — don't pile on
  if (flow.questionAlreadyAnswered && intent === 'answer') {
    return {
      shouldSpeak: false,
      reason: 'question already answered by someone else',
      confidence: 0.8,
      intent: 'none',
    };
  }

  // ── Step 3: Adjust confidence based on flow signals ────────────────────

  let adjustedConfidence = confidence;
  const adjustments: string[] = [];

  // Boost: unanswered question + we can help
  if (
    flow.hasUnansweredQuestion &&
    (intent === 'answer' || intent === 'unstick')
  ) {
    adjustedConfidence = Math.min(1.0, adjustedConfidence + 0.15);
    adjustments.push('+0.15 unanswered question');
  }

  // Boost: directed at bot
  if (scores.is_directed >= DIRECTED_BYPASS_SCORE) {
    adjustedConfidence = Math.min(1.0, adjustedConfidence + 0.2);
    adjustments.push('+0.20 directed at bot');
  }

  // Penalty: social/phatic content
  if (scores.is_social > 0.6) {
    adjustedConfidence = Math.max(0, adjustedConfidence - 0.3);
    adjustments.push('-0.30 social/phatic');
  }

  // Penalty: bot spoke very recently (< 3 messages ago)
  if (flow.messagesSinceBotSpoke <= 2 && scores.is_directed < 0.5) {
    adjustedConfidence = Math.max(0, adjustedConfidence - 0.2);
    adjustments.push('-0.20 bot spoke very recently');
  }

  // Boost: bot hasn't spoken in 1+ hour
  if (adaptiveCooldown.timeSinceLastSpeak(now) > 60 * 60 * 1000) {
    adjustedConfidence = Math.min(1.0, adjustedConfidence + 0.1);
    adjustments.push('+0.10 silent for 1h+');
  }

  // Boost: wrong fact that matters
  if (scores.is_wrong > 0.7) {
    adjustedConfidence = Math.min(1.0, adjustedConfidence + 0.1);
    adjustments.push('+0.10 factual correction');
  }

  if (adjustments.length > 0) {
    console.log(
      `[Classifier] adjustments: ${adjustments.join(', ')} → conf=${adjustedConfidence.toFixed(2)}`,
    );
  }

  // ── Step 4: Adaptive threshold ─────────────────────────────────────────

  // Direct messages bypass adaptive cooldown entirely
  const bypassCooldown = scores.is_directed >= DIRECTED_BYPASS_SCORE;

  const threshold = bypassCooldown
    ? BASE_THRESHOLD
    : adaptiveCooldown.getThreshold(now);

  const chattiness = adaptiveCooldown.getChattiness(now);

  console.log(
    `[Classifier] threshold=${threshold.toFixed(2)} (chattiness=${chattiness.toFixed(2)}${bypassCooldown ? ', bypassed' : ''}) adjustedConf=${adjustedConfidence.toFixed(2)}`,
  );

  // ── Step 5: Final decision ─────────────────────────────────────────────

  // The LLM must have said speak=true OR we have very high adjusted confidence
  const llmSaysSpeak = classification.speak;
  const highConfidenceOverride = adjustedConfidence >= 0.85;
  const meetsThreshold = adjustedConfidence >= threshold;

  const shouldSpeak =
    meetsThreshold && (llmSaysSpeak || highConfidenceOverride);

  // Find the message to reply to
  let replyToMessageId: number | undefined;
  if (shouldSpeak && trigger_message_index >= 0) {
    const idx = recentMessages.length - 1 - trigger_message_index;
    if (idx >= 0 && idx < recentMessages.length) {
      replyToMessageId = recentMessages[idx].messageId;
    }
  }

  const decision: SpeakDecision = {
    shouldSpeak,
    reason: shouldSpeak
      ? reason
      : `below threshold (${adjustedConfidence.toFixed(2)} < ${threshold.toFixed(2)}): ${reason}`,
    confidence: adjustedConfidence,
    replyToMessageId,
    intent: shouldSpeak ? intent : 'none',
  };

  console.log(
    `[Classifier] DECISION: ${decision.shouldSpeak ? 'SPEAK' : 'SILENT'} (${decision.intent}) conf=${decision.confidence.toFixed(2)} reason="${decision.reason}"`,
  );

  return decision;
}

/**
 * Record that the bot actually spoke (call AFTER sending a message).
 * Updates both the adaptive cooldown and the rate limiter.
 */
export function recordBotSpoke(rateLimiter: RateLimiter, now = Date.now()): void {
  adaptiveCooldown.recordSpeak(now);
  rateLimiter.record(now);
}
