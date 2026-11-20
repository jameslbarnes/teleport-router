import { createHash } from 'node:crypto';
import { getAddress, SigningKey } from 'ethers';
import { canonical } from './author-records.js';

/** The browser seals the local recovery key to ONE named TinyCloud key before sending this record. */
export interface NetworkRecovery {
  publicKey: string;
  envelope: { v: 2; networkId: string; keyPath: string; alg: string; keyVersion: number;
    encryptedSymmetricKey: string; encryptedSymmetricKeyHash: string; ciphertext: string; aad?: string };
}
export function recoveryPath(origin: string) {
  return 'apps/' + new URL(origin).hostname.split('.').reverse().join('.') + '/recovery';
}
export function networkRecovery(value: any, ownerDid: string, origin: string): NetworkRecovery {
  const e = value?.envelope;
  if (!/^0x(?:02|03)[0-9a-fA-F]{64}$/.test(value?.publicKey || '') || !e || e.v !== 2 ||
      typeof e.networkId !== 'string' || e.networkId.toLowerCase() !== ('urn:tinycloud:encryption:' + ownerDid + ':default').toLowerCase() ||
      e.keyPath !== recoveryPath(origin) || !Number.isSafeInteger(e.keyVersion) || e.keyVersion < 0 || e.alg !== 'x25519-aes256gcm/v1' ||
      ![e.encryptedSymmetricKey, e.ciphertext].every(s => typeof s === 'string' && s.length > 0 && s.length < 4096) ||
      e.encryptedSymmetricKeyHash !== createHash('sha256').update(JSON.stringify(e.encryptedSymmetricKey)).digest('hex') || JSON.stringify(value).length > 12288)
    throw new Error('Expected a recovery envelope sealed to this owner and Router’s named recovery key.');
  const { v, networkId, keyPath, alg, keyVersion, encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext, aad } = e;
  if (aad !== undefined && (typeof aad !== 'string' || aad.length > 1024)) throw new Error('Invalid recovery context.');
  return { publicKey: SigningKey.computePublicKey(value.publicKey, true), envelope: {
    v, networkId, keyPath, alg, keyVersion, encryptedSymmetricKey, encryptedSymmetricKeyHash, ciphertext, ...(aad === undefined ? {} : {aad}) } };
}
export function linkMessage(origin: string, address: string, handle: string, grantHash: string,
  recovery: NetworkRecovery | undefined, nonce: string, issued: number, expires: number, migration?: { from: string; to: string }) {
  const site = new URL(origin);
  const recoveryHash = createHash('sha256').update(canonical(recovery || 'self-held')).digest('hex');
  return [
    site.host + ' wants you to sign in with your Ethereum account:', getAddress(address), '',
    migration ? 'Move the Router storage of @' + handle + ' from ' + migration.from + ' to ' + migration.to + '.' : 'Link @' + handle + ' on Router to this storage account and confirm recovery for the selected storage grant.', '',
    'URI: ' + site.origin, 'Version: 1', 'Chain ID: 1', 'Nonce: ' + nonce, 'Issued At: ' + new Date(issued).toISOString(),
    'Expiration Time: ' + new Date(expires).toISOString(), 'Resources:', '- urn:router:grant:' + grantHash,
    '- urn:router:recovery:' + recoveryHash, ...(migration ? ['- urn:router:migrate-from:' + migration.from, '- urn:router:migrate-to:' + migration.to] : []),
  ].join('\n');
}
