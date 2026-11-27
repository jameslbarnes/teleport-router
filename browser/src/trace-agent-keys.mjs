import { SigningKey, getBytes, hexlify, sha256, toUtf8Bytes } from 'ethers';
import { agentWrapOpens, rewrapTraceKey } from './trace-keys.mjs';

const prefix = 'router/traces/agent.keys/v1/';

// Stable across devices and backup restores. Neither the storage signing key nor the
// OpenKey account recovery key is an agent credential.
export async function traceAgentKeys(accountKey, ownerDid, space, salt) {
  if (!/^0x[a-f0-9]{64}$/.test(salt)) throw Error('Invalid saved trace key salt.');
  const bytes = getBytes(accountKey);
  try {
    const material = await crypto.subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits']);
    const info = toUtf8Bytes(JSON.stringify(['teleport-router/trace-agent-secret/v1', ownerDid.toLowerCase(), space]));
    const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: getBytes(salt), info }, material, 256));
    try {
      const traceKey = hexlify(secret);
      const account = new SigningKey(accountKey), publicKey = new SigningKey(traceKey).compressedPublicKey;
      const message = JSON.stringify(['teleport-router/trace-agent-public/v1', ownerDid.toLowerCase(), space, account.compressedPublicKey, publicKey]);
      return { traceKey, certificate: { salt, publicKey, signature: account.sign(sha256(toUtf8Bytes(message))).serialized } };
    } finally { secret.fill(0); }
  } finally { bytes.fill(0); }
}

async function readKeyRecord(owner, path) {
  const got = await owner.kv.get(prefix + path, { source: 'network' });
  if (!got.ok) {
    if (got.error?.code === 'KV_NOT_FOUND' && got.error.message === 'Key not found: ' + prefix + path) return null;
    throw Error('Could not read trace keys from your storage.');
  }
  const raw = got.data.data;
  return { value: typeof raw === 'string' ? JSON.parse(raw) : raw, etag: got.data.headers?.etag };
}

export async function registerAgentKey(owner, accountKey, rotate = false) {
  const existing = await readKeyRecord(owner, 'public');
  async function restore(record) {
    const keys = await traceAgentKeys(accountKey, owner.did, owner.spaceId, record.value.salt);
    if (keys.certificate.publicKey !== record.value.publicKey || keys.certificate.signature !== record.value.signature)
      throw Error('The registered trace key does not match your account. Replace the trace key to continue.');
    return keys;
  }
  if (existing && !rotate) return restore(existing);
  if (existing && !/^"[^"\r\n]+"$/.test(existing.etag || '')) throw Error('Storage did not return a version for the trace key. Retry replacement.');
  const fresh = await traceAgentKeys(accountKey, owner.did, owner.spaceId, hexlify(crypto.getRandomValues(new Uint8Array(32))));
  const saved = await owner.kv.put(prefix + 'public', JSON.stringify(fresh.certificate), existing ? { ifMatch: existing.etag } : { ifNoneMatch: '*' });
  if (!saved.ok) {
    // Concurrent first-time pairing may have registered another valid key. Both machines
    // must use the winner. Never silently undo a replacement on another device.
    const winner = !rotate && !existing && await readKeyRecord(owner, 'public');
    if (winner) return restore(winner);
    throw Error('Could not register the trace key. Refresh the authorization and try again.');
  }
  return fresh;
}

// Only wrapped per-note keys are added. Original records and ciphertext remain available
// to older owner tools. A retry or another browser using the same backup gets the same key.
export async function prepareAgentTraces(api, owner, accountKey, keys, progress) {
  const { entry_ids: ids } = await api('/api/traces/list', {});
  const pending = [];
  async function prepare(id) {
    if (!/^[\w-]{1,160}$/.test(id)) throw Error('Invalid trace identifier.');
    const record = await api('/api/traces/metadata', { entry_id: id });
    if (record.entryId !== id || record.ownerDid?.toLowerCase() !== owner.did.toLowerCase() || !/^[a-f0-9]{64}$/.test(record.full?.sha256)) {
      throw Error('The trace metadata does not match your storage account.');
    }
    const did = record.sealedOwnerDid || record.ownerDid;
    if (await agentWrapOpens(record.full.wraps?.agent, did, id, keys.traceKey)) return;
    const path = `${keys.certificate.publicKey}/${id}/${record.full.sha256}`;
    const existing = await readKeyRecord(owner, path);
    if (await agentWrapOpens(existing?.value, did, id, keys.traceKey)) return;
    const wrap = await rewrapTraceKey(record.full, did, id, accountKey,
      keys.certificate.publicKey, 'full', 'agent', keys.traceKey);
    const saved = await owner.kv.put(prefix + path, JSON.stringify(wrap));
    if (!saved.ok) throw Error('Could not save the trace key.');
  }
  for (let i = 0; i < ids.length; i += 4) {
    progress?.(`Preparing existing traces (${i} of ${ids.length} checked)…`);
    await Promise.all(ids.slice(i, i + 4).map(async id => {
      try { await prepare(id); } catch { pending.push(id); }
    }));
  }
  return pending;
}
