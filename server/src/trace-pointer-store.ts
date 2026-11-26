/**
 * Trace pointers: Router's record that a post has a private trace, and where it is.
 *
 * When an author's agent posts from Claude Code or Codex, the author's capture script can tell Router that the
 * trace behind that post exists and is held on the author's machine. Nothing of the trace is sent: the pointer
 * holds the agent kind, the time, and a fingerprint (SHA-256) of the local log slice, which the script keeps
 * so that a later upload can be matched to it. Router does not check the fingerprint against anything.
 *
 * When the trace is uploaded (encrypted to its author, into their own storage), the same record says so. A
 * pointer never replaces or downgrades an uploaded trace, and only a post's author can register one, once.
 *
 * Anyone who can read the post may learn that a trace exists, which agent made it and whether it is uploaded
 * or held locally. Nobody who cannot read the post learns anything: the answer is the same as for a missing
 * post. The fingerprint goes back to the author only.
 */
import type { Firestore } from 'firebase-admin/firestore';
import type { JournalEntry } from './storage.js';

export type TraceAgent = 'claude-code' | 'codex';
export type TraceState = 'held_locally' | 'uploaded';
export interface TracePointer {
  entryId: string;
  /** The post's author as Router names them: "@handle", or the legacy pseudonym. */
  owner: string;
  state: TraceState;
  agent?: TraceAgent;
  /** SHA-256 of the raw session-log lines of the slice, as the author's script computed it. Never shown to anyone else. */
  sliceSha256?: string;
  registeredAt: number;
  uploadedAt?: number;
}
/** `registered`: the key belongs to a Router account. `pseudonym` is derived from the key itself. */
export interface TraceActor { pseudonym: string; handle?: string | null; registered?: boolean }

export class TracePointerError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const AGENTS: readonly TraceAgent[] = ['claude-code', 'codex'];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const notFound = () => new TracePointerError('Note not found.', 404);
export const ownerOf = (entry: Pick<JournalEntry, 'handle' | 'pseudonym'>) => entry.handle ? '@' + entry.handle : entry.pseudonym;
/**
 * Who owns a post's pointer: who may register it and see its fingerprint. A post with a handle belongs to the
 * account with that handle. A legacy post with no handle belongs to the registered account whose key gives the
 * post's legacy name.
 */
export const isPointerAuthor = (entry: Pick<JournalEntry, 'handle' | 'pseudonym'>, actor: TraceActor) =>
  entry.handle ? !!actor.handle && entry.handle === actor.handle
    : !!actor.registered && !!actor.pseudonym && entry.pseudonym === actor.pseudonym;

/** One document per post. */
export function tracePointerStore(db?: Firestore) {
  const memory = new Map<string, TracePointer>();
  const collection = db?.collection('tracePointers');
  return {
    async get(entryId: string): Promise<TracePointer | undefined> {
      return collection ? (await collection.doc(entryId).get()).data() as TracePointer | undefined : memory.get(entryId);
    },
    /** `update` sees the current record and returns the next one, or the same object to leave it alone. */
    async change(entryId: string, update: (current?: TracePointer) => TracePointer): Promise<TracePointer> {
      if (!db || !collection) {
        const current = memory.get(entryId), next = update(current);
        if (next !== current) memory.set(entryId, next);
        return next;
      }
      const ref = collection.doc(entryId);
      return db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data() as TracePointer | undefined;
        const next = update(current);
        if (next !== current) tx.set(ref, JSON.parse(JSON.stringify(next)));
        return next;
      });
    },
  };
}

interface Dependencies {
  store: ReturnType<typeof tracePointerStore>;
  /** The post, including a waiting one. */
  getEntry: (id: string) => Promise<JournalEntry | null>;
  /** The post if this actor may read it now (a waiting post only for its author), else null. */
  visible: (id: string, actor: TraceActor) => Promise<JournalEntry | null>;
  /** Whether the author's own storage already holds this post's trace, for traces uploaded before pointers existed. Optional. */
  storedTrace?: (entry: JournalEntry) => Promise<boolean>;
  now?: () => number;
}

export function tracePointers({ store, getEntry, visible, storedTrace, now = Date.now }: Dependencies) {
  /** What a reader may see. The author also gets the fingerprint they registered. */
  const view = (entryId: string, record: TracePointer | undefined, author: boolean) => record
    ? { entry_id: entryId, trace: record.state, agent: record.agent ?? null, registered_at: record.registeredAt,
        ...(record.uploadedAt ? { uploaded_at: record.uploadedAt } : {}), ...(author && record.sliceSha256 ? { slice_sha256: record.sliceSha256 } : {}) }
    : { entry_id: entryId, trace: null };

  return {
    /** The author says the trace behind one of their posts is held on their machine. Once per post; again is a no-op. */
    async register(actor: TraceActor, input: Record<string, unknown>) {
      if (!validId(input.entry_id)) throw new TracePointerError('entry_id is required.');
      const agent = input.agent;
      if (typeof agent !== 'string' || !AGENTS.includes(agent as TraceAgent)) throw new TracePointerError(`agent must be one of: ${AGENTS.join(', ')}.`);
      const slice = input.slice_sha256;
      if (typeof slice !== 'string' || !/^[a-f0-9]{64}$/.test(slice)) throw new TracePointerError('slice_sha256 must be 64 lowercase hex characters.');
      const entry = await getEntry(input.entry_id);
      // Someone else's post, or one that does not exist: the same answer, so this cannot be used to learn of waiting posts.
      if (!entry || !isPointerAuthor(entry, actor)) throw notFound();
      const existing = await store.get(entry.id);
      if (existing) return { ...view(entry.id, existing, true), registered: false };
      // A trace uploaded before pointers existed is recorded as uploaded, not as held locally. When that cannot be
      // checked, nothing is recorded: the answer is unknown, and the author's script tries again on its next run.
      let uploaded = false;
      if (storedTrace) {
        try { uploaded = await storedTrace(entry); }
        catch { throw new TracePointerError('Could not check whether this post already has an uploaded trace. Nothing was recorded; try again later.', 503); }
      }
      let created = false;
      const record = await store.change(entry.id, current => {
        if (current) return current;
        created = true;
        const at = now();
        return { entryId: entry.id, owner: ownerOf(entry), state: uploaded ? 'uploaded' : 'held_locally', agent: agent as TraceAgent, sliceSha256: slice,
          registeredAt: at, ...(uploaded ? { uploadedAt: at } : {}) };
      });
      return { ...view(entry.id, record, true), registered: created };
    },

    /** Called after Router stored a trace for this post in its author's storage. Creates the record or upgrades it; never the reverse. */
    async markUploaded(entry: Pick<JournalEntry, 'id' | 'handle' | 'pseudonym'>) {
      return store.change(entry.id, current => {
        if (current?.state === 'uploaded') return current;
        const at = now();
        return current ? { ...current, state: 'uploaded', uploadedAt: at } : { entryId: entry.id, owner: ownerOf(entry), state: 'uploaded', registeredAt: at, uploadedAt: at };
      });
    },

    /** What this actor may learn about the trace behind a post. Throws "not found" when they cannot read the post. */
    async status(actor: TraceActor, entryId: unknown) {
      if (!validId(entryId)) throw notFound();
      const entry = await visible(entryId, actor);
      if (!entry) throw notFound();
      return view(entry.id, await store.get(entry.id), isPointerAuthor(entry, actor));
    },

    /** The state alone, for callers that have already checked that the actor may read the post. */
    async stateOf(entryId: string): Promise<TraceState | null> {
      return (await store.get(entryId))?.state ?? null;
    },
  };
}
