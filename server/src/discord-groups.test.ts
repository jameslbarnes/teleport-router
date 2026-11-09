import {describe, it, expect} from 'vitest';
import {MemoryStorage, type JournalEntry} from './storage.js';
import {authorStorage, recordCodec} from './author-store.js';
import {discordGroups} from './discord-groups.js';
import {derivePseudonym, hashSecretKey} from './identity.js';
import type {GroupStore} from './group-store.js';
import {testWallet,versionedMemoryStore} from './author-test-fixtures.js';

async function fixture(scope: 'channel' | 'guild' = 'channel') {
  const base = new MemoryStorage();
  const keys = {alice: 'a'.repeat(43), bob: 'b'.repeat(43), outsider: 'c'.repeat(43), router_bot: 'd'.repeat(43)};
  let clock = 1_000_000;
  const data = new Map<string, Map<string,string>>();
  const revoked = new Set<string>();
  const layer = authorStorage(base, async b => {
    const check = () => {if (revoked.has(b.space)) throw new Error('revoked');};
    const records = data.get(b.space)!;
    return versionedMemoryStore(records,check);
  }, recordCodec(Buffer.alloc(32,4),Buffer.alloc(32,5)), {now: () => clock, leaseMs: 60000});
  for (const [handle,key] of Object.entries(keys)) {
    const user = await base.createUser({handle, secretKeyHash: hashSecretKey(key), legacyPseudonym: derivePseudonym(key)});
    if (handle !== 'router_bot') {
      data.set(handle, new Map());
      await layer.link(user, {ownerDid:`did:pkh:eip155:1:${testWallet(handle).address}`,ownerPublicKey:testWallet(handle).signingKey.publicKey,
        space:handle, prefix:'router/', delegation:'synthetic', pseudonym:derivePseudonym(key), linkedAt:clock});
    }
  }
  await base.createChannel({id:'test-group', name:'Private test', visibility:'private', joinRule:'invite', createdBy:'alice', createdAt:clock,
    skills:[], subscribers:['alice','bob','router_bot'].map(handle=>({handle,role:handle==='alice'?'admin':'member',joinedAt:clock}))});
  const service = discordGroups(layer.storage, layer.storage, layer.status, {baseUrl:'https://router.example',now:()=>clock});
  const context = {guildId:'100000000000000001', channelId:'100000000000000002', discordUserId:'100000000000000003'};
  const call = (who: keyof typeof keys, path: string, body: Record<string,unknown>) => service.serve('/api/discord/'+path, `Bearer ${keys[who]}`, body) as Promise<any>;
  await call('alice','bind',{groupId:'test-group',botHandle:'router_bot',
    ...(scope === 'guild' ? {scope, guildId:context.guildId} : context)});
  async function link(who: 'alice'|'bob' = 'alice', discordUserId=context.discordUserId, channelId=context.channelId) {
    const challenge = await call(who,'link/start',{groupId:'test-group',discordUserId});
    return call('router_bot','link/complete',{...context,discordUserId,channelId,code:challenge.code});
  }
  const operate = (grant: string, body: Record<string,unknown> = {}) => call('router_bot','operate',{grant,...context,...body});
  const save = (grant: string, content='Selected synthetic note', interactionId='100000000000000010') => operate(grant,{action:'save',content,interactionId});
  return {base,layer,data,revoked,keys,context,call,link,operate,save,advance:(ms=60001)=>{clock+=ms;}};
}

describe('Scoped private Discord group access',()=>{
  it('lets linked members use the same private group from different channels of one server',async()=>{
    const f=await fixture('guild');
    const otherChannel='100000000000000020';
    const {grant}=await f.link('alice',f.context.discordUserId,otherChannel);
    const first=await f.save(grant,'Question from general');
    const second=await f.operate(grant,{channelId:otherChannel,action:'save',content:'Reading group note',interactionId:'100000000000000021'});
    expect(first.groupId).toBe('test-group');
    expect(second.groupId).toBe('test-group');
    expect((await f.operate(grant,{channelId:otherChannel,action:'read',entryId:first.entry.id})).entry.content).toBe('Question from general');
    expect((await f.operate(grant,{action:'search'})).entries).toHaveLength(2);
    const retry=await f.operate(grant,{channelId:otherChannel,action:'save',content:'Reading group note',interactionId:'100000000000000021'});
    expect(retry.duplicate).toBe(true);
    expect(retry.entry.id).toBe(second.entry.id);
    for(const entry of [first.entry,second.entry]) {
      expect((await f.layer.storage.getEntry(entry.id))?.to).toEqual(['#test-group']);
      expect(await f.base.getEntry(entry.id)).toBeNull();
    }
  });
  it('keeps server-wide grants bound to the Discord user, server, bot and current group membership',async()=>{
    const f=await fixture('guild'), {grant}=await f.link();
    for(const body of [{guildId:'100000000000000099'}, {discordUserId:'100000000000000099'}, {channelId:null}, {channelId:'*'}])
      await expect(f.operate(grant,{action:'search',...body})).rejects.toMatchObject({status:403});
    await expect(f.call('bob','operate',{...f.context,grant,action:'search'})).rejects.toMatchObject({status:403});
    await expect(f.call('outsider','link/start',{groupId:'test-group',discordUserId:'100000000000000099'})).rejects.toMatchObject({status:403});
    await f.base.removeSubscriber('test-group','alice');
    await expect(f.operate(grant,{action:'search',channelId:'100000000000000020'})).rejects.toMatchObject({status:403});
    await expect(f.save(grant)).rejects.toMatchObject({status:403});
  });
  it('never treats an omitted, malformed or mixed binding as permission for the whole server',async()=>{
    const f=await fixture();
    for(const extra of [{}, {scope:'all'}, {scope:null,channelId:null}, {scope:'guild',channelId:f.context.channelId}, {scope:'channel',channelId:'*'}, {scope:[]}])
      await expect(f.call('alice','bind',{groupId:'test-group',guildId:f.context.guildId,botHandle:'router_bot',...extra})).rejects.toMatchObject({status:400});
    const {grant}=await f.link();
    await expect(f.operate(grant,{action:'search',channelId:'100000000000000020'})).rejects.toMatchObject({status:403});
  });
  it('preserves old single-channel grants when the same binding is saved again',async()=>{
    const f=await fixture();
    const binding=(await f.base.getChannel('test-group'))!.discord!;
    const {scope:_,...legacy}=binding;
    await f.base.updateChannel('test-group',{discord:legacy});
    const {grant}=await f.link();
    const result=await f.call('alice','bind',{groupId:'test-group',botHandle:'router_bot',...f.context});
    expect(result.version).toBe(legacy.version);
    expect((await f.operate(grant,{action:'status'})).groupId).toBe('test-group');
    await expect(f.operate(grant,{action:'status',channelId:'100000000000000020'})).rejects.toMatchObject({status:403});
  });
  it('requires new links after widening, narrowing or moving a server binding',async()=>{
    const f=await fixture(), old=await f.link();
    const binding={groupId:'test-group',botHandle:'router_bot',guildId:f.context.guildId};
    await f.call('alice','bind',{...binding,scope:'guild'});
    await expect(f.operate(old.grant,{action:'search'})).rejects.toMatchObject({status:403});
    const wide=await f.link();
    await f.call('alice','bind',{...binding,scope:'channel',channelId:f.context.channelId});
    await expect(f.operate(wide.grant,{action:'search'})).rejects.toMatchObject({status:403});
    await f.call('alice','bind',{...binding,scope:'guild'});
    const staging=await f.link();
    await f.call('alice','bind',{...binding,scope:'guild',guildId:'100000000000000030'});
    await expect(f.operate(staging.grant,{action:'search'})).rejects.toMatchObject({status:403});
  });
  it('requires a private group admin to bind the channel',async()=>{
    const f=await fixture();
    await expect(f.call('bob','bind',{groupId:'test-group',...f.context,botHandle:'router_bot'})).rejects.toMatchObject({status:403});
    await f.base.updateChannel('test-group',{joinRule:'open'});
    await expect(f.link()).rejects.toMatchObject({status:403});
  });
  it('binds one-time linking to the authenticated bot, Discord user and channel',async()=>{
    const f=await fixture();
    const challenge=await f.call('alice','link/start',{groupId:'test-group',discordUserId:f.context.discordUserId});
    const body={...f.context,code:challenge.code};
    await expect(f.call('bob','link/complete',body)).rejects.toMatchObject({status:403});
    await expect(f.call('router_bot','link/complete',{...body,discordUserId:'100000000000000099'})).rejects.toMatchObject({status:403});
    await expect(f.call('router_bot','link/complete',{...body,channelId:'100000000000000099'})).rejects.toMatchObject({status:403});
    const results=await Promise.allSettled([f.call('router_bot','link/complete',body),f.call('router_bot','link/complete',body)]);
    expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
    const owner=await f.base.getUser('alice');
    expect(owner?.linkedAccounts).toContainEqual(expect.objectContaining({platform:'discord',platformUserId:f.context.discordUserId,verified:true}));
    expect(JSON.stringify(owner)).not.toContain('rdg1.');
  });
  it('expires linking codes and prevents a Discord account from impersonating another Router author',async()=>{
    const f=await fixture();
    const challenge=await f.call('alice','link/start',{groupId:'test-group',discordUserId:f.context.discordUserId});
    f.advance(600001);
    await expect(f.call('router_bot','link/complete',{...f.context,code:challenge.code})).rejects.toMatchObject({status:403});
    await f.link();
    await expect(f.link('bob')).rejects.toMatchObject({status:409});
  });
  it('writes the exact selected note to its author store and returns an authenticated permalink',async()=>{
    const f=await fixture(), linked=await f.link();
    const saved=await f.save(linked.grant);
    expect(saved.entry).toMatchObject({handle:'alice',content:'Selected synthetic note'});
    expect(saved.entry.url).toBe(`https://router.example/e/${saved.entry.id}`);
    expect(await f.base.getEntry(saved.entry.id)).toBeNull();
    expect(f.data.get('alice')!.has(`posts/${saved.entry.id}`)).toBe(true);
    expect(f.data.get('bob')!.size).toBe(0);
    expect((await f.layer.storage.getEntry(saved.entry.id))?.to).toEqual(['#test-group']);
    const search=await f.operate(linked.grant,{action:'search',query:'synthetic'});
    expect(search.entries.map((e:JournalEntry)=>e.id)).toEqual([saved.entry.id]);
  });
  it('rejects spoofed authors/destinations and replay with changed content; identical retries are idempotent',async()=>{
    const f=await fixture(), {grant}=await f.link();
    await expect(f.operate(grant,{action:'save',content:'fake',interactionId:'100000000000000010',handle:'bob'})).rejects.toMatchObject({status:400});
    await expect(f.operate(grant,{action:'save',content:'fake',interactionId:'100000000000000010',to:[]})).rejects.toMatchObject({status:400});
    const [first,second]=await Promise.all([f.save(grant),f.save(grant)]);
    expect(first.entry.id).toBe(second.entry.id);
    expect(second.duplicate).toBe(true);
    expect(f.data.get('alice')!.size).toBe(1);
    await expect(f.save(grant,'Changed')).rejects.toMatchObject({status:409});
  });
  it('rejects a wrong Discord sender, server, channel, bot or forged grant',async()=>{
    const f=await fixture(), {grant}=await f.link();
    for(const field of ['discordUserId','guildId','channelId'])
      await expect(f.operate(grant,{action:'search',[field]:'100000000000000099'})).rejects.toMatchObject({status:403});
    await expect(f.call('bob','operate',{...f.context,grant,action:'search'})).rejects.toMatchObject({status:403});
    await expect(f.operate(grant+'x',{action:'search'})).rejects.toMatchObject({status:403});
    await expect(f.operate('',{action:'search'})).rejects.toMatchObject({status:403});
  });
  it('does not return public entries or records from other private groups',async()=>{
    const f=await fixture(), {grant}=await f.link();
    const other=await f.layer.storage.addEntry({handle:'alice',pseudonym:derivePseudonym(f.keys.alice),content:'Other group secret',client:'code',timestamp:1,to:['#other-group']} as JournalEntry);
    await expect(f.operate(grant,{action:'read',entryId:other.id})).rejects.toMatchObject({status:404});
    expect((await f.operate(grant,{action:'search'})).entries).toEqual([]);
  });
  it.each(['alice','router_bot'])('checks current group membership for %s',async removed=>{
    const f=await fixture(), {grant}=await f.link();
    await f.base.removeSubscriber('test-group',removed);
    await expect(f.operate(grant,{action:'search'})).rejects.toMatchObject({status:403});
    await expect(f.save(grant)).rejects.toMatchObject({status:403});
  });
  it('checks again when membership changes during a storage read',async()=>{
    const f=await fixture(), {grant}=await f.link();
    const delayed = new Proxy(f.layer.storage, {get(target,prop){
      if(prop==='getChannelEntries')return async()=>{await f.base.removeSubscriber('test-group','alice');return [];};
      const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;
    }});
    const service=discordGroups(f.layer.storage,delayed,f.layer.status,{baseUrl:'https://router.example',now:()=>1_000_000});
    await expect(service.serve('/api/discord/operate',`Bearer ${f.keys.router_bot}`,
      {...f.context,grant,action:'search'})).rejects.toMatchObject({status:403});
  });
  it('invalidates permissions on unlink, expiry, or a changed channel binding',async()=>{
    const f=await fixture();
    let {grant}=await f.link();
    await f.operate(grant,{action:'unlink'});
    await expect(f.operate(grant,{action:'search'})).rejects.toMatchObject({status:403});
    ({grant}=await f.link());
    f.advance(31*86400000);
    await expect(f.operate(grant,{action:'search'})).rejects.toMatchObject({status:403});
    ({grant}=await f.link());
    await f.call('alice','bind',{groupId:'test-group',...f.context,botHandle:'router_bot',channelId:'100000000000000099'});
    await expect(f.operate(grant,{action:'search'})).rejects.toMatchObject({status:403});
  });
  it('revokes one author independently, blocks new saves, and never falls back to an old database copy',async()=>{
    const f=await fixture(), alice=await f.link(), bob=await f.link('bob','100000000000000004');
    const first=await f.save(alice.grant,'Alice stays');
    const second=await f.operate(bob.grant,{discordUserId:'100000000000000004',action:'save',content:'Bob withdraws',interactionId:'100000000000000011'});
    expect((await f.operate(alice.grant,{action:'search'})).entries).toHaveLength(2);
    f.revoked.add('bob'); f.advance();
    expect((await f.operate(alice.grant,{action:'search'})).entries.map((e:JournalEntry)=>e.id)).toEqual([first.entry.id]);
    await expect(f.operate(alice.grant,{action:'read',entryId:second.entry.id})).rejects.toMatchObject({status:404});
    await expect(f.operate(bob.grant,{discordUserId:'100000000000000004',action:'save',content:'After revoke',interactionId:'100000000000000012'})).rejects.toMatchObject({status:503});
    expect(f.data.get('bob')!.has(`posts/${second.entry.id}`)).toBe(true);
  });
});
