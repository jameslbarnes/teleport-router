// Isolated Router + real hosted TinyCloud. Synthetic identities only; never a personal grant.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Wallet} from 'ethers';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {linkOwner,request,confirmOwnerRecovery} from './tinycloud-link-lib.mjs';

const port=21000+Math.floor(Math.random()*1000),base=`http://127.0.0.1:${port}`;
const host='https://tee.node.tinycloud.xyz';
const server=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
  PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,NODE_ENV:'test',
  FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',GOOGLE_APPLICATION_CREDENTIALS:'',
  ANTHROPIC_API_KEY:'',MODERATOR_URL:'',MODERATOR_API_KEY:'',TINYCLOUD_GROUPS:'',TINYCLOUD_AUTHORS:'tinycloud',
  TINYCLOUD_KEY_SOURCE:'test-key',TINYCLOUD_ROUTER_KEY:'0x'+randomBytes(32).toString('hex'),TINYCLOUD_HOST:host,
  TINYCLOUD_LEASE_MS:'60000',STAGED_STORAGE:'memory',STAGING_DELAY_MS:'3600000'}});
for(const stream of [server.stdout,server.stderr])stream.on('data',()=>{});
const owners=[],grants=[],accounts=[];
let stage='startup';
const stop=()=>{if(!server.killed)server.kill();};process.on('exit',stop);
const deadline=setTimeout(()=>{console.error('Discord group e2e deadline at '+stage);stop();process.exit(1);},360000);
async function post(path,key,body,expected=200){
  const res=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
  const json=await res.json();
  assert.equal(res.status,expected,`Unexpected status for ${path} (${stage}): ${json.error||''}`);return json;
}
try {
  for(let i=0;i<100;i++){
    try {if((await fetch(base+'/health')).ok)break;}catch{}
    if(server.exitCode!==null)throw new Error('Isolated Router exited before startup');
    await new Promise(r=>setTimeout(r,200));
  }
  const router=await request(base,'/api/tinycloud/router');assert.equal(router.mode,'authors');
  const suffix=Date.now().toString(36).slice(-5);
  for(const name of ['alice','bob','carol','privbot','pubbot']){
    stage='link synthetic '+name;
    const handle=name+suffix,key=randomBytes(32).toString('base64url');
    await request(base,'/api/identity/register',{secret_key:key,handle});
    const account={handle,key};accounts.push(account);
    if(name.endsWith('bot'))continue;
    const ownerKey='0x'+randomBytes(32).toString('hex'),wallet=new Wallet(ownerKey);
    const owner=new TinyCloudNode({privateKey:ownerKey,host,prefix:'router-test',autoCreateSpace:true,enablePublicSpace:false,sessionExpirationMs:366*86400000});
    owners.push(owner);await owner.signIn();
    const grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,expiryMs:365*86400000,includePublicSpace:false});
    grants.push(grant);account.owner=owner;
    await linkOwner({base,secretKey:key,signMessage:m=>wallet.signMessage(m),confirmRecovery:p=>confirmOwnerRecovery(ownerKey,p),grant});
    console.log('PASS synthetic '+name+' storage linked');
  }
  const [alice,bob,carol,privateBot,publicBot]=accounts,group='discord-'+suffix;
  const ctx={guildId:'100000000000000001',channelId:'100000000000000002'};
  await request(base,'/api/channels',{secret_key:alice.key,id:group,name:'Synthetic Discord group',join_rule:'invite',visibility:'private'});
  for(const member of [bob,carol]){
    const invite=await request(base,`/api/channels/${group}/invite`,{secret_key:alice.key});
    await request(base,`/api/channels/${group}/join`,{secret_key:member.key,invite_token:invite.token});
  }
  await post('/api/discord/bind',alice.key,{groupId:group,...ctx,botHandle:privateBot.handle});
  const notes=[];
  for(let i=0;i<3;i++){
    stage='pair synthetic author '+i;
    const account=accounts[i],discordUserId=`10000000000000000${i+3}`;
    account.discordUserId=discordUserId;
    const code=await post('/api/discord/link/start',account.key,{groupId:group,discordUserId});
    const linked=await post('/api/discord/link/complete',privateBot.key,{...ctx,discordUserId,code:code.code});account.linked=linked;
    const body={...ctx,discordUserId,grant:linked.grant,action:'save',interactionId:`10000000000000001${i}`,content:`Synthetic Discord ownership note ${i}.`};
    stage='save synthetic author '+i;
    const saved=await post('/api/discord/operate',privateBot.key,body);notes.push(saved.entry);
    assert.equal(saved.entry.handle,account.handle);
    assert((await account.owner.kv.get(`router/posts/${saved.entry.id}`)).ok);
    for(const other of accounts.slice(0,3).filter(a=>a!==account))assert.equal((await other.owner.kv.get(`router/posts/${saved.entry.id}`)).ok,false);
    const retry=await post('/api/discord/operate',privateBot.key,body);assert.equal(retry.entry.id,saved.entry.id);assert(retry.duplicate);
  }
  console.log('PASS Discord-selected notes preserve three authors and persist only in their own TinyCloud stores; retries do not duplicate');
  const op=(action,fields={},expected=200)=>post('/api/discord/operate',privateBot.key,{...ctx,discordUserId:alice.discordUserId,grant:alice.linked.grant,action,...fields},expected);
  assert.equal((await op('search')).entries.length,3);
  await op('search',{discordUserId:'100000000000000099'},403);
  await op('search',{channelId:'100000000000000099'},403);
  await post('/api/discord/operate',publicBot.key,{...ctx,discordUserId:alice.discordUserId,grant:alice.linked.grant,action:'search'},403);
  assert.equal((await request(base,'/api/entries')).entries.length,0);
  const permalink='/api/entry/'+notes[0].id;
  assert.equal((await fetch(base+permalink)).status,404);
  assert.equal((await fetch(base+permalink,{headers:{Authorization:`Bearer ${publicBot.key}`}})).status,404);
  const privateRead=await fetch(base+permalink,{headers:{Authorization:`Bearer ${alice.key}`}});
  assert.equal(privateRead.status,200);assert.equal((await privateRead.json()).id,notes[0].id);
  console.log('PASS anonymous users, the public-search bot, wrong Discord users and wrong channels cannot retrieve private notes; authenticated source links work');
  await bob.owner.revokeDelegation(grants[1].cid);
  stage='wait for production-length 60-second revocation lease';
  console.log('Waiting for the same 60-second revocation window used in production');
  await new Promise(r=>setTimeout(r,61000));
  assert.deepEqual((await op('search')).entries.map(e=>e.id).sort(),[notes[0].id,notes[2].id].sort());
  await op('read',{entryId:notes[1].id},404);
  assert((await bob.owner.kv.get(`router/posts/${notes[1].id}`)).ok);
  console.log('PASS one author revokes independently; fresh Discord retrieval loses only that author and their own copy survives');
  await op('unlink');await op('search',{},403);
  console.log('PASS unlink withdraws the scoped Discord grant immediately');
} catch(err){console.error(err instanceof Error?err.message:'Discord group e2e failed');process.exitCode=1;}
finally {
  clearTimeout(deadline);
  for(let i=0;i<owners.length;i++)if(grants[i])await owners[i].revokeDelegation(grants[i].cid).catch(()=>{});
  stop();setTimeout(()=>process.exit(process.exitCode||0),300).unref();
}
