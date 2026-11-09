import { SigningKey, computeAddress, getBytes, hexlify } from 'ethers';

const utf8 = value => new TextEncoder().encode(value);
const text = value => new TextDecoder('utf-8', { fatal: true }).decode(value);
export const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
export function unb64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw Error('Invalid recovery file.');
  const bytes = Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0));
  if (b64(bytes) !== value || (length !== undefined && bytes.length !== length)) throw Error('Invalid recovery file.');
  return bytes;
}
const context = b => [b.ownerDid.toLowerCase(), b.space, b.prefix];
const info = (domain, b, ...rest) => utf8(JSON.stringify([domain, ...context(b), ...rest]));
async function hkdf(secret, information) {
  const key = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: information }, key, 256));
}
async function decrypt(key, envelope, aad) {
  const ciphertext = unb64(envelope.ciphertext), tag = unb64(envelope.tag, 16);
  const joined = new Uint8Array(ciphertext.length + tag.length); joined.set(ciphertext); joined.set(tag, ciphertext.length);
  const aes = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.nonce, 12), additionalData: aad, tagLength: 128 }, aes, joined));
}
/** Interoperates with the server's existing owner-recovery envelope; owner key stays here. */
export async function recoverAuthorKey(privateKey, raw, binding) {
  const e = JSON.parse(raw), signing = new SigningKey(privateKey), recipient = signing.compressedPublicKey;
  if (binding.ownerDid.toLowerCase() !== 'did:pkh:eip155:1:' + computeAddress(privateKey).toLowerCase()
      || e.version !== 1 || e.suite !== 'secp256k1-hkdf-sha256-aes256gcm'
      || JSON.stringify(context(e)) !== JSON.stringify(context(binding)) || e.recipient !== recipient
      || !/^0x(?:02|03)[a-f0-9]{64}$/.test(e.ephemeralPublicKey || '')) throw Error('Recovery belongs to a different storage account.');
  const aad = info('teleport-router/owner-recovery/v1', binding, recipient, e.ephemeralPublicKey);
  const secret = getBytes(signing.computeSharedSecret(e.ephemeralPublicKey)).slice(1, 33);
  const wrapping = await hkdf(secret, aad);
  try { return unb64(text(await decrypt(wrapping, e, aad)), 32); }
  finally { secret.fill(0); wrapping.fill(0); }
}
export async function confirmOwnerRecovery(privateKey, prepared) {
  const bytes = await recoverAuthorKey(privateKey, prepared.recovery, prepared.context);
  try {
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hexlify(new Uint8Array(await crypto.subtle.sign('HMAC', key,
      info('teleport-router/recovery-confirmation/v1', prepared.context, prepared.message, prepared.recovery)))).slice(2);
  } finally { bytes.fill(0); }
}
const backupAAD = utf8('teleport-router/account-backup/v1');
async function passwordKey(password, salt, usage) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw Error('Use a recovery password with at least 12 characters.');
  const key = await crypto.subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' }, key, { name: 'AES-GCM', length: 256 }, false, [usage]);
}
function validateBackup(data) {
  if (data?.format !== 'router-account' || data.version !== 1 || !/^[a-z0-9_]{3,15}$/.test(data.handle || '')
      || !/^[A-Za-z0-9_-]{32,64}$/.test(data.routerKey || '') || !/^0x[a-fA-F0-9]{64}$/.test(data.tinycloudKey || '')
      || typeof data.origin !== 'string') throw Error('This is not a Router account backup.');
  new SigningKey(data.tinycloudKey);
  return data;
}
export async function encryptBackup(data, password) {
  validateBackup(data);
  const salt = crypto.getRandomValues(new Uint8Array(16)), nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await passwordKey(password, salt, 'encrypt');
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: backupAAD }, key, utf8(JSON.stringify(data)));
  return { format: 'router-encrypted-backup', version: 1, kdf: 'pbkdf2-sha256', iterations: 600000, salt: b64(salt), nonce: b64(nonce), ciphertext: b64(ciphertext) };
}
export async function decryptBackup(envelope, password) {
  if (envelope?.format !== 'router-encrypted-backup' || envelope.version !== 1 || envelope.kdf !== 'pbkdf2-sha256'
      || envelope.iterations !== 600000 || String(envelope.ciphertext).length > 20000) throw Error('This is not a supported Router recovery file.');
  const key = await passwordKey(password, unb64(envelope.salt, 16), 'decrypt');
  try {
    return validateBackup(JSON.parse(text(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(envelope.nonce, 12), additionalData: backupAAD }, key, unb64(envelope.ciphertext)))));
  } catch { throw Error('Could not unlock this recovery file. Check the password and file.'); }
}
