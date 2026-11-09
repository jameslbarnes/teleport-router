// Synthetic accounts only. Exercises real TinyCloud grants through a local Router.
// Run from server/: npm run build && node scripts/tinycloud-authors-e2e.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes,createHmac} from 'node:crypto';
import {mkdtemp,writeFile,readFile,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet} from 'ethers';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {tinyCloudGroups} from '../dist/tinycloud-group-store.js';
import {serializeDelegation} from '@tinycloud/node-sdk';
import {linkOwner,request,confirmOwnerRecovery} from './tinycloud-link-lib.mjs';
import {canonical,recoverAuthorKey,decryptOwnerRecord,RECOVERY_KEY} from '../dist/author-records.js';
import {derivePseudonym} from '../dist/identity.js';

const host=process.env.TINYCLOUD_HOST||'https://tee.node.tinycloud.xyz';
const port=19000+Math.floor(Math.random()*2000), base=`http://127.0.0.1:${port}`;
const privateKey=()=>`0x${randomBytes(32).toString('hex')}`;
const routerPrivateKey=privateKey();
const oldIntegrity=createHmac('sha256',Buffer.from(routerPrivateKey.slice(2),'hex')).update('teleport-router/record-integrity/v1').digest();
const privateDir=await mkdtemp(join(tmpdir(),'router-encryption-synthetic-'));
const server=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
  PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,NODE_ENV:'test',
  FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',GOOGLE_APPLICATION_CREDENTIALS:'',
  ANTHROPIC_API_KEY:'',MODERATOR_URL:'',MODERATOR_API_KEY:'',
  TINYCLOUD_GROUPS:'',TINYCLOUD_AUTHORS:'tinycloud',TINYCLOUD_KEY_SOURCE:'test-key',TINYCLOUD_ROUTER_KEY:routerPrivateKey,
  TINYCLOUD_HOST:host,TINYCLOUD_LEASE_MS:'5000',STAGED_STORAGE:'memory',STAGING_DELAY_MS:'3600000',
  RECOVERY_FILE:join(privateDir,'pending.json'),
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
    const owner=new TinyCloudNode({privateKey:ownerKey,host,prefix:'router-test',autoCreateSpace:true,
      enablePublicSpace:false,sessionExpirationMs:366*86400000});
    owners.push(owner); await owner.signIn();
    const grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,
      expiryMs:365*86400000,includePublicSpace:false}); grants.push(grant);
    assert(grant.expiry.getTime()-Date.now()>364*86400000,'Owner session must not silently shorten the one-year grant');
    // Seed the exact previously deployed v1 format; linking must migrate it before activating v2.
    const legacy={id:`legacy-${name}`,handle,pseudonym:derivePseudonym(secretKey),content:'Synthetic legacy migration',timestamp:Date.now(),client:'code',to:[`#migration-${suffix}`]};
    const legacyMac=createHmac('sha256',oldIntegrity).update(`router-record-v1\0${owner.did}\0posts\0${canonical(legacy)}`).digest('hex');
    assert((await owner.kv.put(`router/posts/${legacy.id}`,canonical({version:1,value:legacy,mac:legacyMac}))).ok);
    const challenge=await request(base,'/api/tinycloud/challenge',{secret_key:secretKey,delegation:serializeDelegation(grant)});
    const wrongSignature=await new Wallet(privateKey()).signMessage(challenge.message);
    const refused=await fetch(`${base}/api/tinycloud/link`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret_key:secretKey,delegation:serializeDelegation(grant),signature:wrongSignature})});
    assert.equal(refused.status,400,'A signature from another identity must be refused');
    const correctSignature=await wallet.signMessage(challenge.message);
    const unconfirmed=await fetch(`${base}/api/tinycloud/link`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({secret_key:secretKey,delegation:serializeDelegation(grant),signature:correctSignature})});
    assert.equal(unconfirmed.status,400,'A signature alone cannot activate encryption without proving recovery');
    assert.equal((await request(base,'/api/tinycloud/status',{secret_key:secretKey})).linked,false);
    const linked=await linkOwner({base,secretKey,signMessage:m=>wallet.signMessage(m),
      confirmRecovery:prepared=>confirmOwnerRecovery(ownerKey,prepared),grant});assert(linked.linked&&linked.available);
    assert.equal(linked.encryption.version,2);assert.equal(linked.encryption.setupRequired,false);
    accounts.push({handle,secretKey,owner,ownerKey,grant,legacy});
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
  for(const path of ['/api/stats',`/api/daily-summaries/${new Date().toISOString().slice(0,10)}/entries`])
    assert(!(JSON.stringify(await request(base,path))).includes('Synthetic ownership'));
  console.log('PASS three authors publish into separate spaces; only members can read the combined group');

  // A fresh SDK client has a new session key, but can use the existing account-DID grant.
  const fresh=tinyCloudGroups({privateKey:routerPrivateKey,host});
  assert.equal((await fresh.routerDid()).toLowerCase(),router.did.toLowerCase());
  const reopened=await fresh.accessFor(serializeDelegation(first.grant));
  const ciphertext=await reopened.get(`posts/${ids[0]}`);
  assert.equal(JSON.parse(ciphertext).version,2);
  assert(!ciphertext.includes('Synthetic ownership'));
  const prior=await reopened.getVersioned(`posts/${ids[0]}`);
  await assert.rejects(reopened.put(`posts/${ids[0]}`,'must not overwrite',{ifMatch:'"deliberately-wrong"'}));
  await assert.rejects(reopened.put(`posts/${ids[0]}`,'must not overwrite',{ifNoneMatch:'*'}));
  assert.equal(await reopened.get(`posts/${ids[0]}`),prior.value);
  await reopened.put('conditional-probe','synthetic');
  const probe=await reopened.getVersioned('conditional-probe');
  await reopened.delete('conditional-probe');
  await assert.rejects(reopened.put('conditional-probe','must not resurrect',{ifMatch:probe.etag}));
  assert.equal(await reopened.get('conditional-probe'),null);
  console.log('PASS hosted node rejects stale/create-only conditional writes and cannot resurrect the deleted probe');
  console.log('PASS a fresh Router client reopens the existing grant with the same account key');

  await accounts[1].owner.revokeDelegation(accounts[1].grant.cid);
  await new Promise(r=>setTimeout(r,5100));
  assert.deepEqual((await feed()).entries.map(e=>e.id).sort(),[ids[0],ids[2]].sort());
  assert.equal((await fetch(`${base}/api/entry/${ids[1]}?key=${first.secretKey}`)).status,404);
  assert((await accounts[1].owner.kv.get(`router/posts/${ids[1]}`)).ok);
  const bob=accounts[1],binding={ownerDid:bob.owner.did,space:bob.grant.spaceId,prefix:bob.grant.path};
  const ownerRead=async path=>{const r=await bob.owner.kv.get('router/'+path,{source:'network'});assert(r.ok);return typeof r.data.data==='string'?r.data.data:JSON.stringify(r.data.data);};
  const recoveryKey=recoverAuthorKey(bob.ownerKey,await ownerRead(RECOVERY_KEY),binding);
  assert.equal(decryptOwnerRecord(recoveryKey,await ownerRead(`posts/${ids[1]}`),binding,'posts',ids[1]).content,'Synthetic ownership test 1.');
  assert.deepEqual(decryptOwnerRecord(recoveryKey,await ownerRead(`posts/${bob.legacy.id}`),binding,'posts',bob.legacy.id),bob.legacy);
  recoveryKey.fill(0);
  // Run the shipped owner-only CLI after revocation, with no Router key in its input.
  const keyFile=join(privateDir,'owner.key'),exportFile=join(privateDir,'export.json');
  await writeFile(keyFile,bob.ownerKey,{flag:'wx',mode:0o600});
  const exported=spawn(process.execPath,['scripts/decrypt-my-router-data.mjs','--tinycloud-key-file',keyFile,'--space-prefix','router-test','--host',host,'--output',exportFile],
    {cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe']});
  exported.stdout.resume();exported.stderr.resume();
  const code=await new Promise((resolve,reject)=>{exported.once('error',reject);exported.once('exit',resolve);});
  assert.equal(code,0,'Owner-only recovery CLI succeeds after Router revocation');
  const recovered=JSON.parse(await readFile(exportFile,'utf8'));
  assert(recovered.records.some(r=>r.value.id===ids[1]&&r.value.content==='Synthetic ownership test 1.'));
  assert(recovered.records.some(r=>r.value.id===bob.legacy.id));
  console.log('PASS owner key and shipped export CLI decrypt both migrated and new records after Router access is revoked');
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
  for(const name of ['owner.key','export.json','pending.json'])await unlink(join(privateDir,name)).catch(()=>{});
  await rmdir(privateDir).catch(()=>{});
  // SDK telemetry has background timers; avoid leaving synthetic servers running.
  setTimeout(()=>process.exit(process.exitCode||0),500).unref();
}
