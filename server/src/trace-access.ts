import { createHash, randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { computeAddress, SigningKey } from 'ethers';
import { tracePointer } from './trace-pointer.js';
import type { JournalEntry, User } from './storage.js';
import type { KeyWrap } from './trace-envelope.js';

export const TRACE_GRANT_MS = 24 * 3600_000;
export const traceFolder = (entryId: string) => `router/traces/${entryId}/`;
export const readerDid = (key: string) => 'did:pkh:eip155:1:' + computeAddress(key);
interface Actor { pseudonym: string; keyHash: string; user: User | null }
interface Approval { delegation: string; wrap: KeyWrap; expires: number; ownerDid: string; host: string }
interface Request {
  id: string; revision: string; entryId: string; owner: string; requester: string; requesterName: string;
  publicKey: string; created: number; state: 'pending' | 'declined' | 'approved'; approval?: Approval;
}
export class TraceRequestError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const missing = () => new TraceRequestError('Request or note not found.', 404);
const identities = (actor: Actor) => [actor.pseudonym, ...(actor.user ? ['@' + actor.user.handle] : [])];
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
function checkedKey(key: unknown) {
  if (typeof key !== 'string' || !/^0x(?:02|03)[0-9a-fA-F]{64}$/.test(key)) throw new TraceRequestError('Give the compressed public key of the agent that will read the trace.');
  try { return SigningKey.computePublicKey(key, true); } catch { throw new TraceRequestError('Invalid reader public key.'); }
}
function checkedWrap(value: any): KeyWrap {
  const field = (v: unknown, n: number) => typeof v === 'string' && Buffer.from(v, 'base64url').length === n && Buffer.from(v, 'base64url').toString('base64url') === v;
  if (!value || !field(value.nonce, 12) || !field(value.tag, 16) || !field(value.ciphertext, 32)) throw new TraceRequestError('Invalid reader key envelope.');
  return { ephemeralPublicKey: checkedKey(value.ephemeralPublicKey), nonce: value.nonce, tag: value.tag, ciphertext: value.ciphertext };
}

/** One document per requester and post. Retrying an ask never creates a second inbox item. */
export function traceRequestStore(db?: Firestore) {
  const memory = new Map<string, Request>();
  const collection = db?.collection('traceAccessRequests');
  return {
    async get(id: string): Promise<Request | undefined> {
      return collection ? (await collection.doc(id).get()).data() as Request | undefined : memory.get(id);
    },
    async pending(owner: string): Promise<Request[]> {
      if (!collection) return [...memory.values()].filter(r => r.owner === owner && r.state === 'pending');
      const snapshot = await collection.where('owner', '==', owner).where('state', '==', 'pending').get();
      return snapshot.docs.map(doc => doc.data() as Request);
    },
    async change(id: string, update: (current?: Request) => Request): Promise<Request> {
      if (!db || !collection) { const next = update(memory.get(id)); memory.set(id, next); return next; }
      const ref = collection.doc(id);
      return db.runTransaction(async tx => {
        const current = (await tx.get(ref)).data() as Request | undefined;
        const next = update(current);
        if (next !== current) tx.set(ref, next);
        return next;
      });
    },
  };
}
interface Dependencies {
  store: ReturnType<typeof traceRequestStore>;
  visible: (entryId: string, actor: Actor) => Promise<JournalEntry | null>;
  getUser: (keyHash: string) => Promise<User | null>;
  host: string;
  now?: () => number;
}
export function traceAccess({ store, visible, getUser, host, now = Date.now }: Dependencies) {
  function view(r: Request, includeGrant = false) {
    return {
      request_id: r.id, revision: r.revision, entry_id: r.entryId, trace_url: tracePointer(r.entryId),
      owner: r.owner, requester: r.requesterName, reader_public_key: r.publicKey, reader_did: readerDid(r.publicKey),
      requested_at: r.created, state: r.approval && r.approval.expires <= now() ? 'expired' : r.state,
      ...(r.approval ? { expires_at: r.approval.expires } : {}),
      ...(includeGrant && r.approval && r.approval.expires > now() ? { grant: r.approval } : {}),
    };
  }
  return async (actor: Actor, input: Record<string, unknown>) => {
    if (input.action === 'request') {
      if (!validId(input.entry_id)) throw missing();
      const entry = await visible(input.entry_id, actor);
      if (!entry) throw missing();
      const owner = entry.handle ? '@' + entry.handle : entry.pseudonym;
      if (identities(actor).includes(owner)) throw new TraceRequestError('This is your own trace.');
      const publicKey = checkedKey(input.reader_public_key);
      const id = createHash('sha256').update(JSON.stringify([entry.id, owner, actor.keyHash])).digest('hex');
      const request = await store.change(id, current => {
        if (current && !(current.approval && current.approval.expires <= now())) {
          if (current.publicKey !== publicKey) throw new TraceRequestError('A request already exists for this note under a different reader key.', 409);
          return current;
        }
        return { id, revision: randomUUID(), entryId: entry.id, owner, requester: actor.keyHash, requesterName: identities(actor).at(-1)!,
          publicKey, created: now(), state: 'pending' };
      });
      return view(request);
    }
    if (input.action === 'inbox') {
      const records = (await Promise.all(identities(actor).map(owner => store.pending(owner)))).flat();
      const current = await Promise.all(records.map(async r => await visible(r.entryId, actor) ? r : null));
      return { requests: current.filter((r): r is Request => r !== null).sort((a, b) => a.created - b.created).map(r => view(r)) };
    }
    if (typeof input.request_id !== 'string' || !/^[a-f0-9]{64}$/.test(input.request_id)) throw missing();
    const r = await store.get(input.request_id);
    if (!r || !identities(actor).includes(r.owner) && actor.keyHash !== r.requester) throw missing();
    const entry = await visible(r.entryId, actor);
    if (!entry || (entry.handle ? '@' + entry.handle : entry.pseudonym) !== r.owner && entry.pseudonym !== r.owner) throw missing();
    if (input.action === 'status') return view(r, actor.keyHash === r.requester);
    if (!identities(actor).includes(r.owner)) throw missing();
    if (input.action !== 'approve' && input.action !== 'decline') throw new TraceRequestError('Unknown trace request action.');
    let approval: Approval | undefined;
    if (input.action === 'approve') {
      const requester = { keyHash: r.requester, user: await getUser(r.requester), pseudonym: r.requesterName };
      if (!await visible(r.entryId, requester)) throw new TraceRequestError('The requester can no longer see this post.', 409);
      const binding = actor.user?.tinycloud;
      if (!binding) throw new TraceRequestError('Link your TinyCloud storage first.');
      const wire = input.delegation;
      if (typeof wire !== 'string' || wire.length > 90000) throw new TraceRequestError('A TinyCloud read grant is required.');
      const { signedFolderGrant } = await import('./tinycloud-grant-scope.js');
      let expires: number;
      try {
        expires = signedFolderGrant(wire, {space:binding.space,ownerDid:binding.ownerDid,delegateDid:readerDid(r.publicKey),
          path:traceFolder(r.entryId),actions:['tinycloud.kv/get'],host,maxMs:TRACE_GRANT_MS}, now());
      } catch { throw new TraceRequestError('The signed TinyCloud permission must give this reader get-only access to this one trace for up to 24 hours.'); }
      approval = { delegation: wire, wrap: checkedWrap(input.wrap), expires, ownerDid: binding.ownerDid, host };
    }
    return view(await store.change(r.id, current => {
      if (!current || current.revision !== input.revision) throw new TraceRequestError('This request changed. Review it again.', 409);
      if (current.state !== 'pending') {
        if (approval ? current.approval?.delegation === approval.delegation : current.state === 'declined') return current;
        throw new TraceRequestError('This request has already been answered.', 409);
      }
      return approval ? { ...current, state: 'approved', approval } : { ...current, state: 'declined' };
    }));
  };
}
