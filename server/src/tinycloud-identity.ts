import { createHmac } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { computeAddress } from 'ethers';
import { openRecoveredKeys, type RouterKeys } from './recovered-identity.js';

export class TinyCloudKeyMismatch extends Error {}

export const IDENTITY_PATH = 'teleport-router/tinycloud/v1';
export const RECORD_PATH = 'teleport-router/record-encryption/v1';

export async function currentRouterKeys(endpoint?: string): Promise<RouterKeys> {
  const { DstackClient } = await import('@phala/dstack-sdk');
  const client = new DstackClient(endpoint);
  const identity = await client.getKey(IDENTITY_PATH, 'secp256k1');
  const encryption = await client.getKey(RECORD_PATH);
  if (identity.key.length !== 32 || encryption.key.length !== 32) throw Error('Unexpected dstack Router key size');
  return { identity: Buffer.from(identity.key), encryption: Buffer.from(encryption.key) };
}

const routerDid = (key: Buffer) => 'did:pkh:eip155:1:' + computeAddress('0x' + key.toString('hex'));

/** Recovery must match both existing pins. Only ordinary first-time initialization may create them. */
export async function checkRouterPins(keys: RouterKeys, env: NodeJS.ProcessEnv, initialize: boolean) {
  const did = routerDid(keys.identity);
  if (env.TINYCLOUD_EXPECTED_DID && env.TINYCLOUD_EXPECTED_DID.toLowerCase() !== did.toLowerCase())
    throw new TinyCloudKeyMismatch('TinyCloud Router identity changed; refusing to use existing grants');
  const pin = env.TINYCLOUD_IDENTITY_PIN || '/data/tinycloud-router-did';
  const encryptionPin = env.TINYCLOUD_ENCRYPTION_PIN || pin + '.encryption-v1';
  const checkValue = createHmac('sha256', keys.encryption).update('teleport-router/encryption-pin/v1').digest('hex');
  const pins = [
    { path: pin, value: did, matches: (value: string) => value.toLowerCase() === did.toLowerCase(), error: 'TinyCloud identity does not match the pinned Router identity' },
    { path: encryptionPin, value: checkValue, matches: (value: string) => value === checkValue, error: 'Record encryption key does not match the pinned key' },
  ];
  const verify = async (entry: typeof pins[number]) => {
    if (!entry.matches((await readFile(entry.path, 'utf8')).trim())) throw new TinyCloudKeyMismatch(entry.error);
  };
  const missing: typeof pins = [];
  for (const entry of pins) {
    try { await verify(entry); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      if (!initialize) throw new TinyCloudKeyMismatch('Original Router key pin is missing');
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

/** A failed recovery leaves the notebook in the existing read-only mode. */
export async function tinyCloudIdentity(env = process.env) {
  let keys: RouterKeys;
  let source: 'dstack' | 'test-key';
  if (env.TINYCLOUD_KEY_SOURCE === 'dstack') {
    source = 'dstack';
    keys = await currentRouterKeys(env.DSTACK_ENDPOINT || undefined);
    const file = env.TINYCLOUD_RECOVERED_KEYS;
    try { await checkRouterPins(keys, env, !file); }
    catch (error) {
      if (!(error instanceof TinyCloudKeyMismatch) || !file) throw error;
      try {
        const recovered = openRecoveredKeys(await readFile(file), keys);
        await checkRouterPins(recovered, env, false);
        keys = recovered;
      } catch { throw error; }
    }
  } else {
    if (env.NODE_ENV === 'production') throw new Error('Production TinyCloud requires TINYCLOUD_KEY_SOURCE=dstack');
    source = 'test-key';
    const key = env.TINYCLOUD_ROUTER_KEY || '';
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Invalid TinyCloud Router identity key');
    keys = { identity: Buffer.from(key.slice(2), 'hex'),
      encryption: createHmac('sha256', key).update('teleport-router/test-record-encryption/v1').digest() };
    if (env.TINYCLOUD_EXPECTED_DID && env.TINYCLOUD_EXPECTED_DID.toLowerCase() !== routerDid(keys.identity).toLowerCase())
      throw new TinyCloudKeyMismatch('TinyCloud Router identity changed; refusing to use existing grants');
  }
  const recordKey = createHmac('sha256', keys.identity).update('teleport-router/record-integrity/v1').digest();
  return { privateKey: '0x' + keys.identity.toString('hex'), did: routerDid(keys.identity), source, recordKey, encryptionKey: keys.encryption };
}
