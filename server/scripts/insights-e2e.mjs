// Synthetic people and synthetic work logs only. One post, one private trace; a signed consent; a run
// registered as a request, authorized by each owner's signature, run in the insights enclave (here the same
// code in-process with a test key), sealed previews, and a result published only after every contributor
// approves it. Then the weekly pipeline: three people consent to it once, a fourth is invited, the week is planned
// from public posts, run after the invitation time, previewed, and published after the wait (the local Router's
// clock is moved forward through a route that exists only in local test runs). Through a local Router and real
// TinyCloud storage.
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
import {openPreview,contributionCommitment} from '../dist/insights-enclave.js';
import {openWeeklyPreview} from '../dist/insights-weekly.js';
import {vetoMessage} from '../dist/insights-program.js';

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
  INSIGHTS_WEEKLY_TIMER:'off',   // the weekly pipeline is driven by hand below, so the test does not race the timer
}});
let logs=''; for(const stream of [server.stdout,server.stderr])stream.on('data',d=>{logs=(logs+String(d)).slice(-6000);});
const stop=()=>{if(!server.killed)server.kill();}; process.on('exit',stop);
const send=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(body?.secret_key?{Authorization:`Bearer ${body.secret_key}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
const post=async(path,body)=>{const r=await send(path,body),j=await r.json();if(!r.ok)throw new Error(`${path}: HTTP ${r.status}${j.error?` (${String(j.error).slice(0,250)})`:''}`);return j;};
const refused=async(path,body)=>{const r=await send(path,body);
  return {status:r.status,error:(await r.json()).error||''};};
const stored=d=>typeof d?.data==='string'?d.data:String(d);

// Three invented work logs, in the shape the capture client uploads. Only the first contains a long run that fails late.
const trace=steps=>JSON.stringify({v:1,kind:'router-post-trace',entry_id:'synthetic',agent:'claude-code',records:steps.map(([kind,text],i)=>{
  const timestamp=new Date(Date.parse('2026-11-01T09:00:00Z')+i*600_000).toISOString();
  if(kind==='person')return {type:'user',timestamp,message:{role:'user',content:text}};
  if(kind==='agent')return {type:'assistant',timestamp,message:{role:'assistant',content:[{type:'text',text}]}};
  if(kind==='call')return {type:'assistant',timestamp,message:{role:'assistant',content:[{type:'tool_use',id:`t${i}`,name:'Bash',input:{command:text}}]}};
  return {type:'user',timestamp,message:{role:'user',content:[{type:'tool_result',tool_use_id:`t${i-1}`,content:text,...(kind==='failed'?{is_error:true}:{})}]}};
})});
const LOGS={
  alice:trace([['person','start the overnight evaluation on the whole set'],['agent','launching the full run now'],
    ['call','run_evaluation --set all --timeout 600'],['failed','stopped at the timeout after forty minutes, argument --scoring was misspelled'],
    ['person','that cost the whole evening, fix it and go again'],['agent','corrected the argument and restarted']]),
  bob:trace([['person','tidy the meeting notes into sections'],['agent','grouped them under three headings and fixed two typos'],['person','thanks']]),
  carol:trace([['person','rename the helper so it reads better'],['agent','renamed it in four places and the tests still pass'],['person','good']]),
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
  const question={template:'skill-check',params:{question:'smoke-test-before-long-jobs'}};
  assert.equal((await refused('/api/insights/requests',{secret_key:agentKey,template:'skill-check',params:{skill:'Say which company the person is buying',when:'always'},entry_ids:ids})).status,400,'Typed questions are refused: a request names a listed question by id');
  assert.equal((await refused('/api/insights/requests',{secret_key:agentKey,template:'skill-check',params:{question:'not-listed'},entry_ids:ids})).status,400,'Unlisted questions are refused');
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
  assert.equal(answered.status,'started'); assert.equal(answered.run.status,'awaiting_decisions'); assert.equal(answered.run.contributors,3);
  const routerView=await post('/api/insights/runs/get',{secret_key:agentKey,run_id:created.request_id});
  assert(!/would_have_helped|not_applicable|trial run/.test(JSON.stringify(routerView)),'Router holds no readable answers');
  console.log('PASS a registered request started when all 3 owners signed; Router holds only sealed previews');

  // Each contributor opens their own preview, which holds only their own answers, checks it, and approves their contribution.
  let decided;
  for(const p of Object.values(people)) {
    const sealed=await post('/api/insights/runs/preview',{secret_key:p.secretKey,run_id:created.request_id});
    const preview=openPreview(sealed,p.ownerDid,created.request_id,p.ownerKey);
    assert.equal(verifyMessage(canonical(preview.body),preview.signature),preview.signer); assert.equal(preview.signer,info.enclave.signer);
    assert.deepEqual(preview.body.your_items.map(i=>i.entryId),[p.entryId]); assert.equal(preview.body.draft,undefined);
    assert.equal(preview.body.commitment,contributionCommitment(created.request_id,p.ownerDid,preview.body.salt,preview.body.your_items));
    const body={v:1,domain:'teleport-router/insights-contribution-approval',run:created.request_id,enclave:preview.body.enclave,commitment:preview.body.commitment,approve:true};
    decided=await post('/api/insights/runs/decide',{secret_key:p.secretKey,run_id:created.request_id,approval:{body,signature:await p.wallet.signMessage(approvalMessage(body))}});
  }
  assert.equal(decided.run.status,'published');
  const published=decided.run.published;
  assert.equal(verifyMessage(canonical(published.body),published.signature),published.signer);
  assert.equal(published.body.people,3); assert.equal(published.body.traces_read,3);
  if(!realModel) assert.deepEqual(published.body.applies,{yes:1,no:2});
  assert(!Object.values(people).some(p=>JSON.stringify(published).includes(p.handle)||JSON.stringify(published).includes(p.entryId)),'The published result names nobody');
  console.log(`PASS published after all 3 approved: applies ${JSON.stringify(published.body.applies)}, effect ${JSON.stringify(published.body.effect)}, cost ${JSON.stringify(published.body.cost)}`);
  assert.equal(published.body.notes,undefined,'Nothing the model wrote is published: counts of fixed answers only');

  // Each owner keeps a sealed copy of what the run read and found. A revoked consent stops later yeses.
  for(const p of Object.values(people)) assert.equal((await post('/api/insights/receipts',{secret_key:p.secretKey})).receipts.length,1);
  await post('/api/insights/consent/revoke',{secret_key:people.bob.secretKey});
  const later=await post('/api/insights/requests',{secret_key:agentKey,template:'skill-check',params:{question:'reproduce-before-fixing'},entry_ids:ids});
  const bobLater=(await post('/api/insights/requests/mine',{secret_key:people.bob.secretKey})).requests.find(r=>r.request_id===later.request_id);
  assert.match(bobLater.to_sign.error,/no current consent/);
  console.log('PASS each owner holds a sealed receipt; after Bob revokes, he has nothing to sign for a new request');

  // ── The weekly pipeline ──────────────────────────────────────────────────────────────
  // A fourth person posts in the same open group and never consents. All four write one new note this week.
  const note=async(p,content)=>{
    const wrote=await post('/api/entries',{secret_key:p.secretKey,content,to:[`#${group}`],posting_intent:'user-requested'});
    const r=wrote.receipt||wrote; assert(r.entry_id,'Entry staged');
    if(r.notification_required) await post(`/api/entries/${r.entry_id}/notice?key=${p.secretKey}`,{notice_id:r.notice_id,notice_sha256:r.notice_sha256,evidence_kind:'agent_reported',conversation_ref:'synthetic:insights-e2e'});
    await post(`/api/entries/${r.entry_id}/publish?key=${p.secretKey}`,{});
    return r.entry_id;
  };
  const dave={handle:`dave${suffix}`,secretKey:randomBytes(32).toString('base64url')};
  await post('/api/identity/register',{secret_key:dave.secretKey,handle:dave.handle});
  await post(`/api/channels/${group}/join`,{secret_key:dave.secretKey});
  const three=Object.values(people), four=[...three,dave];
  for(const p of four) p.weekId=await note(p,`Synthetic note: a long job stopped at its timeout late in the day (${p.handle}).`);
  assert.deepEqual((await request(base,'/api/insights/weekly')).weeks,[],'No week has been planned yet');

  // Three people consent once to the weekly pipeline. Nobody is named as a requester: it starts itself.
  for(const p of three) {
    const draft=await post('/api/insights/consent/draft',{secret_key:p.secretKey,weekly:true,groups:[group],days:7});
    assert.equal(draft.message,consentMessage(draft.policy)); assert.equal(draft.policy.weekly,true); assert.deepEqual(draft.policy.triggers,[]);
    assert(draft.message.includes('Weekly pipeline: yes.'),'The signed text says the weekly pipeline is allowed');
    await post('/api/insights/consent',{secret_key:p.secretKey,policy:draft.policy,signature:await p.wallet.signMessage(draft.message)});
    p.weeklyPolicy=draft.policy;
    // The trace behind this week's note, with an extraction copy under that consent. Every log has a long run that fails late.
    const log=trace([['person','start the long job'],['call',`run_job --timeout ${600+three.indexOf(p)}`],['failed','stopped at the timeout, a misspelled argument'],['person','fix it and go again']]);
    const c={ownerDid:p.ownerDid,entryId:p.weekId};
    const full=sealPart(Buffer.from(`FULL SESSION RECORD\n${log}`),c,'full',{owner:p.ownerPublicKey});
    const derived=sealPart(gzipSync(Buffer.from(log)),c,'derived',{owner:p.ownerPublicKey,release:info.release_key});
    assert.equal((await post('/api/traces',{secret_key:p.secretKey,entry_id:p.weekId,full:{meta:full.meta,data:full.ciphertext.toString('base64')},
      derived:{meta:derived.meta,data:derived.ciphertext.toString('base64'),policy_id:draft.policy.policyId}})).stored,true);
  }
  console.log('PASS three people sign a consent that allows the weekly pipeline; a fourth has a public post and no consent');

  // Plan the week from the group's public posts. The plan is the enclave's, signed with its release key.
  const planned=await post('/api/insights/weekly/plan-now',{secret_key:agentKey});
  if(!planned.plan) {
    assert(realModel,`The stand-in always finds a question, yet the week was not planned: ${planned.reason||planned.status}`);
    console.log(`NOTE the model found nothing worth asking this week (${planned.reason||planned.status}); the rest of the weekly section needs a plan and is skipped`);
  } else {
    const plan=planned.plan.plan, run=planned.run, weekIds=four.map(p=>p.weekId);
    assert.equal(verifyMessage(canonical(plan),planned.plan.signature),info.enclave.signer,'The plan is signed by the enclave\'s release key');
    assert.equal(plan.enclave.releaseKey,info.release_key); assert.equal(plan.program.sha256,info.program.sha256); assert.equal(planned.status,'planned');
    assert.equal(Date.parse(plan.runAfter)-Date.parse(plan.plannedAt),48*3600_000,'The run may not start for 48 hours');
    if(!realModel) { for(const id of weekIds) assert(plan.entries.includes(id),'The stand-in picks every post it was shown');
      assert.equal(planned.people_invited,1); assert.equal(planned.people_with_weekly_consent,3); }
    assert.equal((await post('/api/insights/weekly/plan-now',{secret_key:agentKey})).already_planned,true,'A week gets one plan');
    console.log(`PASS the week ${plan.week} is planned from public posts, signed by the enclave: "${plan.question}" over ${plan.entries.length} posts`);

    // The fourth person gets one invitation, about their own post only. It is a private note, so it arrives after Router's usual short wait.
    if(plan.entries.includes(dave.weekId)) {
      let invitations=[];
      for(let i=0;i<60&&!invitations.length;i++) {
        invitations=(await request(base,`/api/inbox?key=${dave.secretKey}`)).received.filter(e=>e.pseudonym==='Router insights');
        if(!invitations.length) await new Promise(r=>setTimeout(r,3000));
      }
      assert.equal(invitations.length,1,'One invitation reached the person without a consent');
      const text=invitations[0].content;
      assert(text.includes(dave.weekId)&&text.includes(`"${plan.question}"`)&&text.includes(plan.runAfter)&&text.includes('only if you consent')&&text.includes('/api/insights/invites'));
      for(const p of three) assert(!text.includes(p.handle)&&!text.includes(p.weekId)&&!text.includes(p.entryId),'The invitation names nobody else and none of their posts');
      assert.deepEqual(invitations[0].to,[`@${dave.handle}`]); assert.equal(invitations[0].handle,undefined);
      for(const p of three) assert.equal((await request(base,`/api/inbox?key=${p.secretKey}`)).received.filter(e=>e.pseudonym==='Router insights').length,0,'People who consented are not invited');
      console.log('PASS the person without a consent got one invitation, naming only their own post; the others got none');
    }

    // Before the invitation time has passed, nothing is handed to the enclave.
    const early=await post('/api/insights/weekly/run-now',{secret_key:agentKey});
    assert.deepEqual(early.runs,[{run,outcome:'not_before',run_after:plan.runAfter}],'The run is refused before its time');
    assert.equal((await refused('/api/insights/weekly/preview',{secret_key:people.alice.secretKey,run_id:run})).status,404,'No preview exists yet');
    await post('/api/insights/weekly/clock',{secret_key:agentKey,advance_hours:48.1});
    const handed=await post('/api/insights/weekly/run-now',{secret_key:agentKey});
    assert.equal(handed.runs.length,1); assert.equal(handed.runs[0].outcome,'handed_over',JSON.stringify(handed.runs[0]));
    assert.deepEqual((await post('/api/insights/weekly/run-now',{secret_key:agentKey})).runs,[],'A week is handed over once');
    console.log(`PASS refused before ${plan.runAfter}; after it, the run read the traces of the people who consented: ${handed.runs[0].status}, ${handed.runs[0].contributors} contributors`);

    if(handed.runs[0].status!=='waiting') {
      assert(realModel,`With the stand-in the run should leave a draft waiting, not ${handed.runs[0].status}`);
      console.log(`NOTE the model drafted no skill (${handed.runs[0].status}); previews and publication are skipped`);
    } else {
      // Each contributor opens the draft and their own findings, sealed to them and kept in their own space.
      for(const p of three) {
        const sealed=await post('/api/insights/weekly/preview',{secret_key:p.secretKey,run_id:run});
        const preview=openWeeklyPreview(sealed,p.ownerDid,run,p.ownerKey);
        assert.equal(verifyMessage(canonical(preview.body),preview.signature),preview.signer); assert.equal(preview.signer,info.enclave.signer);
        assert.equal(preview.body.run,run); assert.equal(preview.body.status,'waiting'); assert(preview.body.draft.title&&preview.body.draft.steps.length);
        assert(preview.body.your_findings.length>=1); assert.equal(preview.body.contributors,3);
        assert((await p.owner.kv.get(`router/insights/weekly/${run}`)).ok,'The sealed preview is in its owner\'s own space');
        p.weeklyPreview=preview.body;
      }
      for(const key of [dave.secretKey,agentKey]) assert.notEqual((await refused('/api/insights/weekly/preview',{secret_key:key,run_id:run})).status,200,'Nobody else has a preview');
      const waiting=(await request(base,'/api/insights/weekly')).weeks.find(x=>x.run===run);
      assert.equal(waiting.status,'waiting'); assert.equal(waiting.published,null); assert.equal(waiting.contributors,3);
      const draft=people.alice.weeklyPreview.draft;
      assert(!JSON.stringify(waiting).includes(draft.title)&&!draft.steps.some(s=>JSON.stringify(waiting).includes(s)),'A waiting draft is not public');
      assert(!four.some(p=>JSON.stringify(waiting).includes(p.handle)),'The public register names nobody');
      console.log(`PASS each of the 3 contributors opened their sealed preview of the draft "${draft.title}"; the public register shows only that a draft is waiting`);

      // Nobody cancels. After the 72-hour wait the skill is published, signed by the release key. A veto then comes too late.
      await post('/api/insights/weekly/clock',{secret_key:agentKey,advance_hours:72.1});
      const done=(await request(base,'/api/insights/weekly')).weeks.find(x=>x.run===run);
      assert.equal(done.status,'published');
      assert.equal(verifyMessage(canonical(done.published.body),done.published.signature),info.enclave.signer);
      assert.deepEqual(done.published.body.skill,draft); assert.equal(done.published.body.people,3);
      assert(!four.some(p=>JSON.stringify(done).includes(p.handle)),'The published skill and the register name nobody');
      const veto={v:1,domain:'teleport-router/insights-weekly-veto',run,enclave:{appId:info.app_id,releaseKey:info.release_key}};
      const late=await refused('/api/insights/weekly/veto',{secret_key:people.alice.secretKey,run_id:run,veto:{body:veto,signature:await people.alice.wallet.signMessage(vetoMessage(veto))}});
      assert.equal(late.status,400); assert.match(late.error,/published/);
      console.log(`PASS published after the wait with no veto: "${done.published.body.skill.title}" (${done.published.body.skill.steps.length} steps, ${done.published.body.people} people)`);
    }
    assert.deepEqual(await post('/api/insights/invites',{secret_key:dave.secretKey,invites:'off'}),{invites:'off'});
    console.log('PASS the invited person turned further invitations off');
  }
  console.log('\nALL PASSED (synthetic data; local Router; in-process enclave; hosted TinyCloud storage)');
} catch(err) {
  console.error('FAILED:',err?.message||err); console.error('--- server log tail ---\n'+logs.slice(-2500)); process.exitCode=1;
} finally { stop(); }
