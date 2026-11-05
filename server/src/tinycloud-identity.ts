import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Never fall back to a random key in production: that would orphan every grant. */
export async function tinyCloudIdentity(env = process.env) {
  let privateKey: string;
  let source: 'dstack' | 'test-key';
  if (env.TINYCLOUD_KEY_SOURCE === 'dstack') {
    const { DstackClient } = await import('@phala/dstack-sdk');
    const client = new DstackClient();
    const result = await client.getKey('teleport-router/tinycloud/v1', 'secp256k1');
    if (result.key.length !== 32) throw new Error('Unexpected dstack TinyCloud key size');
    privateKey = '0x' + Buffer.from(result.key).toString('hex');
    source = 'dstack';
  } else {
    if (env.NODE_ENV === 'production') throw new Error('Production TinyCloud requires TINYCLOUD_KEY_SOURCE=dstack');
    privateKey = env.TINYCLOUD_ROUTER_KEY || '';
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
  }
  const recordKey = createHmac('sha256',Buffer.from(privateKey.slice(2),'hex')).update('teleport-router/record-integrity/v1').digest();
  return { privateKey, did, source, recordKey };
}
