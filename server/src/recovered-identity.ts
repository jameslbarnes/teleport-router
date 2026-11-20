import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface RouterKeys {
  identity: Buffer;
  encryption: Buffer;
}

const label = Buffer.from('teleport-router/kms-recovery/aes-256-gcm/v1');
const version = 1;

function wrappingKey(current: RouterKeys) {
  return Buffer.from(hkdfSync('sha256', current.encryption, current.identity, label, 32));
}

/** The recovery volume only holds ciphertext. Both current enclave keys are required to open it. */
export function sealRecoveredKeys(original: RouterKeys, current: RouterKeys): Buffer {
  if (original.identity.length !== 32 || original.encryption.length !== 32) throw Error('Invalid Router key size');
  const nonce = randomBytes(12);
  const key = wrappingKey(current);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(label);
    const ciphertext = Buffer.concat([cipher.update(original.identity), cipher.update(original.encryption), cipher.final()]);
    return Buffer.concat([Buffer.from([version]), nonce, ciphertext, cipher.getAuthTag()]);
  } finally { key.fill(0); }
}

export function openRecoveredKeys(record: Buffer, current: RouterKeys): RouterKeys {
  if (record.length !== 93 || record[0] !== version) throw Error('Invalid Router key recovery record');
  const key = wrappingKey(current);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, record.subarray(1, 13));
    decipher.setAAD(label);
    decipher.setAuthTag(record.subarray(77));
    const plain = decipher.update(record.subarray(13, 77));
    try { decipher.final(); } catch (error) { plain.fill(0); throw error; }
    return { identity: plain.subarray(0, 32), encryption: plain.subarray(32) };
  } finally { key.fill(0); }
}
