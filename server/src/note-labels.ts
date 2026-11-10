import type { JournalEntry } from './storage.js';

/** Labels a note can carry besides its text: the repository the work happened in, and topic tags.
 * Both are shown to whoever can read the note, so they follow the note's audience. */

const MAX_TAGS = 8;
const REPO_PART = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** "https://github.com/Owner/Name.git", "git@github.com:Owner/Name.git", "Owner/Name" or "Name"
 * become "owner/name" (or "name"). Anything that isn't a repository name returns undefined. */
export function normalizeRepo(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 300) return undefined;
  value = value.replace(/^[a-z+]+:\/\/([^@/]+@)?/, '').replace(/^[^@/\s]+@/, '');   // scheme and user
  value = value.replace(/^[^/:\s]+\.[a-z]{2,}[:/]/, '');                             // host
  value = value.replace(/[?#].*$/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = value.split('/').filter(Boolean).slice(-2);
  if (!parts.length || !parts.every(part => REPO_PART.test(part))) return undefined;
  return parts.join('/');
}

/** Lowercase slugs, at most eight, no duplicates: "#Speech Recognition" becomes "speech-recognition". */
export function normalizeTags(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const tags: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toLowerCase().replace(/^#+/, '').replace(/[\s_]+/g, '-').replace(/[^a-z0-9-]/g, '')
      .replace(/-{2,}/g, '-').replace(/^-|-$/g, '').slice(0, 32);
    if (tag && !tags.includes(tag)) tags.push(tag);
    if (tags.length === MAX_TAGS) break;
  }
  return tags.length ? tags : undefined;
}

export interface LabelFilter { repos: string[]; tags: string[] }

/** Reads comma-separated or repeated `repo` and `tag` query parameters. */
export function labelFilter(params: URLSearchParams): LabelFilter {
  const split = (name: string) => params.getAll(name).flatMap(v => v.split(','));
  return {
    repos: split('repo').map(normalizeRepo).filter((r): r is string => !!r),
    tags: normalizeTags(split('tag')) || [],
  };
}

/** A repo filter without an owner ("cue-api") matches that name under any owner. */
function repoMatches(entryRepo: string, wanted: string): boolean {
  return entryRepo === wanted || (!wanted.includes('/') && entryRepo.split('/').pop() === wanted);
}

/** True when the note matches any wanted repo or any wanted tag. An empty filter matches nothing. */
export function matchesLabels(entry: Pick<JournalEntry, 'repo' | 'tags'>, filter: LabelFilter): boolean {
  if (entry.repo && filter.repos.some(wanted => repoMatches(entry.repo!, wanted))) return true;
  return !!entry.tags?.some(tag => filter.tags.includes(tag));
}
