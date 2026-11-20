import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** The enclave returned valid keys that disagree with a previously trusted value. */
export class TinyCloudKeyMismatch extends Error {}

/** Never fall back to a random key in production: that would orphan every grant. */
export async function tinyCloudIdentity(env = process.env) {
  let privateKey: string;
  let source: 'dstack' | 'test-key';
  let encryptionKey: Buffer;
  if (env.TINYCLOUD_KEY_SOURCE === 'dstack') {
    const { DstackClient } = await import('@phala/dstack-sdk');
    // In production Router reaches dstack only through the subhost service's filtered
    // socket, which answers just the two key requests below (subhost/README.md).
    const client = new DstackClient(env.DSTACK_ENDPOINT || undefined);
    const result = await client.getKey('teleport-router/tinycloud/v1', 'secp256k1');
    if (result.key.length !== 32) throw new Error('Unexpected dstack TinyCloud key size');
    privateKey = '0x' + Buffer.from(result.key).toString('hex');
    const encryption = await client.getKey('teleport-router/record-encryption/v1');
    if (encryption.key.length !== 32) throw new Error('Unexpected dstack record encryption key size');
    encryptionKey = Buffer.from(encryption.key);
    source = 'dstack';
  } else {
    if (env.NODE_ENV === 'production') throw new Error('Production TinyCloud requires TINYCLOUD_KEY_SOURCE=dstack');
    privateKey = env.TINYCLOUD_ROUTER_KEY || '';
    encryptionKey = createHmac('sha256', privateKey).update('teleport-router/test-record-encryption/v1').digest();
    source = 'test-key';
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Invalid TinyCloud Router identity key');
  const { computeAddress } = await import('ethers');
  const did = `did:pkh:eip155:1:${computeAddress(privateKey)}`;
  const expected = env.TINYCLOUD_EXPECTED_DID;
  if (expected && expected.toLowerCase() !== did.toLowerCase()) throw new TinyCloudKeyMismatch('TinyCloud Router identity changed; refusing to use existing grants');
  if (source === 'dstack') {
    const pin = env.TINYCLOUD_IDENTITY_PIN || '/data/tinycloud-router-did';
    const encryptionPin = env.TINYCLOUD_ENCRYPTION_PIN || pin + '.encryption-v1';
    const checkValue = createHmac('sha256', encryptionKey).update('teleport-router/encryption-pin/v1').digest('hex');
    const pins = [
      { path: pin, value: did, matches: (value: string) => value.toLowerCase() === did.toLowerCase(), error: 'TinyCloud identity does not match the pinned Router identity' },
      { path: encryptionPin, value: checkValue, matches: (value: string) => value === checkValue, error: 'Record encryption key does not match the pinned key' },
    ];
    const verify = async (entry: typeof pins[number]) => {
      if (!entry.matches((await readFile(entry.path, 'utf8')).trim())) throw new TinyCloudKeyMismatch(entry.error);
    };
    // Verify every surviving pin before creating a missing one, including after an interrupted first boot.
    const missing: typeof pins = [];
    for (const entry of pins) {
      try { await verify(entry); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        missing.push(entry);
      }
    }
    for (const entry of missing) {
      await mkdir(dirname(entry.path), { recursive: true });
      try { await writeFile(entry.path, entry.value + '\n', { flag: 'wx', mode: 0o600 }); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        await verify(entry);
      }
    }
  }
  const recordKey = createHmac('sha256',Buffer.from(privateKey.slice(2),'hex')).update('teleport-router/record-integrity/v1').digest();
  return { privateKey, did, source, recordKey, encryptionKey };
}
