import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Never fall back to a random key in production: that would orphan every grant. */
export async function tinyCloudIdentity(env = process.env) {
  let privateKey: string;
  let source: 'dstack' | 'test-key';
  let encryptionKey: Buffer;
  if (env.TINYCLOUD_KEY_SOURCE === 'dstack') {
    const { DstackClient } = await import('@phala/dstack-sdk');
    const client = new DstackClient();
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
  if (expected && expected.toLowerCase() !== did.toLowerCase()) throw new Error('TinyCloud Router identity changed; refusing to use existing grants');
  if (source === 'dstack') {
    const pin = env.TINYCLOUD_IDENTITY_PIN || '/data/tinycloud-router-did';
    await mkdir(dirname(pin),{recursive:true});
    try {
      const saved = (await readFile(pin,'utf8')).trim();
      if (saved.toLowerCase() !== did.toLowerCase()) throw new Error('TinyCloud identity does not match the pinned Router identity');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await writeFile(pin,did+'\n',{flag:'wx',mode:0o600});
    }
    const encryptionPin = env.TINYCLOUD_ENCRYPTION_PIN || pin + '.encryption-v1';
    const checkValue = createHmac('sha256', encryptionKey).update('teleport-router/encryption-pin/v1').digest('hex');
    try {
      if ((await readFile(encryptionPin, 'utf8')).trim() !== checkValue) throw new Error('Record encryption key does not match the pinned key');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await mkdir(dirname(encryptionPin), {recursive:true});
      await writeFile(encryptionPin, checkValue + '\n', {flag:'wx', mode:0o600});
    }
  }
  const recordKey = createHmac('sha256',Buffer.from(privateKey.slice(2),'hex')).update('teleport-router/record-integrity/v1').digest();
  return { privateKey, did, source, recordKey, encryptionKey };
}
