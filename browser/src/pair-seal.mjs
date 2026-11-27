// Browser-side sealing for the trace-agent pairing handoff.
// Uses secp256k1 ECDH + HKDF-SHA-256 + AES-256-GCM (matching server/scripts/trace-owner-auth.mjs),
// so Router only ever relays ciphertext that only the local agent key can open.
import { SigningKey, Wallet, getBytes } from 'ethers';
import { b64 } from './recovery.mjs';

const utf8 = text => new TextEncoder().encode(text);

export function pairAAD(pairId, ownerDid, agentPublicKey) {
  return utf8(JSON.stringify([
    'teleport-router/trace-agent-pair/v1',
    String(pairId),
    String(ownerDid).toLowerCase(),
    SigningKey.computePublicKey(agentPublicKey, true),
  ]));
}

/** Encrypt a JSON payload to the local agent's compressed secp256k1 public key. */
export async function sealAgentGrant(payload, { pairId, ownerDid, agentPublicKey }) {
  const recipient = SigningKey.computePublicKey(agentPublicKey, true);
  const ephemeral = Wallet.createRandom().signingKey;
  const aad = pairAAD(pairId, ownerDid, recipient);
  const secret = getBytes(ephemeral.computeSharedSecret(recipient)).slice(1, 33);
  try {
    const material = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    const aesKey = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt'],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce, additionalData: aad, tagLength: 128 },
      aesKey,
      utf8(JSON.stringify(payload)),
    ));
    const ciphertext = encrypted.slice(0, encrypted.length - 16);
    const tag = encrypted.slice(encrypted.length - 16);
    return {
      ephemeralPublicKey: ephemeral.compressedPublicKey,
      nonce: b64(nonce),
      tag: b64(tag),
      ciphertext: b64(ciphertext),
    };
  } finally {
    secret.fill(0);
  }
}
