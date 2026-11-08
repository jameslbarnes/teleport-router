/**
 * Write-back: summarize interesting Telegram conversations and
 * write them as Router notebook entries under the bot's identity.
 *
 * Triggers on conversational heat (multiple people exchanging substantive
 * messages), not just message count.
 *
 * Last writeback time persists across restarts.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { BotContext } from './types.js';
import type { MessageBuffer } from './buffer.js';
import { WRITEBACK_PROMPT } from './prompts.js';
import { announcePlatformEntry } from '../platform-sharing-notice.js';

/** Minimum time between write-backs (ms). */
const MIN_WRITEBACK_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours
/** How many recent messages to summarize. */
const CONTEXT_MESSAGES = 40;

export class Writer {
  private lastWritebackTime: number;
  private anthropic: Anthropic;

  constructor(
    private ctx: BotContext,
    private buffer: MessageBuffer,
    anthropicApiKey: string,
    restoredLastWritebackTime?: number,
  ) {
    this.anthropic = new Anthropic({ apiKey: anthropicApiKey });
    this.lastWritebackTime = restoredLastWritebackTime || 0;
    if (this.lastWritebackTime > 0) {
      const agoMin = Math.round((Date.now() - this.lastWritebackTime) / 60000);
      console.log(`[Telegram/Writer] Restored last writeback time (${agoMin}min ago)`);
    }
  }

  /** Expose last writeback time for state persistence. */
  getLastWritebackTime(): number {
    return this.lastWritebackTime;
  }

  /**
   * Check whether conditions are met for a write-back.
   * Uses conversation heat instead of raw message count.
   */
  shouldWrite(now = Date.now()): boolean {
    if (now - this.lastWritebackTime < MIN_WRITEBACK_INTERVAL_MS) return false;
    const heat = this.buffer.measureHeat(15 * 60 * 1000, now);
    if (!heat.isHot) return false;
    return true;
  }

  /**
   * Summarize the recent conversation and write it to Router.
   * Returns the entry content if written, or null if skipped.
   */
  async tryWriteBack(now = Date.now()): Promise<string | null> {
    if (!this.shouldWrite(now)) return null;

    const chatContext = this.buffer.formatForContext(CONTEXT_MESSAGES);
    if (chatContext === '(no recent messages)') return null;

    const heat = this.buffer.measureHeat(15 * 60 * 1000, now);
    console.log(
      `[Telegram/Writer] Conversation heat: ${heat.recentCount} msgs, ${heat.uniqueSenders} people, avg ${heat.avgLength} chars`,
    );

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 512,
        system: WRITEBACK_PROMPT,
        messages: [{ role: 'user', content: `Telegram discussion:\n\n${chatContext}` }],
      });

      const text = response.content.find((b) => b.type === 'text');
      if (!text) return null;
      const summary = (text as Anthropic.TextBlock).text.trim();

      if (summary === 'SKIP') {
        console.log('[Telegram/Writer] Claude chose to SKIP write-back');
        this.lastWritebackTime = now;
        return null;
      }

      const entry = await this.ctx.storage.addEntry(
        {
          pseudonym: this.ctx.botPseudonym,
          handle: this.ctx.botHandle,
          client: 'code',
          content: summary,
          timestamp: now,
        },
        0,
      );

      await announcePlatformEntry(entry, this.ctx.storage, this.ctx.config.baseUrl, async notice => {
        await this.ctx.sendToGroup(notice);
        return `telegram:${this.ctx.config.groupChatId}:router-entry:${entry.id}`;
      });

      this.lastWritebackTime = now;
      console.log(`[Telegram/Writer] Wrote entry ${entry.id} (${summary.length} chars)`);
      return summary;
    } catch (err) {
      console.error('[Telegram/Writer] Write-back failed:', err);
      return null;
    }
  }
}
