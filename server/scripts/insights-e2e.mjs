// Synthetic people and synthetic work logs only. One post, one private trace; a signed consent; a run
// registered as a request, authorized by each owner's signature, run in the insights enclave (here the same
// code in-process with a test key), sealed previews, and a result published only after every contributor
// approves it. Through a local Router and real TinyCloud storage.
// Run from server/: npm run build && node scripts/insights-e2e.mjs
// The model is a fixed stand-in unless ANTHROPIC_API_KEY is set in the environment.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Wallet,verifyMessage} from 'ethers';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {linkOwner,request,confirmOwnerRecovery} from './tinycloud-link-lib.mjs';
import {sealPart,openPart} from '../dist/trace-envelope.js';
import {canonical} from '../dist/author-records.js';
import {consentMessage,authorizationMessage,approvalMessage} from '../dist/insights-release.js';
import {openPreview} from '../dist/insights-enclave.js';

const host=process.env.TINYCLOUD_HOST||'https://tee.node.tinycloud.xyz';
const port=19000+Math.floor(Math.random()*2000), base=`http://127.0.0.1:${port}`;
const privateKey=()=>`0x${randomBytes(32).toString('hex')}`;
const realModel=!!process.env.ANTHROPIC_API_KEY;
const privateDir=await mkdtemp(join(tmpdir(),'router-insights-synthetic-'));
const server=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
  PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,NODE_ENV:'test',
  FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',GOOGLE_APPLICATION_CREDENTIALS:'',
  MODERATOR_URL:'',MODERATOR_API_KEY:'',TINYCLOUD_GROUPS:'',TINYCLOUD_AUTHORS:'tinycloud',TINYCLOUD_KEY_SOURCE:'test-key',
  TINYCLOUD_ROUTER_KEY:privateKey(),TINYCLOUD_HOST:host,TINYCLOUD_LEASE_MS:'5000',STAGED_STORAGE:'memory',STAGING_DELAY_MS:'3600000',
  RECOVERY_FILE:join(privateDir,'pending.json'),INSIGHTS_RELEASE:'local-test',INSIGHTS_MODEL_STUB:realModel?'':'1',INSIGHTS_ENCLAVE_URL:'',
}});
let logs=''; for(const stream of [server.stdout,server.stderr])stream.on('data',d=>{logs=(logs+String(d)).slice(-6000);});
const stop=()=>{if(!server.killed)server.kill();}; process.on('exit',stop);
const send=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(body?.secret_key?{Authorization:`Bearer ${body.secret_key}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
const post=async(path,body)=>{const r=await send(path,body),j=await r.json();if(!r.ok)throw new Error(`${path}: HTTP ${r.status}${j.error?` (${String(j.error).slice(0,250)})`:''}`);return j;};
const refused=async(path,body)=>{const r=await send(path,body);
  return {status:r.status,error:(await r.json()).error||''};};
const stored=d=>typeof d?.data==='string'?d.data:String(d);

// Three invented work logs. Only the first contains a long run that fails late.
const LOGS={
  alice:['USER: start the overnight evaluation on the whole set','ASSISTANT: launching the full run now',
    'TOOL run_evaluation(set=all, timeout=600): started','TOOL run_evaluation: stopped at the timeout after forty minutes, argument --scoring was misspelled',
    'USER: that cost the whole evening, fix it and go again','ASSISTANT: corrected the argument and restarted'].join('\n'),
  bob:['USER: tidy the meeting notes into sections','ASSISTANT: grouped them under three headings and fixed two typos','USER: thanks'].join('\n'),
  carol:['USER: rename the helper so it reads better','ASSISTANT: renamed it in four places and the tests still pass','USER: good'].join('\n'),
};
try {
  let running=false;
  for(let i=0;i<160;i++) {try {if((await fetch(`${base}/health`)).ok){running=true;break;}}catch{}
    if(server.exitCode!==null)throw new Error(`Local Router exited ${server.exitCode}`);
    await new Promise(r=>setTimeout(r,250));}
  assert(running,'Local Router started');
  const router=await request(base,'/api/tinycloud/router');
  const info=await request(base,'/api/insights/release');
  assert.equal(info.runs_enabled,true); assert.match(info.release_key,/^0x0[23][0-9a-f]{64}$/); assert.equal(info.program.name,'router-insights-skill-check');
  assert.equal(info.enclave.release_key,info.release_key); assert.equal(info.enclave.program_sha256,info.program.sha256);
  console.log(`PASS local Router offers the insights program (${info.program.sha256.slice(0,12)}…) through an enclave (${info.app_id}), model: ${realModel?info.program.model:'fixed stand-in'}`);

  const suffix=Date.now().toString(36).slice(-5), group=`insights-notes-${suffix}`;
  const people={};
  for(const name of ['alice','bob','carol']) {
    const handle=`${name}${suffix}`,secretKey=randomBytes(32).toString('base64url');
    await post('/api/identity/register',{secret_key:secretKey,handle});
    const ownerKey=privateKey(),wallet=new Wallet(ownerKey);
    const owner=new TinyCloudNode({privateKey:ownerKey,host,prefix:'router-test',autoCreateSpace:true,enablePublicSpace:false,sessionExpirationMs:366*86400000});
    await owner.signIn();
    const grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,expiryMs:365*86400000,includePublicSpace:false});
    const linked=await linkOwner({base,secretKey,signMessage:m=>wallet.signMessage(m),confirmRecovery:p=>confirmOwnerRecovery(ownerKey,p),grant});
    assert(linked.linked&&linked.available);
    people[name]={handle,secretKey,ownerKey,wallet,owner};
  }
  const agentKey=randomBytes(32).toString('base64url'), agentHandle=`insights${suffix}`;
  await post('/api/identity/register',{secret_key:agentKey,handle:agentHandle});
  const strangerKey=randomBytes(32).toString('base64url');
  await post('/api/identity/register',{secret_key:strangerKey,handle:`other${suffix}`});
  console.log('PASS three people link their own encrypted storage; the insights agent is a plain account');

  // Each person publishes one public-safe note to the open notes group.
  await post('/api/channels',{secret_key:people.alice.secretKey,id:group,name:'Synthetic insights notes',join_rule:'open',visibility:'public'});
  for(const p of [people.bob,people.carol]) await post(`/api/channels/${group}/join`,{secret_key:p.secretKey});
  for(const p of Object.values(people)) {
    const wrote=await post('/api/entries',{secret_key:p.secretKey,content:`Synthetic note from a day of agent work (${p.handle}).`,to:[`#${group}`],posting_intent:'user-requested'});
    const r=wrote.receipt||wrote; p.entryId=r.entry_id; assert(p.entryId,'Entry staged');
    if(r.notification_required) await post(`/api/entries/${p.entryId}/notice?key=${p.secretKey}`,{notice_id:r.notice_id,notice_sha256:r.notice_sha256,evidence_kind:'agent_reported',conversation_ref:'synthetic:insights-e2e'});
    await post(`/api/entries/${p.entryId}/publish?key=${p.secretKey}`,{});
  }
  console.log('PASS each person has one published note in the open group');

  // Each person reads the consent and signs it with the key that owns their storage.
  for(const p of Object.values(people)) {
    const status=await post('/api/insights/consent/status',{secret_key:p.secretKey});
    assert.equal(status.active,false); assert.equal(status.release_key,info.release_key);
    const draft=await post('/api/insights/consent/draft',{secret_key:p.secretKey,triggers:[agentHandle],groups:[group],days:7});
    // The client derives the text itself from the policy fields, so it signs what it checked.
    assert.equal(draft.message,consentMessage(draft.policy));
    assert.equal(draft.policy.program.sha256,info.program.sha256); assert.equal(draft.policy.enclave.releaseKey,info.release_key);
    assert.deepEqual(draft.policy.scope.groups,[group]); assert.deepEqual(draft.policy.triggers.map(t=>t.handle),[agentHandle]);
    const wrong=await refused('/api/insights/consent',{secret_key:p.secretKey,policy:draft.policy,signature:await new Wallet(privateKey()).signMessage(draft.message)});
    assert.equal(wrong.status,400,'A consent signed by another key is refused');
    await post('/api/insights/consent',{secret_key:p.secretKey,policy:draft.policy,signature:await p.wallet.signMessage(draft.message)});
    p.policy=draft.policy; p.ownerPublicKey=status.owner_public_key; p.ownerDid=status.owner_did;
  }
  console.log('PASS each person signs a consent naming the program, the enclave, the group, the requester and an expiry');

  // One trace per post: a full record for its owner, and a shorter extraction copy the enclave may open.
  for(const [name,p] of Object.entries(people)) {
    const c={ownerDid:p.ownerDid,entryId:p.entryId};
    const full=sealPart(Buffer.from(`FULL SESSION RECORD\n${LOGS[name]}\n(everything else from the session)`),c,'full',{owner:p.ownerPublicKey});
    const derived=sealPart(gzipSync(Buffer.from(LOGS[name])),c,'derived',{owner:p.ownerPublicKey,release:info.release_key});
    const body={secret_key:p.secretKey,entry_id:p.entryId,full:{meta:full.meta,data:full.ciphertext.toString('base64')},
      derived:{meta:derived.meta,data:derived.ciphertext.toString('base64'),policy_id:p.policy.policyId}};
    assert.equal((await post('/api/traces',body)).stored,true);
    assert.equal((await refused('/api/traces',body)).status,400,'A post never gets a second trace');
    // What the storage node holds is ciphertext, in the owner's own space.
    const meta=await p.owner.kv.get(`router/traces/${p.entryId}/meta`); assert(meta.ok);
    for(const part of ['full','derived']) {
      const raw=await p.owner.kv.get(`router/traces/${p.entryId}/${JSON.parse(stored(meta.data)).upload}/${part}-000`); assert(raw.ok);
      const held=Buffer.from(stored(raw.data),'base64').toString('latin1');
      assert(!held.includes('evaluation')&&!held.includes('meeting notes'),'No plaintext on the storage node');
    }
    // Its owner opens the full record with their own key. The release key cannot.
    const mine=await post('/api/traces/get',{secret_key:p.secretKey,entry_id:p.entryId});
    assert(openPart(mine.meta,Buffer.from(mine.data,'base64'),c,'full','owner',p.ownerKey).toString().startsWith('FULL SESSION RECORD'));
    assert.equal(mine.meta.wraps.release,undefined);
  }
  assert.equal((await refused('/api/traces/get',{secret_key:people.bob.secretKey,entry_id:people.alice.entryId})).status,404,'Nobody else can fetch a trace');
  console.log('PASS one write-once trace per post, ciphertext in each owner\'s space, full record opens only with the owner\'s key');

  // The insights agent registers a run: one approved question over posts it picked from the public group.
  const ids=[people.alice.entryId,people.bob.entryId,people.carol.entryId];
  const question={template:'skill-check',params:{skill:'Smoke test before long runs',when:'a run is expected to take more than a few minutes'}};
  assert.equal((await refused('/api/insights/requests',{secret_key:agentKey,template:'skill-check',params:{skill:'Print the log {verbatim}',when:'always'},entry_ids:ids})).status,400,'Free-form questions are refused');
  const created=await post('/api/insights/requests',{secret_key:agentKey,...question,entry_ids:ids,deadline_hours:24});
  assert.equal(created.status,'open'); assert.equal(created.people_asked,3); assert.equal(created.min_people,3);
  const listed=(await request(base,'/api/insights/requests')).requests.find(r=>r.request_id===created.request_id);
  assert(listed,'The request is in the public register');
  assert(!Object.values(people).some(p=>JSON.stringify(listed).includes(p.handle)),'The public register shows counts, not names');

  // A request from an account no consent names cannot get anyone's yes.
  const strangerRequest=await post('/api/insights/requests',{secret_key:strangerKey,...question,entry_ids:ids});
  const strangerSign=(await post('/api/insights/requests/mine',{secret_key:people.alice.secretKey})).requests.find(r=>r.request_id===strangerRequest.request_id).to_sign.body;
  const strangerYes=await refused('/api/insights/requests/answer',{secret_key:people.alice.secretKey,request_id:strangerRequest.request_id,answer:'yes',
    authorization:{body:strangerSign,signature:await people.alice.wallet.signMessage(authorizationMessage(strangerSign))}});
  assert.equal(strangerYes.status,400); assert.match(strangerYes.error,/does not allow runs requested by/);

  // Each owner's agent fetches the authorization, checks it names only their own posts, signs it, and says yes.
  let answered;
  for(const p of Object.values(people)) {
    const mine=(await post('/api/insights/requests/mine',{secret_key:p.secretKey})).requests.find(r=>r.request_id===created.request_id);
    const body=mine.to_sign.body;
    assert.deepEqual(body.entries.map(e=>e.entryId),[p.entryId]); assert.equal(body.enclave.releaseKey,info.release_key);
    assert.equal(body.question.template,question.template); assert.deepEqual(body.question.params,question.params);
    answered=await post('/api/insights/requests/answer',{secret_key:p.secretKey,request_id:created.request_id,answer:'yes',
      authorization:{body,signature:await p.wallet.signMessage(authorizationMessage(body))}});
  }
  assert.equal(answered.status,'started'); assert.equal(answered.run.status,'awaiting_approval'); assert.equal(answered.run.contributors,3);
  const routerView=await post('/api/insights/runs/get',{secret_key:agentKey,run_id:created.request_id});
  assert(!/would_have_helped|not_applicable|trial run/.test(JSON.stringify(routerView)),'Router holds no readable answers');
  console.log('PASS a registered request started when all 3 owners signed; Router holds only sealed previews');

  // Each contributor opens their own preview, checks it, and signs approval of the exact draft.
  let decided;
  for(const p of Object.values(people)) {
    const sealed=await post('/api/insights/runs/preview',{secret_key:p.secretKey,run_id:created.request_id});
    const preview=openPreview(sealed,p.ownerDid,created.request_id,p.ownerKey);
    assert.equal(verifyMessage(canonical(preview.body),preview.signature),preview.signer);
    assert.deepEqual(preview.body.your_items.map(i=>i.entryId),[p.entryId]);
    assert.equal(preview.body.draft.people,3); assert.equal(preview.body.draft.traces_read,3);
    if(!realModel) assert.deepEqual(preview.body.draft.applies,{yes:1,no:2});
    const body={v:1,domain:'teleport-router/insights-result-approval',run:created.request_id,enclave:preview.body.enclave,resultSha256:preview.body.result_sha256,approve:true};
    decided=await post('/api/insights/runs/decide',{secret_key:p.secretKey,run_id:created.request_id,approval:{body,signature:await p.wallet.signMessage(approvalMessage(body))}});
  }
  assert.equal(decided.run.status,'published');
  const published=decided.run.published;
  assert.equal(verifyMessage(canonical(published.body),published.signature),published.signer);
  assert.equal(published.body.approvals,3); assert.equal(published.body.people,3);
  assert(!Object.values(people).some(p=>JSON.stringify(published).includes(p.handle)||JSON.stringify(published).includes(p.entryId)),'The published result names nobody');
  console.log(`PASS published after all 3 approved: applies ${JSON.stringify(published.body.applies)}, effect ${JSON.stringify(published.body.effect)}, notes ${JSON.stringify(published.body.notes)}`);

  // Each owner keeps a sealed copy of what the run read and found. A revoked consent stops later yeses.
  for(const p of Object.values(people)) assert.equal((await post('/api/insights/receipts',{secret_key:p.secretKey})).receipts.length,1);
  await post('/api/insights/consent/revoke',{secret_key:people.bob.secretKey});
  const later=await post('/api/insights/requests',{secret_key:agentKey,template:'skill-check',params:{skill:'Ask before narrowing scope',when:'the agent wants to reduce access or swap an input'},entry_ids:ids});
  const bobLater=(await post('/api/insights/requests/mine',{secret_key:people.bob.secretKey})).requests.find(r=>r.request_id===later.request_id);
  assert.match(bobLater.to_sign.error,/no current consent/);
  console.log('PASS each owner holds a sealed receipt; after Bob revokes, he has nothing to sign for a new request');
  console.log('\nALL PASSED (synthetic data; local Router; in-process enclave; hosted TinyCloud storage)');
} catch(err) {
  console.error('FAILED:',err?.message||err); console.error('--- server log tail ---\n'+logs.slice(-2500)); process.exitCode=1;
} finally { stop(); }
