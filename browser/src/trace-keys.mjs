import { Wallet, SigningKey, getBytes } from 'ethers';
import { b64, unb64 } from './recovery.mjs';

const utf8 = text => new TextEncoder().encode(text);
async function wrappingKey(privateKey, otherKey, aad, use) {
  const secret = getBytes(new SigningKey(privateKey).computeSharedSecret(otherKey)).slice(1, 33);
  try {
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad },
      material, { name: 'AES-GCM', length: 256 }, false, [use]);
  } finally { secret.fill(0); }
}
const aadFor = (did, id, part, role, recipient, ephemeral) =>
  utf8(JSON.stringify(['teleport-router/trace-wrap/v1', did.toLowerCase(), id, part, role, recipient, ephemeral]));

async function openWrap(w, did, id, part, role, privateKey) {
  const aad = aadFor(did, id, part, role, new SigningKey(privateKey).compressedPublicKey, w.ephemeralPublicKey);
  const ct = new Uint8Array(48); ct.set(unb64(w.ciphertext, 32)); ct.set(unb64(w.tag, 16), 32);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.nonce, 12), additionalData: aad },
    await wrappingKey(privateKey, w.ephemeralPublicKey, aad, 'decrypt'), ct));
}

/** Rewrap a content key on the owner's device. The trace bytes stay encrypted throughout. */
export async function rewrapTraceKey(meta, did, id, privateKey, targetKey, part = 'full', role = 'reader', verifyPrivateKey) {
  const key = await openWrap(meta.wraps.owner, did, id, part, 'owner', privateKey);
  try {
    const ephemeral = Wallet.createRandom().signingKey;
    const recipient = SigningKey.computePublicKey(targetKey, true);
    const aad = aadFor(did, id, part, role, recipient, ephemeral.compressedPublicKey);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: aad },
      await wrappingKey(ephemeral.privateKey, recipient, aad, 'encrypt'), key));
    const wrap = { ephemeralPublicKey: ephemeral.compressedPublicKey, nonce: b64(nonce), ciphertext: b64(sealed.slice(0, 32)), tag: b64(sealed.slice(32)) };
    if (verifyPrivateKey) {
      const check = await openWrap(wrap, did, id, part, role, verifyPrivateKey);
      try { if (!key.every((v, i) => v === check[i])) throw Error('The destination could not recover the trace key.'); }
      finally { check.fill(0); }
    }
    return wrap;
  } finally { key.fill(0); }
}

/** A move needs only the wrapped keys from the old trace, never its transcript. */
export async function prepareTraceMove(post, owner, from, recoveryKey) {
  const { entry_ids } = await post('/api/traces/list');
  const target = new SigningKey(recoveryKey).compressedPublicKey;
  for (const id of entry_ids) {
    if (!/^[\w-]{1,160}$/.test(id)) throw Error('Invalid trace identifier.');
    const record = await post('/api/traces/metadata', { entry_id: id });
    if (!record || record.entryId !== id || record.ownerDid !== from.did) throw Error('The source trace changed during the move.');
    const did = record.sealedOwnerDid || from.did;
    const patch = { source: from.did, target, hashes: {}, wraps: {} };
    for (const part of ['full', 'derived']) {
      if (!record[part]) continue;
      patch.hashes[part] = record[part].sha256;
      patch.wraps[part] = await rewrapTraceKey(record[part], did, id, from.privateKey, target, part, 'owner', recoveryKey);
    }
    const key = 'router/owner-move/' + from.did.split(':').at(-1).toLowerCase() + '/' + id;
    const saved = await owner.kv.put(key, JSON.stringify(patch));
    if (!saved.ok) throw Error('Could not prepare the trace keys in the new storage account.');
  }
}
