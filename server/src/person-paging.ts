import { compareByPersonOrder, decodePersonCursor, encodePageCursor, isOlderThan, type EntryBound, type EntryPageOptions,
  type JournalEntry, type Storage } from './storage.js';

/** A batch size meaning "everything after the place in one read", for storage held in memory. */
export const PERSON_SCAN_ALL = Number.MAX_SAFE_INTEGER;

/**
 * Where `/api/entries/:identifier` reads from: the handle when any note carries that handle, otherwise the pseudonym.
 * Decided once per request by a one-note query that ignores the cursor, so every page of a list takes the same path.
 */
export async function personNotesSource(
  storage: Pick<Storage, 'getEntriesByHandle' | 'getEntriesByPseudonym'>,
  identifier: string,
  includePending: boolean,
): Promise<(before: EntryBound | undefined, n: number) => Promise<JournalEntry[]>> {
  const byHandle = (await storage.getEntriesByHandle(identifier, 1)).length > 0;
  return (before, n) => {
    if (byHandle) return storage.getEntriesByHandle(identifier, n, undefined, before);
    // StagedStorage also reads includePending; other storages ignore it.
    const options: EntryPageOptions & { includePending: boolean } = { includePending, before };
    return storage.getEntriesByPseudonym(identifier, n, options);
  };
}

/** The `cursor` of a per-person list: absent, a place to start after, or malformed (the route answers 400). */
export function personPageCursor(url: URL): { start?: EntryBound } | null {
  const raw = url.searchParams.get('cursor');
  if (!raw) return {};
  const start = decodePersonCursor(raw);
  return start ? { start } : null;
}

/** Two lists already in a person's order as one, without repeats, at most `n` long. */
export function mergePersonNotes(a: JournalEntry[], b: JournalEntry[], n: number): JournalEntry[] {
  const merged: JournalEntry[] = [];
  const seen = new Set<string>();
  let i = 0, j = 0;
  while (merged.length < n && (i < a.length || j < b.length)) {
    const next = j >= b.length || (i < a.length && compareByPersonOrder(a[i], b[j]) <= 0) ? a[i++] : b[j++];
    if (!seen.has(next.id)) { seen.add(next.id); merged.push(next); }
  }
  return merged;
}

export interface PersonPageRequest {
  /** Up to `n` notes after `before`, in a person's order (storage.ts `compareByPersonOrder`). */
  fetch: (before: EntryBound | undefined, n: number) => Promise<JournalEntry[]>;
  visible: (entry: JournalEntry) => Promise<boolean>;
  limit: number;
  start?: EntryBound;
  /** Notes per storage read: small for Firestore; PERSON_SCAN_ALL for storage held in memory, so one read covers the request. */
  batch: number;
}

/**
 * One page of one person's notes as this reader may see them.
 *
 * It reads on until it has `limit` visible notes and one more, or the notes run out, so a page is short only at the
 * end, and its cursor is the last note on it. Pages and cursors are therefore the same for this reader whether or not
 * notes they cannot see sit between visible ones. Results are taken in the order storage returns them, never sorted
 * again; a note that is not after the previous one is skipped, so none is ever shown twice.
 *
 * There is no cap on how many notes one request reads: a cap would end the list early when many hidden notes sit before
 * a visible one. The scan is bounded by the person's own note count. The time a request takes can still reflect how
 * many notes it scanned, hidden ones included.
 */
export async function personPage(request: PersonPageRequest): Promise<{ entries: JournalEntry[]; nextCursor: string | null }> {
  const { fetch, visible, limit, start, batch: n } = request;
  const shown: JournalEntry[] = [];
  let position = start;
  for (;;) {
    const read = await fetch(position, n);
    for (const entry of read) {
      if (!isOlderThan(entry, position)) continue;
      position = { timestamp: entry.timestamp, id: entry.id };
      if (await visible(entry)) shown.push(entry);
      if (shown.length > limit) break;
    }
    if (shown.length > limit) {
      const entries = shown.slice(0, limit);
      return { entries, nextCursor: encodePageCursor(entries[entries.length - 1]) };
    }
    if (read.length < n || read.length === 0) return { entries: shown, nextCursor: null };
  }
}

/** A page, or 503 when storage could not be read: a reader must never take a failed read for the end of the list. */
export async function personPageAnswer<T>(work: () => Promise<T>): Promise<{ status: 200; body: T } | { status: 503; body: { error: string } }> {
  try {
    return { status: 200, body: await work() };
  } catch (err) {
    console.error('Reading a person\'s notes failed:', err);
    return { status: 503, body: { error: 'Notes could not be read just now. Try again.' } };
  }
}
