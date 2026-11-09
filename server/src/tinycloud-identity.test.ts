import {it,expect,vi} from 'vitest';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {tinyCloudIdentity} from './tinycloud-identity.js';
vi.mock('@phala/dstack-sdk',()=>({DstackClient:class {async getKey(path:string){return {key:Buffer.alloc(32,path.includes('record-encryption')?4:3)};}}}));

it('refuses a supplied test key in production',async()=>{
  await expect(tinyCloudIdentity({NODE_ENV:'production',TINYCLOUD_ROUTER_KEY:`0x${'01'.repeat(32)}`})).rejects.toThrow('requires');
});
it('pins the derived identity and refuses a changed identity instead of orphaning grants',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'router-identity-')); const pin=join(dir,'identity');
  const env={NODE_ENV:'production',TINYCLOUD_KEY_SOURCE:'dstack',TINYCLOUD_IDENTITY_PIN:pin};
  try {
    const first=await tinyCloudIdentity(env), second=await tinyCloudIdentity(env);
    expect(first.did).toEqual(second.did);expect(first.recordKey).toEqual(second.recordKey);
    expect(first.encryptionKey).toEqual(second.encryptionKey);expect(first.encryptionKey).not.toEqual(first.recordKey);
    await writeFile(pin+'.encryption-v1','changed-key\n');
    await expect(tinyCloudIdentity(env)).rejects.toThrow('pinned key');
    await unlink(pin+'.encryption-v1');
    await writeFile(pin,'did:pkh:eip155:1:0x0000000000000000000000000000000000000001\n');
    await expect(tinyCloudIdentity(env)).rejects.toThrow('pinned');
  } finally {await unlink(pin).catch(()=>{});await unlink(pin+'.encryption-v1').catch(()=>{});await rmdir(dir);}
});
