import { createCipheriv, createDecipheriv, createECDH, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { computeAddress, SigningKey } from 'ethers';
import type { JournalEntry, Conversation, Summary } from './storage.js';

export type RecordKind = 'posts' | 'conversations' | 'summaries';
export type RecordValue = JournalEntry | Conversation | Summary;
export interface RecordContext { ownerDid: string; space: string; prefix: string }
export const RECOVERY_KEY = 'recovery-v1';
export const canonical = (v: unknown): string => JSON.stringify(v, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([, x]) => x !== undefined).sort(([a], [b]) => a.localeCompare(b))) : value);
const context = (b: RecordContext) => [b.ownerDid.toLowerCase(), b.space, b.prefix];
const info = (domain: string, b: RecordContext, ...rest: unknown[]) => Buffer.from(JSON.stringify([domain, ...context(b), ...rest]));
const derive = (key: Uint8Array, information: Uint8Array) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(32), information, 32));
const mac = (key: Uint8Array, value: string | Uint8Array) => createHmac('sha256', key).update(value).digest('hex');
function checkMac(actual: unknown, expected: string) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)
    || !timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))) throw new Error('Author record integrity check failed');
}
function bytes(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid encrypted record encoding');
  const out = Buffer.from(value, 'base64url');
  if (out.toString('base64url') !== value || (length !== undefined && out.length !== length)) throw new Error('Invalid encrypted record size');
  return out;
}
function seal(key: Uint8Array, plaintext: string, aad: Uint8Array) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return { nonce: nonce.toString('base64url'), ciphertext: ciphertext.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function open(key: Uint8Array, envelope: any, aad: Uint8Array): string {
  const decipher = createDecipheriv('aes-256-gcm', key, bytes(envelope?.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(bytes(envelope?.tag, 16));
  return Buffer.concat([decipher.update(bytes(envelope?.ciphertext)), decipher.final()]).toString('utf8');
}
function recordValue(record: any, id: string): RecordValue {
  const value = record?.value;
  if (record?.version !== 1 || !value || value.id !== id || !/^[\w-]{1,160}$/.test(id)
    || !Number.isFinite(value.timestamp) || typeof value.content !== 'string') throw new Error('Invalid author record');
  return value;
}
export function ownerPublicKey(b: RecordContext, key: string): string {
  const owner = /^did:pkh:eip155:1:(0x[\da-fA-F]{40})$/.exec(b.ownerDid)?.[1];
  if (!owner || computeAddress(key).toLowerCase() !== owner.toLowerCase()) throw new Error('Recovery public key does not match the TinyCloud owner');
  return SigningKey.computePublicKey(key, true);
}
const recordAAD = (b: RecordContext, kind: RecordKind, id: string) => info('teleport-router/record/v2', b, kind, id);
const recoveryAAD = (b: RecordContext, recipient: string, ephemeral: string) => info('teleport-router/owner-recovery/v1', b, recipient, ephemeral);
export const ownerRecoveryProof = (key: Uint8Array, b: RecordContext, challenge: string, recovery: string) =>
  mac(key, info('teleport-router/recovery-confirmation/v1', b, challenge, recovery));

/** Encryption hides the entire signed record, including its audience and metadata.
 * Keep the independent Router MAC INSIDE the ciphertext: recovery gives the owner
 * the encryption key, but must not let them forge Router-authorized records. */
export function recordCodec(integrityKey: Uint8Array, encryptionRoot: Uint8Array) {
  if (integrityKey.length !== 32 || encryptionRoot.length !== 32) throw new Error('Author keys must be 32 bytes');
  const authorKey = (b: RecordContext) => derive(encryptionRoot, info('teleport-router/author-key/v1', b));
  // v1 deliberately keeps its original case-sensitive owner and canonicalization.
  const legacyMac = (owner: string, kind: RecordKind, value: RecordValue) => mac(integrityKey, `router-record-v1\0${owner}\0${kind}\0${canonical(value)}`);
  const recoveryMac = (b: RecordContext, envelope: unknown) => mac(integrityKey,
    Buffer.concat([info('teleport-router/recovery-integrity/v1', b), authorKey(b), Buffer.from(canonical(envelope))]));
  return {
    encode(b: RecordContext, kind: RecordKind, value: RecordValue) {
      const signed = canonical({ version: 1, value, mac: legacyMac(b.ownerDid, kind, value) });
      recordValue(JSON.parse(signed), value.id);
      return canonical({ version: 2, ...seal(authorKey(b), signed, recordAAD(b, kind, value.id)) });
    },
    decode(raw: string, b: RecordContext, kind: RecordKind, id: string, minVersion: 1 | 2 = 2): RecordValue {
      const envelope = JSON.parse(raw);
      const record = envelope?.version === 2 ? JSON.parse(open(authorKey(b), envelope, recordAAD(b, kind, id)))
        : envelope?.version === 1 && minVersion === 1 ? envelope : null;
      const value = recordValue(record, id);
      checkMac(record.mac, legacyMac(b.ownerDid, kind, value));
      return value;
    },
    createRecovery(b: RecordContext, publicKey: string): string {
      const recipient = ownerPublicKey(b, publicKey);
      const ephemeral = createECDH('secp256k1'); ephemeral.generateKeys();
      const ephemeralPublicKey = '0x' + ephemeral.getPublicKey('hex', 'compressed');
      const aad = recoveryAAD(b, recipient, ephemeralPublicKey);
      const wrappingKey = derive(ephemeral.computeSecret(Buffer.from(recipient.slice(2), 'hex')), aad);
      const payload = authorKey(b).toString('base64url');
      const sealed = seal(wrappingKey, payload, aad);
      if (open(wrappingKey, sealed, aad) !== payload) throw new Error('Owner recovery self-check failed');
      const envelope = { version: 1, suite: 'secp256k1-hkdf-sha256-aes256gcm', ownerDid: b.ownerDid, space: b.space,
        prefix: b.prefix, recipient, ephemeralPublicKey, ...sealed };
      return canonical({ ...envelope, mac: recoveryMac(b, envelope) });
    },
    verifyRecovery(raw: string, b: RecordContext, publicKey: string) {
      const { mac: actual, ...envelope } = JSON.parse(raw);
      if (envelope.version !== 1 || envelope.suite !== 'secp256k1-hkdf-sha256-aes256gcm'
        || canonical(context(envelope)) !== canonical(context(b)) || envelope.recipient !== ownerPublicKey(b, publicKey))
        throw new Error('Owner recovery context mismatch');
      checkMac(actual, recoveryMac(b, envelope));
    },
    verifyOwnerRecovery(proof: unknown, b: RecordContext, challenge: string, recovery: string) {
      checkMac(proof, ownerRecoveryProof(authorKey(b), b, challenge, recovery));
    },
  };
}

/** Owner-only recovery. No Router connection, grant, integrity key or TEE key needed.
 * AEAD authenticates the bytes to this key; the Router's private authorization MAC
 * is intentionally not verifiable here. An export is not an authorship receipt. */
export function recoverAuthorKey(privateKey: string, raw: string, b: RecordContext): Buffer {
  const envelope = JSON.parse(raw);
  const recipient = ownerPublicKey(b, SigningKey.computePublicKey(privateKey, true));
  if (envelope.version !== 1 || envelope.suite !== 'secp256k1-hkdf-sha256-aes256gcm'
    || canonical(context(envelope)) !== canonical(context(b)) || envelope.recipient !== recipient
    || !/^0x(?:02|03)[\da-f]{64}$/.test(envelope.ephemeralPublicKey || '')) throw new Error('Owner recovery context mismatch');
  const ecdh = createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(privateKey.replace(/^0x/, ''), 'hex'));
  const aad = recoveryAAD(b, recipient, envelope.ephemeralPublicKey);
  const wrappingKey = derive(ecdh.computeSecret(Buffer.from(envelope.ephemeralPublicKey.slice(2), 'hex')), aad);
  return bytes(open(wrappingKey, envelope, aad), 32);
}
export function decryptOwnerRecord(key: Uint8Array, raw: string, b: RecordContext, kind: RecordKind, id: string): RecordValue {
  const envelope = JSON.parse(raw);
  if (envelope?.version !== 2) throw new Error('Expected an encrypted author record');
  return recordValue(JSON.parse(open(key, envelope, recordAAD(b, kind, id))), id);
}
