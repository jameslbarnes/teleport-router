import { describe, it, expect, vi } from 'vitest';
import { authorStorage, recordCodec, type AuthorBinding } from './author-store.js';
import { MemoryStorage, StagedStorage, type JournalEntry, type User } from './storage.js';
import type { GroupStore } from './group-store.js';
import {testWallet,versionedMemoryStore,legacyRecord} from './author-test-fixtures.js';
import {RECOVERY_KEY,recoverAuthorKey,decryptOwnerRecord} from './author-records.js';

const codec = recordCodec(Buffer.alloc(32, 7),Buffer.alloc(32, 8));
const post = (handle: string, content = `research ${handle}`): Omit<JournalEntry,'id'> => ({
  handle, pseudonym: `${handle}#123`, content, timestamp: 1000, client: 'code', to: ['#lab','@reader'], inReplyTo: 'parent',
});
const binding = (handle: string): AuthorBinding => ({ownerDid:`did:pkh:eip155:1:${testWallet(handle).address}`,space:`space:${handle}`,
  ownerPublicKey:testWallet(handle).signingKey.publicKey,prefix:'router/',delegation:`grant:${handle}`,pseudonym:`${handle}#123`,linkedAt:1000});

async function fixture() {
  const base = new MemoryStorage();
  const data = new Map<string,Map<string,string>>();
  const revoked = new Set<string>();
  const users: User[]=[];
  for(const handle of ['alice','bob','carol']) {
    users.push(await base.createUser({handle,secretKeyHash:handle,legacyPseudonym:`${handle}#123`}));
    data.set(`space:${handle}`,new Map());
  }
  const resolve = async (b:AuthorBinding): Promise<GroupStore> => {
    const check=()=>{if(revoked.has(b.space))throw new Error('delegation revoked');};
    const map=data.get(b.space)!;
    return versionedMemoryStore(map,check);
  };
  let clock=1000;
  const layer=authorStorage(base,resolve,codec,{leaseMs:60,now:()=>clock});
  return {base,data,revoked,users,resolve,layer,advance:()=>{clock+=61;}};
}

describe('Each author owns their published records',()=>{
  it('copies and verifies legacy records before switching, preserves IDs, and resumes after an empty index restart',async()=>{
    const f=await fixture();
    const original=await f.base.addEntry(post('alice'));
    const conversation=await f.base.addConversation({pseudonym:'alice#123',content:'imported research',title:'A conversation',
      sourceUrl:'https://example.test/chat',platform:'claude',summary:'summary',timestamp:999,keywords:['research']});
    expect(await f.layer.link(f.users[0],binding('alice'))).toEqual({copied:2,encrypted:2,legacyCleanupPending:0});
    expect(await f.base.getEntry(original.id)).toBeNull();
    expect(await f.base.getConversation(conversation.id)).toBeNull();
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect(await fresh.storage.getEntry(original.id)).toEqual(original);
    expect(await fresh.storage.getConversation(conversation.id)).toEqual(conversation);
    expect((await fresh.storage.addEntry({...post('alice'),id:'waiting-id'} as JournalEntry)).id).toBe('waiting-id');
    expect(await f.base.getEntry('waiting-id')).toBeNull();
  });

  it('revokes one of three authors across every read surface, leaving the other two and the owner copy intact',async()=>{
    const f=await fixture();
    const records=[];
    for(const user of f.users) {
      await f.layer.link(user,binding(user.handle));
      records.push(await f.layer.storage.addEntry(post(user.handle)));
    }
    const storage=f.layer.storage as any;
    const convo=await storage.addConversation({pseudonym:'bob#123',content:'research import',title:'B',sourceUrl:'https://example.test/b',
      platform:'claude',summary:'B',timestamp:1000,keywords:['research']});
    await storage.addSummary({pseudonym:'bob#123',content:'research summary',timestamp:1000,entryIds:[records[1].id],startTime:0,endTime:1001});
    await storage.addDailySummary({date:'1970-01-01',content:'combined',timestamp:1000,entryCount:3,pseudonyms:f.users.map(u=>`${u.handle}#123`)});
    f.revoked.add('space:bob'); f.advance();
    const expected=[records[0].id,records[2].id].sort();
    for(const values of await Promise.all([
      storage.getEntries(),storage.searchEntries('research'),storage.getChannelEntries('lab'),storage.getEntriesSince(0),
      storage.getEntriesAddressedTo('reader'),storage.getRepliesTo('parent'),storage.getEntriesForDate('1970-01-01'),
    ])) expect(values.map((e:JournalEntry)=>e.id).sort()).toEqual(expected);
    expect(await storage.getEntry(records[1].id)).toBeNull();
    expect(await storage.getEntriesByHandle('bob')).toEqual([]);
    expect(await storage.getEntriesByPseudonym('bob#123')).toEqual([]);
    expect(await storage.getEntriesInRange('bob#123',0,2000)).toEqual([]);
    expect(await storage.getConversations()).toEqual([]);
    expect(await storage.getConversation(convo.id)).toBeNull();
    expect(await storage.searchConversations('research')).toEqual([]);
    expect(await storage.getSummaries()).toEqual([]);
    expect(await storage.getLastSummaryForPseudonym('bob#123')).toBeNull();
    expect(await storage.getDailySummaries()).toEqual([]);
    expect(await storage.getEntryCount()).toBe(2);
    expect(f.data.get('space:bob')!.has(`posts/${records[1].id}`)).toBe(true);
    expect(await storage.addEntry(post('alice','still writing'))).toBeTruthy();
    await expect(storage.addEntry(post('bob','cannot publish'))).rejects.toThrow();
    // A stale database copy must never restore a revoked author, including after restart.
    await f.base.addEntry(post('bob','stale database copy'));
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect(await fresh.storage.getEntriesByHandle('bob')).toEqual([]);
    f.revoked.delete('space:bob');
    expect(await fresh.refresh('bob')).toBe(true);
    expect((await fresh.storage.getEntriesByHandle('bob')).map(e=>e.content)).toEqual(['research bob']);
  });

  it('keeps legacy storage authoritative when copying or readback fails, then permits a safe retry',async()=>{
    const f=await fixture();
    const original=await f.base.addEntry(post('alice'));
    const broken=authorStorage(f.base,async b=>({...await f.resolve(b),get:async()=>null}),codec);
    await expect(broken.link(f.users[0],binding('alice'))).rejects.toThrow('readback');
    expect((await f.base.getUser('alice'))?.tinycloud).toBeUndefined();
    expect(await f.base.getEntry(original.id)).toEqual(original);
    await f.layer.link(f.users[0],binding('alice'));
    expect(await f.layer.storage.getEntry(original.id)).toEqual(original);
  });

  it('rejects modified records and forged authors on a fresh load',async()=>{
    const f=await fixture(); await f.layer.link(f.users[0],binding('alice'));
    const e=await f.layer.storage.addEntry(post('alice'));
    const map=f.data.get('space:alice')!;
    const wire=JSON.parse(map.get(`posts/${e.id}`)!); wire.ciphertext=wire.ciphertext.slice(0,-2)+'aa';
    map.set(`posts/${e.id}`,JSON.stringify(wire));
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect(await fresh.storage.getEntry(e.id)).toBeNull();
    expect(await fresh.status('alice')).toMatchObject({linked:true,available:false});
  });

  it('keeps summaries of private records out of public summary views',async()=>{
    const f=await fixture();await f.layer.link(f.users[0],binding('alice'));
    const hidden=await f.layer.storage.addEntry(post('alice','private'));
    const visible=await f.layer.storage.addEntry({...post('alice','public'),to:[]});
    const s=f.layer.storage as any;
    for(const e of [hidden,visible])await s.addSummary({pseudonym:'alice#123',content:e.content,timestamp:1000,entryIds:[e.id],startTime:0,endTime:1000});
    expect((await s.getSummaries()).map((v:any)=>v.content)).toEqual(['public']);
    expect(f.data.get('space:alice')!.size).toBe(5); // four records plus owner recovery
  });

  it('does not silently switch an existing identity to a different empty space',async()=>{
    const f=await fixture();await f.layer.link(f.users[0],binding('alice'));
    await expect(f.layer.link(f.users[0],{...binding('alice'),space:'another-space'})).rejects.toThrow('explicit migration');
    expect(await f.layer.status('alice')).toMatchObject({space:'space:alice',available:true});
  });

  it('retries incomplete cleanup without losing the verified destination',async()=>{
    const f=await fixture(); const e=await f.base.addEntry(post('alice'));
    const remove=vi.spyOn(f.base,'deleteEntry').mockRejectedValueOnce(new Error('unavailable'));
    expect(await f.layer.link(f.users[0],binding('alice'))).toMatchObject({legacyCleanupPending:1});
    expect(await f.layer.storage.getEntry(e.id)).toEqual(e);
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect(await fresh.link((await f.base.getUser('alice'))!,binding('alice'))).toMatchObject({legacyCleanupPending:0});
    expect(await f.base.getEntry(e.id)).toBeNull(); remove.mockRestore();
  });

  it('serializes migration with new writes to the same author',async()=>{
    const f=await fixture(); await f.base.addEntry(post('alice','before'));
    const linking=f.layer.link(f.users[0],binding('alice'));
    const saving=f.layer.storage.addEntry(post('alice','during'));
    await linking; const saved=await saving;
    expect(await f.base.getEntriesByHandle('alice')).toEqual([]);
    expect((await f.layer.storage.getEntriesByHandle('alice')).map(e=>e.content).sort()).toEqual(['before','during']);
    expect(f.data.get('space:alice')!.has(`posts/${saved.id}`)).toBe(true);
  });
});

describe('Encryption migration of an already-linked author',()=>{
  async function legacyFixture() {
    const f=await fixture(); const b=binding('alice'); const {ownerPublicKey:_,...old}=b;
    await f.base.updateUser('alice',{tinycloud:old});
    const values=['old-a','old-b'].map(id=>({...post('alice',`private before encryption ${id}`),id}));
    const map=f.data.get(b.space)!;
    for(const value of values)map.set(`posts/${value.id}`,legacyRecord(Buffer.alloc(32,7),b.ownerDid,'posts',value));
    return {...f,b,map,values};
  }
  it('retains old reads, waits for owner recovery setup before new writes, then encrypts and persists the downgrade barrier',async()=>{
    const f=await legacyFixture();
    expect((await f.layer.storage.getEntriesByHandle('alice')).length).toBe(2);
    expect(await f.layer.status('alice')).toMatchObject({encryption:{version:1,setupRequired:true}});
    await expect(f.layer.storage.addEntry(post('alice'))).rejects.toThrow('Re-link');
    const old=f.map.get('posts/old-a')!;
    expect(await f.layer.link(f.users[0],f.b)).toMatchObject({encrypted:2});
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBe(2);
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect((await fresh.storage.getEntriesByHandle('alice')).length).toBe(2);
    expect(await fresh.status('alice')).toMatchObject({encryption:{version:2,setupRequired:false}});
    f.revoked.add(f.b.space);
    expect(await fresh.refresh('alice')).toBe(false);
    const recovered=recoverAuthorKey(testWallet('alice').privateKey,f.map.get(RECOVERY_KEY)!,f.b);
    expect(decryptOwnerRecord(recovered,f.map.get('posts/old-a')!,f.b,'posts','old-a')).toEqual(f.values[0]);
    f.revoked.delete(f.b.space);f.map.set('posts/old-a',old);
    const replay=authorStorage(f.base,f.resolve,codec);
    expect(await replay.storage.getEntriesByHandle('alice')).toEqual([]);
    await expect(replay.link(f.users[0],f.b)).rejects.toThrow();
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBe(2);
  });
  it('retains a waiting post across recovery while encryption setup is pending, and fails direct imports/summaries cleanly',async()=>{
    const f=await legacyFixture();const staged=new StagedStorage(60000,f.layer.storage);
    const imported={pseudonym:'alice#123',content:'pending import',title:'Import',sourceUrl:'https://example.test/chat',platform:'claude' as const,summary:'Summary',timestamp:1000,keywords:[]};
    let restarted:StagedStorage|undefined;
    try {
      const pending=await staged.addEntry(post('alice','waiting through upgrade'));
      await expect(staged.publishEntry(pending.id)).rejects.toThrow('Re-link');
      await expect(staged.addConversation(imported)).rejects.toThrow('Re-link');
      await expect(staged.addSummary({pseudonym:'alice#123',content:'summary',timestamp:1000,entryIds:['old-a'],startTime:0,endTime:1000})).rejects.toThrow('Re-link');
      const saved=staged.getPendingState();staged.stop();
      const fresh=authorStorage(f.base,f.resolve,codec);restarted=new StagedStorage(60000,fresh.storage);restarted.restorePendingState(saved);
      expect(restarted.isPending(pending.id)).toBe(true);
      expect(await f.base.getConversations()).toEqual([]);
      await fresh.link(f.users[0],f.b);
      await restarted.publishEntry(pending.id);
      expect((await fresh.storage.getEntry(pending.id))?.content).toBe('waiting through upgrade');
      expect(restarted.isPending(pending.id)).toBe(false);
    } finally {staged.stop();restarted?.stop();}
  });
  it('resumes a partially committed migration without losing records or accepting a downgrade afterwards',async()=>{
    const f=await legacyFixture();let fail=true;
    const partial=authorStorage(f.base,async b=>{const s=await f.resolve(b);return {...s,async put(k,v,c){
      await s.put(k,v,c);if(k==='posts/old-b'&&fail){fail=false;throw new Error('ack lost');}
    }};},codec);
    await expect(partial.link(f.users[0],f.b)).rejects.toThrow('ack lost');
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBeUndefined();
    const fresh=authorStorage(f.base,f.resolve,codec);
    expect((await fresh.storage.getEntriesByHandle('alice')).length).toBe(2);
    await fresh.link(f.users[0],f.b);
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBe(2);
    for(const value of f.values)expect(codec.decode(f.map.get(`posts/${value.id}`)!,f.b,'posts',value.id)).toEqual(value);
  });
  it('recovers from a lost acknowledgement creating the recovery record without replacing it',async()=>{
    const f=await legacyFixture();let fail=true;
    const interrupted=authorStorage(f.base,async b=>{const s=await f.resolve(b);return {...s,async put(k,v,c){
      await s.put(k,v,c);if(k===RECOVERY_KEY&&fail){fail=false;throw new Error('recovery acknowledgement lost');}
    }};},codec);
    await expect(interrupted.link(f.users[0],f.b)).rejects.toThrow('recovery acknowledgement');
    const saved=f.map.get(RECOVERY_KEY);
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBeUndefined();
    await interrupted.link(f.users[0],f.b);
    expect(f.map.get(RECOVERY_KEY)).toBe(saved);
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBe(2);
  });
  it.each(['delete','edit'])('does not overwrite an owner %s between reading and conditional migration',async action=>{
    const f=await legacyFixture();let changed=false;
    const racing=authorStorage(f.base,async b=>{const s=await f.resolve(b);return {...s,async getVersioned(k){
      const got=await s.getVersioned!(k);
      if(k==='posts/old-a'&&!changed){changed=true;if(action==='delete')f.map.delete(k);else f.map.set(k,'owner changed this record');}
      return got;
    }};},codec);
    await expect(racing.link(f.users[0],f.b)).rejects.toThrow('changed');
    expect(f.map.get('posts/old-a')).toBe(action==='delete'?undefined:'owner changed this record');
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBeUndefined();
  });
  it('never restores an owner-deleted TinyCloud record from stale Firestore cleanup data',async()=>{
    const f=await legacyFixture();
    await f.base.addEntry(f.values[0]); // residue from the original storage migration
    await f.layer.ready();f.map.delete('posts/old-a');
    await f.layer.link(f.users[0],f.b);
    expect(f.map.has('posts/old-a')).toBe(false);
    expect(await f.base.getEntry('old-a')).toBeNull();
    expect(await f.layer.storage.getEntry('old-a')).toBeNull();
  });
  it('does not activate encryption if the durable version marker cannot be saved',async()=>{
    const f=await legacyFixture();await f.layer.ready();
    vi.spyOn(f.base,'updateUser').mockRejectedValueOnce(new Error('database unavailable'));
    await expect(f.layer.link(f.users[0],f.b)).rejects.toThrow('database unavailable');
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBeUndefined();
    expect(await f.layer.refresh('alice')).toBe(false);
    await expect(f.layer.storage.addEntry(post('alice'))).rejects.toThrow('metadata is pending');
    await f.layer.link(f.users[0],f.b);
    expect(await f.layer.status('alice')).toMatchObject({encryption:{version:2}});
  });
  it('honors a committed version floor even if its acknowledgement was lost',async()=>{
    const f=await legacyFixture();const old=f.map.get('posts/old-a')!;await f.layer.ready();
    const save=f.base.updateUser.bind(f.base);
    vi.spyOn(f.base,'updateUser').mockImplementationOnce(async(h,v)=>{await save(h,v);throw new Error('commit acknowledgement lost');});
    await expect(f.layer.link(f.users[0],f.b)).rejects.toThrow('acknowledgement');
    expect((await f.base.getUser('alice'))?.tinycloud?.minRecordVersion).toBe(2);
    f.map.set('posts/old-a',old);
    expect(await f.layer.refresh('alice')).toBe(false);
    expect(await f.layer.storage.getEntriesByHandle('alice')).toEqual([]);
    await expect(f.layer.link(f.users[0],f.b)).rejects.toThrow();
  });
});

describe('Publication when one author store is unavailable',()=>{
  it('keeps one published record if a backend commits but the acknowledgement is lost',async()=>{
    const base=new MemoryStorage(),staged=new StagedStorage(60000,base);
    const save=base.addEntry.bind(base); let fail=true;
    vi.spyOn(base,'addEntry').mockImplementation(async entry=>{
      const saved=await save(entry); if(fail){fail=false;throw new Error('acknowledgement lost');}return saved;
    });
    try {
      const waiting=await staged.addEntry(post('alice'));
      await expect(staged.publishEntry(waiting.id)).rejects.toThrow('acknowledgement');
      expect(staged.isPending(waiting.id)).toBe(true);
      expect((await staged.publishEntry(waiting.id))?.id).toBe(waiting.id);
      expect(await base.getEntryCount()).toBe(1);
    } finally {staged.stop();}
  });

  it('retains the failed waiting record and publishes other authors on the same sweep',async()=>{
    vi.useFakeTimers();
    const f=await fixture();
    for(const u of f.users)await f.layer.link(u,binding(u.handle));
    const staged=new StagedStorage(1,f.layer.storage);
    try {
      const a=await staged.addEntry(post('alice')), b=await staged.addEntry(post('bob'));
      f.revoked.add('space:alice');
      await vi.advanceTimersByTimeAsync(60000);
      expect(staged.isPending(a.id)).toBe(true); expect(staged.isPending(b.id)).toBe(false);
      expect(await f.layer.storage.getEntry(b.id)).toBeTruthy();
      f.revoked.delete('space:alice');
      await vi.advanceTimersByTimeAsync(60000);
      expect(staged.isPending(a.id)).toBe(false);
      expect((await f.layer.storage.getEntriesByHandle('alice')).length).toBe(1);
    } finally {staged.stop();vi.useRealTimers();}
  });

  it('coalesces concurrent publication and makes deletion wait for the in-flight write',async()=>{
    const base=new MemoryStorage(); const staged=new StagedStorage(60000,base);
    let release!:()=>void; const gate=new Promise<void>(r=>{release=r;});
    const save=base.addEntry.bind(base); const calls=vi.spyOn(base,'addEntry').mockImplementation(async e=>{await gate;return save(e);});
    try {
      const e=await staged.addEntry(post('alice'));
      const one=staged.publishEntry(e.id), two=staged.publishEntry(e.id), remove=staged.deleteEntry(e.id);
      release();
      const [a,b]=await Promise.all([one,two,remove]);
      expect(a).toEqual(b); expect(calls).toHaveBeenCalledTimes(1);
      expect(await base.getEntries()).toEqual([]); expect(staged.isPending(e.id)).toBe(false);
    } finally {staged.stop();}
  });
});
