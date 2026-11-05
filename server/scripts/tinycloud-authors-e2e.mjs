// Synthetic accounts only. Exercises real TinyCloud grants through a local Router.
// Run from server/: npm run build && node scripts/tinycloud-authors-e2e.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {Wallet} from 'ethers';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {tinyCloudGroups} from '../dist/tinycloud-group-store.js';
import {serializeDelegation} from '@tinycloud/node-sdk';
import {linkOwner,request} from './tinycloud-link-lib.mjs';

const host=process.env.TINYCLOUD_HOST||'https://tee.node.tinycloud.xyz';
const port=19000+Math.floor(Math.random()*2000), base=`http://127.0.0.1:${port}`;
const privateKey=()=>`0x${randomBytes(32).toString('hex')}`;
const routerPrivateKey=privateKey();
const server=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
  PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,NODE_ENV:'test',
  FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',GOOGLE_APPLICATION_CREDENTIALS:'',
  ANTHROPIC_API_KEY:'',MODERATOR_URL:'',MODERATOR_API_KEY:'',
  TINYCLOUD_GROUPS:'',TINYCLOUD_AUTHORS:'tinycloud',TINYCLOUD_KEY_SOURCE:'test-key',TINYCLOUD_ROUTER_KEY:routerPrivateKey,
  TINYCLOUD_HOST:host,TINYCLOUD_LEASE_MS:'1000',STAGED_STORAGE:'memory',STAGING_DELAY_MS:'3600000',
}});
// Drain output without exposing incidental credentials or synthetic content in logs.
let logs=''; for(const stream of [server.stdout,server.stderr])stream.on('data',d=>{logs=(logs+String(d)).slice(-8000);});
const clients=[],owners=[],grants=[];
const stop=()=>{if(!server.killed)server.kill();}; process.on('exit',stop);
try {
  let running=false;
  for(let i=0;i<120;i++) {try {if((await fetch(`${base}/health`)).ok){running=true;break;}}catch{}
    if(server.exitCode!==null)throw new Error(`Local Router exited ${server.exitCode}`);
    await new Promise(r=>setTimeout(r,250));}
  assert(running,'Local Router started');
  const router=await request(base,'/api/tinycloud/router');
  assert.equal(router.mode,'authors');
  console.log('PASS Router exposes a stable account DID and author storage mode');
  const accounts=[];
  const suffix=Date.now().toString(36).slice(-5);
  for(const name of ['alice','bob','carol']) {
    const handle=`${name}${suffix}`,secretKey=randomBytes(32).toString('base64url');
    await request(base,'/api/identity/register',{secret_key:secretKey,handle});
    const ownerKey=privateKey(),wallet=new Wallet(ownerKey);
    const owner=new TinyCloudNode({privateKey:ownerKey,host,prefix:'router-test',autoCreateSpace:true});
    owners.push(owner); await owner.signIn();
    const grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,
      expiryMs:3600000,includePublicSpace:false}); grants.push(grant);
    const challenge=await request(base,'/api/tinycloud/challenge',{secret_key:secretKey,delegation:serializeDelegation(grant)});
    const wrongSignature=await new Wallet(privateKey()).signMessage(challenge.message);
    const refused=await fetch(`${base}/api/tinycloud/link`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret_key:secretKey,delegation:serializeDelegation(grant),signature:wrongSignature})});
    assert.equal(refused.status,400,'A signature from another identity must be refused');
    const linked=await linkOwner({base,secretKey,signMessage:m=>wallet.signMessage(m),grant});assert(linked.linked&&linked.available);
    accounts.push({handle,secretKey,owner,grant});
    console.log(`PASS ${name} proves both identities and links their own space`);
  }
  const group=`authors-${suffix}`,first=accounts[0];
  await request(base,'/api/channels',{secret_key:first.secretKey,id:group,name:'Synthetic three-author test',join_rule:'invite',visibility:'private'});
  for(const member of accounts.slice(1)) {
    const invite=await request(base,`/api/channels/${group}/invite`,{secret_key:first.secretKey});
    await request(base,`/api/channels/${group}/join`,{secret_key:member.secretKey,invite_token:invite.token});
  }
  const ids=[];
  for(const [index,a] of accounts.entries()) {
    const client=new Client({name:'authors-e2e',version:'1'});clients.push(client);
    await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${a.secretKey}`)));
    const wrote=await client.callTool({name:'router_write_entry',arguments:{client:'code',entry:`Synthetic ownership test ${index}.`,to:[`#${group}`],
      sensitivity_check:'Synthetic test data only; no real people, credentials or private events. I certify this check is completed before writing.'}});
    const pending=(wrote.content?.[0]?.text||'').match(/Entry ID: (\S+)/)?.[1];assert(pending,'Entry staged');
    const published=await request(base,`/api/entries/${pending}/publish?key=${a.secretKey}`,{});
    assert.equal(published.entry.id,pending);ids.push(pending);
    const own=await a.owner.kv.get(`router/posts/${pending}`);assert(own.ok);
    for(const other of accounts.filter(x=>x!==a))assert.equal((await other.owner.kv.get(`router/posts/${pending}`)).ok,false);
  }
  const feed=()=>request(base,`/api/channels/${group}/entries?secret_key=${first.secretKey}`);
  assert.equal((await feed()).entries.length,3);
  assert.equal((await request(base,'/api/entries')).entries.length,0);
  assert.equal((await fetch(`${base}/api/channels/${group}/entries`)).status,401);
  console.log('PASS three authors publish into separate spaces; only members can read the combined group');

  // A fresh SDK client has a new session key, but can use the existing account-DID grant.
  const fresh=tinyCloudGroups({privateKey:routerPrivateKey,host});
  assert.equal((await fresh.routerDid()).toLowerCase(),router.did.toLowerCase());
  const reopened=await fresh.accessFor(serializeDelegation(first.grant));
  assert((await reopened.get(`posts/${ids[0]}`)).includes('Synthetic ownership'));
  console.log('PASS a fresh Router client reopens the existing grant with the same account key');

  await accounts[1].owner.revokeDelegation(accounts[1].grant.cid);
  await new Promise(r=>setTimeout(r,1100));
  assert.deepEqual((await feed()).entries.map(e=>e.id).sort(),[ids[0],ids[2]].sort());
  assert.equal((await fetch(`${base}/api/entry/${ids[1]}?key=${first.secretKey}`)).status,404);
  assert((await accounts[1].owner.kv.get(`router/posts/${ids[1]}`)).ok);
  assert((await request(base,'/api/tinycloud/status',{secret_key:accounts[0].secretKey})).available);
  assert((await request(base,'/api/tinycloud/status',{secret_key:accounts[2].secretKey})).available);
  console.log('PASS Bob revokes independently; Alice and Carol remain visible and Bob retains his own record');
  console.log('ALL AUTHOR STORAGE CHECKS PASSED');
} catch(err) {
  console.error(err instanceof Error?err.message:String(err));process.exitCode=1;
} finally {
  for(const client of clients)await client.close().catch(()=>{});
  for(let i=0;i<owners.length;i++)if(grants[i])await owners[i].revokeDelegation(grants[i].cid).catch(()=>{});
  stop();
  // SDK telemetry has background timers; avoid leaving synthetic servers running.
  setTimeout(()=>process.exit(process.exitCode||0),500).unref();
}
