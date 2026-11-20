import { describe, expect, it } from 'vitest';
import { TCWSessionManager, prepareSession, completeSessionSetup, createDelegation, makeSpaceId } from '@tinycloud/node-sdk-wasm';
import { serializeDelegation } from '@tinycloud/node-sdk';
import { testWallet } from './author-test-fixtures.js';
import type { User, JournalEntry } from './storage.js';
import { traceAccess, traceRequestStore, readerDid } from './trace-access.js';
import { openPart, sealPart } from './trace-envelope.js';
// @ts-expect-error The owner device uses browser WebCrypto in the production module.
import { rewrapTraceKey } from '../../browser/src/trace-keys.mjs';

const owner = testWallet('owner'), reader = testWallet('reader'), host = 'https://storage.example';
const ownerDid = readerDid(owner.signingKey.compressedPublicKey), recipient = readerDid(reader.signingKey.compressedPublicKey);
const space = makeSpaceId(owner.address, 1, 'router'), path = 'router/traces/a-note/';
const ownerUser = {handle:'author', tinycloud:{space, ownerDid}} as User;
const author = {keyHash:'author-key-hash', pseudonym:'author pen name', user:ownerUser};
const agent = {keyHash:'reader-key-hash', pseudonym:'reader pen name', user:null};
const clock = Math.floor(Date.now()/1000)*1000;
function fixture() {
  let time = clock, allowed = true;
  const entry = {id:'a-note',handle:'author',pseudonym:author.pseudonym} as JournalEntry;
  const call = traceAccess({store:traceRequestStore(), host, now:()=>time, getUser: async () => null,
    visible: async (id, who) => id === entry.id && (who.keyHash === author.keyHash || allowed && who.keyHash === agent.keyHash) ? entry : null});
  const ask = () => call(agent,{action:'request',entry_id:entry.id,reader_public_key:reader.signingKey.compressedPublicKey}) as Promise<any>;
  return {call,ask,restrict:()=>{allowed=false;},advance:()=>{time+=3600001;}};
}

/** Real, locally issued TinyCloud session and scoped child. The storage node enforces the parent on read. */
async function grant(folder = path) {
  const manager = new TCWSessionManager();
  try {
    const key = manager.createSessionKey('owner');
    const jwk = JSON.parse(manager.jwk(key)!);
    const config = { address:owner.address, chainId:1, domain:'router.example', spaceId:space, jwk,
      issuedAt:new Date(clock).toISOString(), expirationTime:new Date(clock+86400000).toISOString(),
      abilities:{ kv:{'router/':['tinycloud.kv/get']} } };
    const prepared = prepareSession(config);
    const parent = completeSessionSetup({...prepared,signature:await owner.signMessage(prepared.siwe)});
    const session = {...parent, jwk, spaceId:space, verificationMethod:parent.verificationMethod.split('#')[0]};
    const exp = clock/1000+3600, result = createDelegation(session,recipient,space,{kv:{[folder]:['tinycloud.kv/get']}},exp,undefined);
    return serializeDelegation({cid:result.cid,delegationHeader:{Authorization:result.delegation},spaceId:space,path:folder,
      actions:['tinycloud.kv/get'],resources:result.resources,expiry:new Date(exp*1000),delegateDID:recipient,ownerAddress:owner.address,chainId:1,host} as any);
  } finally { manager.free(); }
}
describe('private trace access',()=>{
  it('lets a visible agent ask once, then only that reader can obtain and use the owner grant',async()=>{
    const f=fixture();
    const [a,b]=await Promise.all([f.ask(),f.ask()]);
    expect(a.request_id).toBe(b.request_id);
    expect(a.trace_url).toContain(a.entry_id);
    const inbox:any=await f.call(author,{action:'inbox'});
    expect(inbox.requests).toHaveLength(1);
    const status={action:'status',request_id:a.request_id};
    expect(await f.call(agent,status)).not.toHaveProperty('grant');
    await expect(f.call({...agent,keyHash:'another-reader'},status)).rejects.toThrow('not found');
    const context={ownerDid,entryId:a.entry_id};
    const sealed=sealPart(Buffer.from('synthetic trace'),context,'full',{owner:owner.signingKey.compressedPublicKey});
    const wrap=await rewrapTraceKey(sealed.meta,ownerDid,a.entry_id,owner.privateKey,reader.signingKey.compressedPublicKey);
    const approve={action:'approve',request_id:a.request_id,revision:a.revision,wrap,delegation:await grant()};
    await expect(f.call(agent,approve)).rejects.toThrow('not found');
    expect(await f.call(author,approve)).toMatchObject({state:'approved'});
    expect(await f.call(author,status)).not.toHaveProperty('grant');
    const approved:any=await f.call(agent,status);
    expect(approved.grant.delegation).toBe(approve.delegation);
    const meta={...sealed.meta,wraps:{reader:approved.grant.wrap}};
    expect(openPart(meta,sealed.ciphertext,context,'full','reader',reader.privateKey).toString()).toBe('synthetic trace');
    expect(()=>openPart(meta,sealed.ciphertext,context,'full','reader',testWallet('other').privateKey)).toThrow();
    f.advance();
    expect(await f.call(agent,status)).toMatchObject({state:'expired'});
    expect(await f.call(agent,status)).not.toHaveProperty('grant');
    expect((await f.ask()).revision).not.toBe(a.revision);
    await expect(f.call(author,approve)).rejects.toThrow();
  });
  it('requires the current audience, and will not relay a grant whose signed scope differs from its description',async()=>{
    const f=fixture(), r=await f.ask();
    const wire=JSON.parse(await grant('router/'));
    wire.path=path; wire.resources[0].path=path;
    const input={action:'approve',request_id:r.request_id,revision:r.revision,delegation:JSON.stringify(wire)};
    await expect(f.call(author,input)).rejects.toThrow('signed TinyCloud permission');
    f.restrict();
    await expect(f.ask()).rejects.toThrow('not found');
    await expect(f.call(author,input)).rejects.toThrow('no longer');
    expect(await f.call(author,{...input,action:'decline'})).toMatchObject({state:'declined'});
    await expect(f.call(agent,{...input,action:'status'})).rejects.toThrow('not found');
  });
});
