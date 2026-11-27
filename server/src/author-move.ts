import { createHash } from 'node:crypto';
import type { AuthorBinding } from './author-store.js';
import type { GroupStore } from './group-store.js';
import { canonical, recordCodec, type RecordKind, type RecordValue } from './author-records.js';
import { checkPartMeta } from './trace-envelope.js';

const digest = (raw: string) => createHash('sha256').update(raw).digest('hex');
const sorted = (keys: string[]) => canonical([...keys].sort());
const note = /^(posts|conversations|summaries)\/([\w-]{1,160})$/;
const trace = /^traces\/([\w-]{1,160})\/meta$/;
const safePath = (key: string) => typeof key === 'string' && !/[\\\u0000-\u001f]/.test(key) && key.split('/').every(s => s && s !== '.' && s !== '..');

/** Copy the old owner's folder without deleting it. Retry accepts only identical material at the destination.
 * A trace's ciphertext and original AEAD context stay together. Only its owner key wrap changes. */
export async function moveAuthorFolder(source: GroupStore, target: GroupStore, before: AuthorBinding, after: AuthorBinding,
  codec: ReturnType<typeof recordCodec>, belongs: (value: RecordValue) => boolean, due: () => void) {
  const oldAddress = before.ownerDid.split(':').at(-1)!.toLowerCase();
  const newKey = after.networkRecovery?.publicKey || after.ownerPublicKey;
  const sourceKeys = await source.list('');
  if (before.minRecordVersion === 2) {
    const recovery = await source.get('recovery-v1');
    if (!sourceKeys.includes('recovery-v1') || !recovery || !before.ownerPublicKey) throw new Error('The source recovery record is missing.');
    codec.verifyRecovery(recovery, before, before.ownerPublicKey);
  }
  const sourceHashes = new Map<string, string>();
  const outputs = new Map<string, string>();
  const targetKeys = await target.list('');
  // Never adopt records left by a different move, including records the owner subsequently deleted.
  const live = new Set(sourceKeys);
  if (targetKeys.some(k => /^(posts|conversations|summaries|traces)\//.test(k) && !live.has(k)))
    throw new Error('The destination already contains different Router records.');
  for (const key of sourceKeys) {
    due();
    if (!safePath(key)) throw new Error('The source contains a path that cannot be moved.');
    const raw = await source.get(key);
    if (raw === null) throw new Error('Storage changed during the move. Retry.');
    sourceHashes.set(key, digest(raw));
    let path = key, wire = raw;
    const record = note.exec(key), meta = trace.exec(key);
    const prior = await target.get(key);
    if (record) {
      const kind = record[1] as RecordKind, id = record[2];
      const value = codec.decode(raw, before, kind, id, before.minRecordVersion || 1);
      if (!belongs(value)) throw new Error('The source record belongs to a different author.');
      if (prior !== null && canonical(codec.decode(prior, after, kind, id, 2)) !== canonical(value))
        throw new Error('The destination contains a conflicting Router record.');
      wire = prior ?? codec.encode(after, kind, value);
    } else if (meta) {
      const old = JSON.parse(raw), id = meta[1];
      const patch = JSON.parse(await target.get('owner-move/' + oldAddress + '/' + id) || 'null');
      if (old.v !== 1 || old.ownerDid !== before.ownerDid || old.entryId !== id || !patch || patch.source !== before.ownerDid || patch.target !== newKey)
        throw new Error('Prepare the existing private traces on the owner device before moving.');
      const moved = { ...old, ownerDid: after.ownerDid, sealedOwnerDid: old.sealedOwnerDid || before.ownerDid };
      for (const part of ['full', 'derived']) {
        if (!old[part]) continue;
        if (patch.hashes[part] !== old[part].sha256) throw new Error('A trace changed during the move.');
        moved[part] = { ...old[part], wraps: { ...old[part].wraps, owner: patch.wraps[part] } };
        delete moved[part].wraps.agent;
        checkPartMeta(moved[part], ['owner'], part === 'full' ? ['release'] : []);
      }
      wire = canonical(moved);
      if (prior !== null && prior !== wire) {
        // A retry minted a fresh wrap for the same key. Only that wrap may be replaced.
        const earlier = JSON.parse(prior);
        for (const part of ['full', 'derived']) if (earlier[part] && moved[part]) earlier[part].wraps.owner = moved[part].wraps.owner;
        if (canonical(earlier) !== wire || !target.getVersioned) throw new Error('The destination trace differs.');
        const v = await target.getVersioned(key);
        if (!v || v.value !== prior) throw new Error('The destination changed during the move.');
        await target.put(key, wire, {ifMatch:v.etag});
      }
    } else if (!key.startsWith('traces/') || key.startsWith('traces/agent.keys/v1/')) {
      // Preserve the original recovery record and signed consents as history. A consent cannot transfer identities.
      path = 'previous-owners/' + oldAddress + '/' + key;
    }
    const existing = await target.get(path);
    if (existing === null) await target.put(path, wire, {ifNoneMatch:'*'});
    if (await target.get(path) !== wire) throw new Error('The destination differs from the source.');
    outputs.set(path, digest(wire));
  }
  return async () => {
    due();
    if (sorted(await source.list('')) !== sorted(sourceKeys)) throw new Error('The source changed before the storage switch.');
    const actual = (await target.list('')).filter(k => /^(posts|conversations|summaries|traces)\//.test(k));
    if (actual.some(k => !outputs.has(k))) throw new Error('The destination changed before the storage switch.');
    for (const [store, snapshot] of [[source,sourceHashes],[target,outputs]] as const) {
      for (const [key, hash] of snapshot) {
        due();
        const current = await store.get(key);
        if (current === null || digest(current) !== hash) throw new Error('A record changed before the storage switch.');
      }
    }
  };
}
