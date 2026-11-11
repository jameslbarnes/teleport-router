/** Envelope encryption for the private trace behind one post.
 *
 * A trace has up to two parts, each encrypted once with its own random AES-256-GCM key:
 *   full     the session slice for the owner's own reading. Wrapped to the owner only.
 *   derived  a shorter copy made for insights runs. Wrapped to the owner and, when the owner
 *            has signed a consent, to the enclave's release key.
 * A content key is wrapped per recipient: ephemeral secp256k1 ECDH, HKDF-SHA-256, AES-256-GCM.
 * Associated data binds the owner, the post and the part, so a ciphertext or a wrapped key
 * cannot be moved to another post, part or recipient.
 *
 * plugins/teleport-router/scripts/trace-lib.mjs implements the same format for the capture
 * client; insights-release.test.ts checks the two against each other.
 */
import { createCipheriv, createDecipheriv, createECDH, createHash, hkdfSync, randomBytes, ECDH } from 'node:crypto';

export type TracePart = 'full' | 'derived';
export type WrapRole = 'owner' | 'release';
export interface TraceContext { ownerDid: string; entryId: string }
export interface KeyWrap { ephemeralPublicKey: string; nonce: string; ciphertext: string; tag: string }
export interface PartMeta {
  nonce: string; tag: string; sha256: string; bytes: number;
  wraps: Partial<Record<WrapRole, KeyWrap>>;
}

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64url');
function unb64(value: unknown, length?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Invalid trace envelope encoding');
  const out = Buffer.from(value, 'base64url');
  if (out.toString('base64url') !== value || (length !== undefined && out.length !== length)) throw new Error('Invalid trace envelope field');
  return out;
}
export const sha256Hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Compressed secp256k1 public key, 0x-prefixed. Accepts compressed or uncompressed input. */
export function compressPublicKey(publicKey: string): string {
  const raw = Buffer.from(String(publicKey).replace(/^0x/, ''), 'hex');
  if (raw.length !== 33 && raw.length !== 65) throw new Error('Expected a secp256k1 public key');
  return '0x' + Buffer.from(ECDH.convertKey(raw, 'secp256k1', undefined, undefined, 'compressed') as Buffer).toString('hex');
}
export function publicKeyOf(privateKey: string): string {
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Expected a 32-byte hex private key');
  const ecdh = createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(privateKey.slice(2), 'hex'));
  return '0x' + ecdh.getPublicKey('hex', 'compressed');
}

const partAAD = (c: TraceContext, part: TracePart) =>
  Buffer.from(JSON.stringify(['teleport-router/trace/v1', c.ownerDid.toLowerCase(), c.entryId, part]));
const wrapAAD = (c: TraceContext, part: TracePart, role: WrapRole, recipient: string, ephemeral: string) =>
  Buffer.from(JSON.stringify(['teleport-router/trace-wrap/v1', c.ownerDid.toLowerCase(), c.entryId, part, role, recipient, ephemeral]));
const kek = (secret: Uint8Array, aad: Uint8Array) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), aad, 32));

export function wrapKey(contentKey: Uint8Array, c: TraceContext, part: TracePart, role: WrapRole, recipientPublicKey: string): KeyWrap {
  const recipient = compressPublicKey(recipientPublicKey);
  const ephemeral = createECDH('secp256k1'); ephemeral.generateKeys();
  const ephemeralPublicKey = '0x' + ephemeral.getPublicKey('hex', 'compressed');
  const aad = wrapAAD(c, part, role, recipient, ephemeralPublicKey);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', kek(ephemeral.computeSecret(Buffer.from(recipient.slice(2), 'hex')), aad), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(contentKey), cipher.final()]);
  return { ephemeralPublicKey, nonce: b64(nonce), ciphertext: b64(ciphertext), tag: b64(cipher.getAuthTag()) };
}

export function unwrapKey(wrap: KeyWrap | undefined, c: TraceContext, part: TracePart, role: WrapRole, privateKey: string): Buffer {
  if (!wrap || !/^0x(?:02|03)[0-9a-f]{64}$/.test(wrap.ephemeralPublicKey || '')) throw new Error('This trace part is not wrapped for that key');
  const ecdh = createECDH('secp256k1'); ecdh.setPrivateKey(Buffer.from(privateKey.replace(/^0x/, ''), 'hex'));
  const recipient = '0x' + ecdh.getPublicKey('hex', 'compressed');
  const aad = wrapAAD(c, part, role, recipient, wrap.ephemeralPublicKey);
  const decipher = createDecipheriv('aes-256-gcm', kek(ecdh.computeSecret(Buffer.from(wrap.ephemeralPublicKey.slice(2), 'hex')), aad),
    unb64(wrap.nonce, 12), { authTagLength: 16 });
  decipher.setAAD(aad); decipher.setAuthTag(unb64(wrap.tag, 16));
  const key = Buffer.concat([decipher.update(unb64(wrap.ciphertext, 32)), decipher.final()]);
  if (key.length !== 32) throw new Error('Invalid trace content key');
  return key;
}

export function sealPart(plaintext: Uint8Array, c: TraceContext, part: TracePart, recipients: Partial<Record<WrapRole, string>>) {
  const contentKey = randomBytes(32), nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', contentKey, nonce, { authTagLength: 16 });
  cipher.setAAD(partAAD(c, part));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wraps: PartMeta['wraps'] = {};
  for (const role of ['owner', 'release'] as WrapRole[]) if (recipients[role]) wraps[role] = wrapKey(contentKey, c, part, role, recipients[role]!);
  contentKey.fill(0);
  const meta: PartMeta = { nonce: b64(nonce), tag: b64(cipher.getAuthTag()), sha256: sha256Hex(ciphertext), bytes: ciphertext.length, wraps };
  return { meta, ciphertext };
}

export function openPart(meta: PartMeta, ciphertext: Uint8Array, c: TraceContext, part: TracePart, role: WrapRole, privateKey: string): Buffer {
  if (sha256Hex(ciphertext) !== meta.sha256 || ciphertext.length !== meta.bytes) throw new Error('Trace ciphertext does not match its record');
  const key = unwrapKey(meta.wraps?.[role], c, part, role, privateKey);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, unb64(meta.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(partAAD(c, part)); decipher.setAuthTag(unb64(meta.tag, 16));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } finally { key.fill(0); }
}

/** Shape check for a part record received from a client. Does not decrypt anything. */
export function checkPartMeta(meta: any, required: WrapRole[], forbidden: WrapRole[] = []): PartMeta {
  if (!meta || typeof meta !== 'object') throw new Error('Missing trace part');
  unb64(meta.nonce, 12); unb64(meta.tag, 16);
  if (!/^[a-f0-9]{64}$/.test(meta.sha256 || '') || !Number.isInteger(meta.bytes) || meta.bytes < 1) throw new Error('Invalid trace part record');
  const wraps: PartMeta['wraps'] = {};
  for (const role of ['owner', 'release'] as WrapRole[]) {
    const w = meta.wraps?.[role];
    if (!w) { if (required.includes(role)) throw new Error(`The trace part must be wrapped for the ${role} key`); continue; }
    if (forbidden.includes(role)) throw new Error(`The ${role} key must not be able to open this trace part`);
    if (!/^0x(?:02|03)[0-9a-f]{64}$/.test(w.ephemeralPublicKey || '')) throw new Error('Invalid wrapped key');
    unb64(w.nonce, 12); unb64(w.tag, 16); unb64(w.ciphertext, 32);
    wraps[role] = { ephemeralPublicKey: w.ephemeralPublicKey, nonce: w.nonce, ciphertext: w.ciphertext, tag: w.tag };
  }
  return { nonce: meta.nonce, tag: meta.tag, sha256: meta.sha256, bytes: meta.bytes, wraps };
}
