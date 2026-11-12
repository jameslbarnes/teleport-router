import {describe, it, expect} from 'vitest';
import {MemoryStorage, type JournalEntry} from './storage.js';
import {authorStorage, recordCodec} from './author-store.js';
import {discordGroups, groupPostingMode, rankNotes, GRANT_IDLE_MS, GRANT_MAX_MS} from './discord-groups.js';
import {derivePseudonym, hashSecretKey} from './identity.js';
import type {GroupStore} from './group-store.js';
import {testWallet,versionedMemoryStore} from './author-test-fixtures.js';

async function fixture(scope: 'channel' | 'guild' = 'channel') {
  const base = new MemoryStorage();
  const keys = {alice: 'a'.repeat(43), bob: 'b'.repeat(43), outsider: 'c'.repeat(43), router_bot: 'd'.repeat(43)};
  let clock = 1_000_000;
  const data = new Map<string, Map<string,string>>();
  const revoked = new Set<string>();
  const audienceState = {botId:'100000000000000090',viewerIds:['100000000000000003','100000000000000090'], open:false, unavailable:false,
    beforeRead:async()=>{}};
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
  const service = discordGroups(layer.storage, layer.storage, layer.status, {baseUrl:'https://router.example',now:()=>clock,
    audience:async()=>{await audienceState.beforeRead();if(audienceState.unavailable)throw Error('unavailable');return {botId:audienceState.botId,open:audienceState.open,viewerIds:[...audienceState.viewerIds]};}});
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
  return {base,layer,data,revoked,keys,context,call,link,operate,save,audienceState,advance:(ms=60001)=>{clock+=ms;}};
}

describe('Shared conversational group access',()=>{
  async function conversation() {
    const f=await fixture('guild'), {grant}=await f.link();
    const ask=(action:string,extra:Record<string,unknown>={})=>f.call('router_bot','conversation/operate',{...f.context,grant,action,...extra});
    const enable=()=>f.call('alice','conversation/configure',{groupId:'test-group',channelIds:[f.context.channelId]});
    return {...f,grant,ask,enable};
  }
  it('requires an opted-in channel, scoped linked author and fresh server audience',async()=>{
    const f=await conversation();await expect(f.ask('check')).rejects.toMatchObject({status:403});
    await expect(f.call('bob','conversation/configure',{groupId:'test-group',channelIds:[f.context.channelId]})).rejects.toMatchObject({status:403});
    await f.enable(); const access=await f.ask('check');expect(access.groupId).toBe('test-group');
    await expect(f.call('router_bot','conversation/operate',{...f.context,action:'check'})).rejects.toMatchObject({status:403});
    await expect(f.ask('check',{channelId:'100000000000000030'})).rejects.toMatchObject({status:403});
    await expect(f.ask('save',{audienceVersion:access.audienceVersion,content:'No writes'})).rejects.toMatchObject({status:400});
    f.audienceState.unavailable=true;await expect(f.ask('check')).rejects.toMatchObject({status:503});
  });
  it('blocks any unlinked arrival or other bot, then permits a currently linked group member',async()=>{
    const f=await conversation();await f.enable();
    const bobId='100000000000000008';f.audienceState.viewerIds.push(bobId);
    await expect(f.ask('check')).rejects.toMatchObject({status:403});
    await f.link('bob',bobId); expect((await f.ask('check')).groupId).toBe('test-group');
    f.audienceState.viewerIds.push('100000000000000099');await expect(f.ask('check')).rejects.toMatchObject({status:403});
    f.audienceState.viewerIds.pop();await f.base.removeSubscriber('test-group','bob');
    await expect(f.ask('check')).rejects.toMatchObject({status:403});
  });
  it('refuses a channel that anyone joining the server would see, even when everyone present is linked',async()=>{
    const f=await conversation();await f.enable();expect((await f.ask('check')).groupId).toBe('test-group');
    f.audienceState.open=true;
    await expect(f.ask('check')).rejects.toMatchObject({status:403,message:expect.stringContaining('visible to everyone')});
  });
  it('ignores people in the server who cannot see the channel, and refuses a requester who cannot',async()=>{
    const f=await conversation();await f.enable();
    // The reader reports viewers only: an unlinked newcomer held outside the channel is simply absent.
    expect((await f.ask('check')).groupId).toBe('test-group');
    f.audienceState.viewerIds=[f.audienceState.botId];
    await expect(f.ask('check')).rejects.toMatchObject({status:403,message:expect.stringContaining('cannot see this channel')});
  });
  it('rechecks source deletion, edits, audience changes and permission revocation before delivery',async()=>{
    const f=await conversation();await f.enable();const saved=await f.save(f.grant,'The violet telescope is ready');
    const {audienceVersion}=await f.ask('check');
    const result=await f.ask('search',{audienceVersion,query:'violet telescope'});
    expect(result.entries).toHaveLength(1);expect(result.entries[0].id).toBe(saved.entry.id);
    const sources=result.entries.map((e:any)=>({id:e.id,version:e.version}));
    expect(await f.ask('verify',{audienceVersion,sources})).toMatchObject({verified:true});
    const original=(await f.layer.storage.getEntry(saved.entry.id))!;
    await f.layer.storage.addEntry({...original,content:'The telescope date changed.'});
    await expect(f.ask('verify',{audienceVersion,sources})).rejects.toMatchObject({status:409});
    await f.layer.storage.addEntry(original);
    f.audienceState.viewerIds.push('100000000000000008');await f.link('bob','100000000000000008');
    await expect(f.ask('verify',{audienceVersion,sources})).rejects.toMatchObject({status:409});
    f.audienceState.viewerIds.pop();
    await f.layer.storage.deleteEntry(saved.entry.id);
    await expect(f.ask('verify',{audienceVersion,sources})).rejects.toMatchObject({status:404});
    await f.base.removeSubscriber('test-group','alice');await expect(f.ask('verify',{audienceVersion,sources:[]})).rejects.toMatchObject({status:403});
  });
  it('cannot read another group and disables conversations without breaking ephemeral commands',async()=>{
    const f=await conversation();await f.enable();const saved=await f.save(f.grant);
    const {audienceVersion}=await f.ask('check');
    await expect(f.ask('read',{audienceVersion,entryId:'other-private-group-note'})).rejects.toMatchObject({status:404});
    await f.call('alice','conversation/configure',{groupId:'test-group',channelIds:[]});
    await expect(f.ask('verify',{audienceVersion,sources:[]})).rejects.toMatchObject({status:403});
    expect((await f.operate(f.grant,{action:'read',entryId:saved.entry.id})).entry.id).toBe(saved.entry.id);
  });
  it('rechecks removal while Discord is responding and renews only active conversation grants',async()=>{
    const f=await conversation();await f.enable();f.advance(20*86400_000);
    await f.ask('check');f.advance(20*86400_000);
    expect((await f.ask('check')).groupId).toBe('test-group');
    f.audienceState.beforeRead=async()=>{await f.base.removeSubscriber('test-group','alice');};
    await expect(f.ask('check')).rejects.toMatchObject({status:403});
  });
});

describe('Scoped private Discord group access',()=>{
  it('pairs a real Discord context with an author-confirmed account without exposing the grant to the browser', async()=>{
    const f = await fixture('guild');
    const start = await f.call('router_bot','pair/start',{...f.context,groupId:'test-group',displayName:'Alice'});
    expect(start.url).toMatch(/^https:\/\/router.example\/group-setup\?group=test-group#discord-pair=RD-PAIR-/);
    const body = {groupId:'test-group',pairing:start.pairing};
    await expect(f.call('alice','pair/start',{...f.context,groupId:'test-group'})).rejects.toMatchObject({status:403});
    await expect(f.call('outsider','pair/info',body)).rejects.toMatchObject({status:403});
    const info = await f.call('alice','pair/info',body);
    expect(info).toMatchObject({status:'waiting',displayName:'Alice',discordUserId:f.context.discordUserId});
    expect((await f.call('router_bot','pair/poll',{...f.context,...body})).status).toBe('waiting');
    await expect(f.call('router_bot','pair/ack',{...f.context,...body})).rejects.toMatchObject({status:409});
    await expect(f.call('alice','pair/confirm',body)).rejects.toMatchObject({status:400});
    const confirmed = await f.call('alice','pair/confirm',{...body,confirmed:true});
    expect(confirmed.status).toBe('approved'); expect(confirmed.grant).toBeUndefined();
    await expect(f.call('bob','pair/confirm',{...body,confirmed:true})).rejects.toMatchObject({status:403});
    await expect(f.call('alice','pair/poll',{...f.context,...body})).rejects.toMatchObject({status:403});
    await expect(f.call('router_bot','pair/poll',{...f.context,...body,channelId:'100000000000000020'})).rejects.toMatchObject({status:403});
    const grant = await f.call('router_bot','pair/poll',{...f.context,...body});
    expect(await f.call('alice','link/status',{groupId:'test-group'})).toMatchObject({linked:false,pending:true});
    await expect(f.save(grant.grant,'Before delivery acknowledgement')).rejects.toMatchObject({status:403});
    expect((await f.call('router_bot','pair/poll',{...f.context,...body})).grant).toBe(grant.grant);
    expect((await f.call('alice','pair/confirm',{...body,confirmed:true})).grant).toBeUndefined();
    await f.call('router_bot','pair/ack',{...f.context,...body});
    expect(await f.call('router_bot','pair/poll',{...f.context,...body})).toEqual({status:'connected'});
    expect((await f.call('alice','link/status',{groupId:'test-group'})).linked).toBe(true);
    expect((await f.save(grant.grant,'Browser-linked note')).entry.handle).toBe('alice');
    await f.base.removeSubscriber('test-group','alice');
    await expect(f.call('alice','link/status',{groupId:'test-group'})).rejects.toMatchObject({status:403});
  });
  it('expires pairing links and rechecks changed group access before delivering a grant',async()=>{
    const f=await fixture();
    const start=()=>f.call('router_bot','pair/start',{...f.context,groupId:'test-group'});
    const first=await start(), second=await start();
    await expect(f.call('alice','pair/info',{groupId:'test-group',pairing:first.pairing})).rejects.toMatchObject({status:410});
    const body={groupId:'test-group',pairing:second.pairing};
    await expect(f.call('alice','pair/confirm',{...body,groupId:'another-group',confirmed:true})).rejects.toMatchObject({status:403});
    await f.call('alice','pair/confirm',{...body,confirmed:true});
    await f.base.removeSubscriber('test-group','alice');
    await expect(f.call('router_bot','pair/poll',{...body,...f.context})).rejects.toMatchObject({status:403});
    f.advance(600001);
    await expect(f.call('router_bot','pair/poll',{...body,...f.context})).rejects.toMatchObject({status:410});
  });
  it('rejects pairing after a binding change or unavailable author storage',async()=>{
    const f=await fixture();
    const first=await f.call('router_bot','pair/start',{...f.context,groupId:'test-group'});
    const body={groupId:'test-group',pairing:first.pairing};
    f.revoked.add('alice'); f.advance();
    await expect(f.call('alice','pair/confirm',{...body,confirmed:true})).rejects.toMatchObject({status:409});
    await f.call('alice','bind',{groupId:'test-group',botHandle:'router_bot',guildId:f.context.guildId,channelId:'100000000000000020'});
    await expect(f.call('bob','pair/info',body)).rejects.toMatchObject({status:403});
  });
  it('lets an author withdraw the last Discord permission and correct a mistaken account connection',async()=>{
    const f=await fixture(), linked=await f.link();
    const status=await f.call('alice','link/status',{groupId:'test-group'});
    await f.call('alice','grants/revoke',{grantId:status.grantId});
    await expect(f.save(linked.grant)).rejects.toMatchObject({status:403});
    expect((await f.call('alice','link/status',{groupId:'test-group'})).linked).toBe(false);
    expect((await f.link('alice','100000000000000099')).handle).toBe('alice');
    expect((await f.link('bob',f.context.discordUserId)).handle).toBe('bob');
  });
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
    expect([...f.data.get('bob')!.keys()].filter(k=>k.startsWith('posts/'))).toEqual([]);
    expect((await f.layer.storage.getEntry(saved.entry.id))?.to).toEqual(['#test-group']);
    const search=await f.operate(linked.grant,{action:'search',query:'synthetic'});
    expect(search.entries.map((e:JournalEntry)=>e.id)).toEqual([saved.entry.id]);
  });
  it('tells the bot how far the person\'s own posting rules let it post for them here, without extending the permission',async()=>{
    const f=await fixture(), linked=await f.link();
    const draft={mode:'automatic' as const,audience:'selected' as const,destinations:['#test-group'],purpose:'p',share:'findings',avoid:'chatter',style:'plain',instructions:'fewer, fuller notes'};
    expect(await f.operate(linked.grant,{action:'rules'})).toMatchObject({handle:'alice',groupId:'test-group',mode:'review',revision:0,rules:null});
    await f.base.savePostingRules('alice',draft,0);
    const automatic=await f.operate(linked.grant,{action:'rules'});
    expect(automatic).toMatchObject({mode:'automatic',revision:1,rules:{share:'findings',avoid:'chatter',style:'plain',instructions:'fewer, fuller notes'}});
    expect(JSON.stringify(automatic)).not.toContain('destinations');
    await f.base.savePostingRules('alice',{...draft,destinations:['#another-group']},1);
    expect((await f.operate(linked.grant,{action:'rules'})).mode).toBe('review');
    await f.base.savePostingRules('alice',{...draft,audience:'public',destinations:[]},2);
    expect((await f.operate(linked.grant,{action:'rules'})).mode).toBe('review');
    await f.base.savePostingRules('alice',{...draft,mode:'manual'},3);
    expect((await f.operate(linked.grant,{action:'rules'})).mode).toBe('manual');
    const active=async()=>(await f.base.getUser('alice'))!.discordGrants!.find(g=>!g.revokedAt)!.expiresAt, expiry=await active();
    f.advance(2*86400_000); await f.operate(linked.grant,{action:'rules'});
    expect(await active()).toBe(expiry);
    expect(groupPostingMode(undefined,'test-group')).toBe('review');
    await expect(f.operate('rdg1.forged.grant',{action:'rules'})).rejects.toMatchObject({status:403});
  });
  it('deletes only a note this person saved from Discord to this group',async()=>{
    const f=await fixture('guild'), alice=await f.link(), bob=await f.link('bob','100000000000000004');
    const saved=await f.save(alice.grant);
    await expect(f.operate(bob.grant,{action:'delete',entryId:saved.entry.id,discordUserId:'100000000000000004'})).rejects.toMatchObject({status:404});
    await expect(f.operate(alice.grant,{action:'delete',entryId:'mwabc123-notdiscord'})).rejects.toMatchObject({status:400});
    expect(await f.layer.storage.getEntry(saved.entry.id)).not.toBeNull();
    expect(await f.operate(alice.grant,{action:'delete',entryId:saved.entry.id})).toMatchObject({deleted:true});
    expect(await f.layer.storage.getEntry(saved.entry.id)).toBeNull();
    expect(await f.operate(alice.grant,{action:'delete',entryId:saved.entry.id})).toMatchObject({deleted:true});
  });
  it('rejects spoofed authors/destinations and replay with changed content; identical retries are idempotent',async()=>{
    const f=await fixture(), {grant}=await f.link();
    await expect(f.operate(grant,{action:'save',content:'fake',interactionId:'100000000000000010',handle:'bob'})).rejects.toMatchObject({status:400});
    await expect(f.operate(grant,{action:'save',content:'fake',interactionId:'100000000000000010',to:[]})).rejects.toMatchObject({status:400});
    const [first,second]=await Promise.all([f.save(grant),f.save(grant)]);
    expect(first.entry.id).toBe(second.entry.id);
    expect(second.duplicate).toBe(true);
    expect([...f.data.get('alice')!.keys()].filter(k=>k.startsWith('posts/'))).toEqual([`posts/${first.entry.id}`]);
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

describe('Discord permission lifetime and recall order',()=>{
  it('keeps a permission alive while it is used, ends it after 30 idle days, and never past a year',async()=>{
    const f = await fixture('guild');
    const linked = await f.link();
    const day = 86400_000;
    f.advance(20 * day);
    const renewed = (await f.operate(linked.grant,{action:'status'})).expiresAt;
    expect(renewed).toBe(linked.expiresAt + 20 * day);
    // Used again within the idle window: still active well past the original 30 days.
    f.advance(25 * day);
    expect((await f.save(linked.grant,'Still linked after 45 days')).saved).toBe(true);
    // Left unused for more than 30 days: it ends, with a way back.
    f.advance(GRANT_IDLE_MS + day);
    await expect(f.operate(linked.grant,{action:'status'})).rejects.toMatchObject({status:403,message:expect.stringContaining('/router-link')});

    const g = await fixture('guild');
    const long = await g.link();
    let last = long.expiresAt;
    for (let elapsed = 0; elapsed + 20 * day < GRANT_MAX_MS; elapsed += 20 * day) {
      g.advance(20 * day);
      last = (await g.operate(long.grant,{action:'status'})).expiresAt;
    }
    expect(last).toBeLessThanOrEqual(long.expiresAt - GRANT_IDLE_MS + GRANT_MAX_MS);
    g.advance(20 * day);
    await expect(g.operate(long.grant,{action:'status'})).rejects.toMatchObject({status:403});
  });

  it('does not renew a permission that was withdrawn, and unlinking never extends it',async()=>{
    const f = await fixture('guild');
    const linked = await f.link();
    f.advance(5 * 86400_000);
    await f.operate(linked.grant,{action:'unlink'});
    await expect(f.operate(linked.grant,{action:'status'})).rejects.toMatchObject({status:403});
    expect((await f.base.getUser('alice'))!.discordGrants![0].expiresAt).toBe(linked.expiresAt);
  });

  it('answers the bot\'s membership question without extending the permission',async()=>{
    const f = await fixture('guild');
    const linked = await f.link();
    f.advance(20 * 86400_000);
    expect(await f.operate(linked.grant,{action:'member'})).toEqual({handle:'alice',groupId:'test-group',expiresAt:linked.expiresAt});
    expect((await f.base.getUser('alice'))!.discordGrants![0].expiresAt).toBe(linked.expiresAt);
    // It ends on time however often the bot asks, and a removed member stops counting at once.
    f.advance(11 * 86400_000);
    await expect(f.operate(linked.grant,{action:'member'})).rejects.toMatchObject({status:403});
    const g = await fixture('guild'), other = await g.link();
    await g.base.removeSubscriber('test-group','alice');
    await expect(g.operate(other.grant,{action:'member'})).rejects.toMatchObject({status:403});
  });

  it('puts notes that match more of the question first and ignores common words',()=>{
    const notes = ['We met on Tuesday and the weather was fine.', 'Deletion receipts: the design we prefer.', 'A design sketch for storage.',
      'Notes about deletion.', 'Ünïcode café plans'].map(content=>({content}));
    expect(rankNotes(notes,'what did we say about the deletion design?').map(n=>n.content)).toEqual([
      'Deletion receipts: the design we prefer.', 'A design sketch for storage.', 'Notes about deletion.']);
    expect(rankNotes(notes,'')).toBe(notes);
    expect(rankNotes(notes,'café').map(n=>n.content)).toEqual(['Ünïcode café plans']);
    expect(rankNotes(notes,'the and')).toHaveLength(2); // only common words: fall back to matching them
    expect(rankNotes(notes,'zebra')).toEqual([]);
  });
});
