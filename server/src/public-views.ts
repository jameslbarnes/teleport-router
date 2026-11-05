import type { JournalEntry, Channel } from './storage.js';

/** Public human-facing summaries/previews cannot reveal addressed or AI-only text. */
export function isPublicNotebookEntry(entry: JournalEntry): boolean {
  return !entry.to?.length && !entry.channel && entry.visibility !== 'private'
    && !(entry.aiOnly ?? (entry.visibility === 'ai-only' || entry.humanVisible === false));
}

export function channelView(channel: Channel | null): Channel | null {
  if (!channel?.store) return channel;
  const { delegation, ...store } = channel.store;
  return { ...channel, store };
}
