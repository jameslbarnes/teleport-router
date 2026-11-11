// Synthetic person and synthetic session log only. Runs the capture client the way a person
// would: a local Router with no release key (as in production), real hosted TinyCloud storage,
// one post, one captured trace, opened again with the owner's key.
// Run from server/: npm run build && node scripts/trace-capture-e2e.mjs
import assert from 'node:assert/strict';
import {spawn,execFile} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {Wallet} from 'ethers';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {linkOwner,request,confirmOwnerRecovery} from './tinycloud-link-lib.mjs';
import {sealFull,openFull} from '../../plugins/teleport-router/scripts/trace-lib.mjs';

const run=promisify(execFile);
const host=process.env.TINYCLOUD_HOST||'https://tee.node.tinycloud.xyz';
const port=21000+Math.floor(Math.random()*2000), base=`http://127.0.0.1:${port}`;
const privateKey=()=>`0x${randomBytes(32).toString('hex')}`;
const work=await mkdtemp(join(tmpdir(),'router-trace-capture-synthetic-'));
const cli=resolve('../plugins/teleport-router/scripts/capture-traces.mjs');
const server=spawn(process.execPath,['dist/http.js'],{cwd:process.cwd(),shell:false,stdio:['ignore','pipe','pipe'],env:{...process.env,
  PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,NODE_ENV:'test',INSIGHTS_RELEASE:'',TRACE_STORAGE:'',ANTHROPIC_API_KEY:'',
  FIREBASE_SERVICE_ACCOUNT:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',GOOGLE_APPLICATION_CREDENTIALS:'',
  MODERATOR_URL:'',MODERATOR_API_KEY:'',TINYCLOUD_GROUPS:'',TINYCLOUD_AUTHORS:'tinycloud',TINYCLOUD_KEY_SOURCE:'test-key',
  TINYCLOUD_ROUTER_KEY:privateKey(),TINYCLOUD_HOST:host,TINYCLOUD_LEASE_MS:'5000',STAGED_STORAGE:'memory',STAGING_DELAY_MS:'3600000',
  RECOVERY_FILE:join(work,'pending.json'),
}});
let logs=''; for(const stream of [server.stdout,server.stderr])stream.on('data',d=>{logs=(logs+String(d)).slice(-6000);});
const stop=()=>{if(!server.killed)server.kill();}; process.on('exit',stop);
const send=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(body?.secret_key?{Authorization:`Bearer ${body.secret_key}`}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(120000)});
const post=async(path,body)=>{const r=await send(path,body),j=await r.json();if(!r.ok)throw new Error(`${path}: HTTP ${r.status}${j.error?` (${String(j.error).slice(0,250)})`:''}`);return j;};
const status=async(path,body)=>(await send(path,body)).status;
const stored=d=>typeof d?.data==='string'?d.data:String(d);

try {
  let running=false;
  for(let i=0;i<160;i++) {try {if((await fetch(`${base}/health`)).ok){running=true;break;}}catch{}
    if(server.exitCode!==null)throw new Error(`Local Router exited ${server.exitCode}`);
    await new Promise(r=>setTimeout(r,250));}
  assert(running,'Local Router started');
  const router=await request(base,'/api/tinycloud/router');

  const suffix=Date.now().toString(36).slice(-5), handle=`dana${suffix}`, secretKey=randomBytes(32).toString('base64url');
  await post('/api/identity/register',{secret_key:secretKey,handle});
  const ownerKey=privateKey(), wallet=new Wallet(ownerKey);
  const owner=new TinyCloudNode({privateKey:ownerKey,host,prefix:'router-test',autoCreateSpace:true,enablePublicSpace:false,sessionExpirationMs:366*86400000});
  await owner.signIn();
  const grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,expiryMs:365*86400000,includePublicSpace:false});
  const linked=await linkOwner({base,secretKey,signMessage:m=>wallet.signMessage(m),confirmRecovery:p=>confirmOwnerRecovery(ownerKey,p),grant});
  assert(linked.linked&&linked.available);
  console.log('PASS a synthetic person links their own encrypted storage');

  // This server has no release key: it can keep owner-only traces and nothing else.
  assert.equal((await fetch(`${base}/api/insights/release`)).status,404);
  for(const path of ['/api/insights/runs','/api/insights/consent/draft','/api/insights/consent/status']) assert.equal(await status(path,{secret_key:secretKey}),404,path);
  console.log('PASS insights runs and consents are not offered by this server');

  // Two posts, written through the same API an agent uses.
  const ids=[];
  for(const content of ['Polling every second caused the load on the nightly job.','Polling now runs every thirty seconds.','A note written two sessions after a private tool was used.']) {
    const wrote=await post('/api/entries',{secret_key:secretKey,content,posting_intent:'user-requested'});
    ids.push((wrote.receipt||wrote).entry_id);
  }
  assert(ids.every(Boolean),'Entries staged');

  // The session log Claude Code would have written for that work, with a credential and a marker phrase in it.
  let n=0; const session='0f0f0f0f-synthetic';
  const rec=(type,message,extra={})=>JSON.stringify({type,uuid:`u${++n}`,sessionId:session,timestamp:new Date(Date.now()+n*1000).toISOString(),cwd:'/work/nightly',version:'0.0.0-synthetic',...(message?{message}:{}),...extra});
  const tool='mcp__plugin_teleport-router_router__router_write_entry';
  const use=(id,name,input)=>rec('assistant',{role:'assistant',content:[{type:'thinking',thinking:'summary of reasoning',signature:'CIPHER'.repeat(200)},{type:'tool_use',id,name,input}]});
  const result=(id,content)=>rec('user',{role:'user',content:[{type:'tool_result',tool_use_id:id,content}]},{toolUseResult:content});
  const lines=[
    rec('session-owner',null,{accountUuid:'synthetic-account'}),
    rec('user',{role:'user',content:'MARKER-ALPHA find out why the nightly job is slow'}),
    use('t1','Bash',{command:`curl ${base}/api/entries?key=${secretKey}`}),
    result('t1','the polling loop runs every second'),
    use('w1',tool,{entry:'Polling every second caused the load on the nightly job.'}),
    result('w1',JSON.stringify({receipt:{version:1,entry_id:ids[0],state:'pending'}})),
    rec('user',{role:'user',content:'MARKER-BETA good, now fix it'}),
    use('w2',tool,{entry:'Polling now runs every thirty seconds.'}),
    result('w2',JSON.stringify({receipt:{version:1,entry_id:ids[1],state:'pending'}})),
  ];
  const projects=join(work,'projects'); await mkdir(join(projects,'-work-nightly'),{recursive:true});
  await writeFile(join(projects,'-work-nightly',`${session}.jsonl`),lines.join('\n')+'\n');
  // Three Codex sessions in a chain: the first calls a tool the owner never uploads, the second only passes
  // context on, and the third posts. The third must be withheld although it never called the tool itself.
  const codex=(type,payload)=>JSON.stringify({timestamp:new Date().toISOString(),type,payload});
  const thread=(id,parent,...rest)=>[codex('session_meta',{id,session_id:id,cwd:'/work/diary',...(parent?{parent_thread_id:parent}:{})}),
    codex('response_item',{type:'message',role:'user',content:[{type:'input_text',text:`work in ${id}`}]}),...rest].join('\n')+'\n';
  const mcp=(server,tool,text)=>codex('event_msg',{type:'item_completed',thread_id:'t',item:{type:'McpToolCall',server,tool,status:'completed',result:{content:[{type:'text',text}]}}});
  await mkdir(join(projects,'codex'),{recursive:true});
  await writeFile(join(projects,'codex','rollout-1-posts.jsonl'),thread('thread-c','thread-b',mcp('router','router_write_entry',`Saved.\nEntry ID: ${ids[2]}`)));
  await writeFile(join(projects,'codex','rollout-2-between.jsonl'),thread('thread-b','thread-a'));
  await writeFile(join(projects,'codex','rollout-3-first.jsonl'),thread('thread-a',null,mcp('diary','diary_read','PRIVATE-DIARY-PAGE')));
  const keyFile=join(work,'router.key'), ownerKeyFile=join(work,'owner.key'), stateFile=join(work,'state.json');
  await writeFile(keyFile,secretKey); await writeFile(ownerKeyFile,ownerKey);
  const capture=async(...args)=>JSON.parse((await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--projects',projects,'--state',stateFile,...args],{env:{...process.env,ROUTER_KEY:'',CLAUDE_CONFIG_DIR:''}})).stdout);

  const run2=(...args)=>run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--projects',projects,'--state',stateFile,...args],{env:{...process.env,ROUTER_KEY:'',CLAUDE_CONFIG_DIR:''}}).then(()=>null,e=>e);
  const noRules=await run2('--upload',ids[0],'--owner-key-file',ownerKeyFile);
  assert(noRules&&/Before the first upload, create/.test(noRules.stderr),'Nothing is uploaded until the owner has written their rules');
  await writeFile(join(work,'rules.json'),JSON.stringify({never_upload_tools:['mcp__diary__']}));
  const indexed=await capture();
  assert.equal(indexed.posts_found,3); assert.equal(indexed.indexed_total,3); assert.equal(indexed.uploaded,0); assert.equal(indexed.indexed_withheld,1);
  assert.equal(await status('/api/traces/list',{secret_key:secretKey}),200);
  assert.deepEqual((await post('/api/traces/list',{secret_key:secretKey})).entry_ids,[]);
  console.log('PASS the default run indexes both posts and sends nothing');

  // The first real run must be told which storage key to encrypt to.
  const refused=await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--projects',projects,'--state',stateFile,'--upload',ids[0]],{env:{...process.env,ROUTER_KEY:''}}).then(()=>null,e=>e);
  assert(refused&&/needs your storage key/.test(refused.stderr),'The first upload stops until the owner supplies their own storage key');
  const wrongKey=await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--projects',projects,'--state',stateFile,'--upload',ids[0],'--owner-public-key',new Wallet(privateKey()).signingKey.compressedPublicKey],{env:{...process.env,ROUTER_KEY:''}}).then(()=>null,e=>e);
  assert(wrongKey&&/different storage key/.test(wrongKey.stderr),'A key that is not the one linked to the account stops the run');
  assert.deepEqual((await post('/api/traces/list',{secret_key:secretKey})).entry_ids,[]);
  // Only the post that was asked for is uploaded.
  const one=await capture('--upload',ids[0],'--owner-key-file',ownerKeyFile);
  assert.equal(one.uploaded,1); assert.equal(one.failed,0);
  assert.deepEqual((await post('/api/traces/list',{secret_key:secretKey})).entry_ids,[ids[0]]);
  const again=await capture('--upload',ids[0]);
  assert.equal(again.uploaded,0); assert.equal(again.already_uploaded,1);
  const unknown=await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--projects',projects,'--state',stateFile,'--upload','no-such-entry'],{env:{...process.env,ROUTER_KEY:''}}).then(()=>null,e=>e);
  assert(unknown&&/No session log on this machine/.test(unknown.stdout),'A post with no local session log is reported');
  const rest=await capture('--upload-all');
  assert.equal(rest.uploaded,2); assert.equal(rest.withheld,1);
  assert.deepEqual((await post('/api/traces/list',{secret_key:secretKey})).entry_ids.sort(),[...ids].sort());
  console.log('PASS a trace is uploaded only when its post is named; each post gets one trace, once');

  // What the storage node holds, read with the owner's own session: ciphertext only.
  for(const id of ids.slice(0,2)) {
    const meta=await owner.kv.get(`router/traces/${id}/meta`); assert(meta.ok);
    const raw=await owner.kv.get(`router/traces/${id}/${JSON.parse(stored(meta.data)).upload}/full-000`); assert(raw.ok);
    const held=Buffer.from(stored(raw.data),'base64').toString('latin1');
    assert(!held.includes('MARKER')&&!held.includes('polling'),'No plaintext on the storage node');
  }
  // The owner opens each trace with their own key: the right slice, cleaned.
  const opened=[];
  for(const id of ids.slice(0,2)) {
    const out=join(work,`${id}.json`);
    await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--state',stateFile,'--open',id,'--owner-key-file',ownerKeyFile,'--out',out]);
    opened.push(await readFile(out,'utf8'));
  }
  assert(opened[0].includes('MARKER-ALPHA')&&!opened[0].includes('MARKER-BETA'),'The first trace is the first slice');
  assert(opened[1].includes('MARKER-BETA')&&!opened[1].includes('MARKER-ALPHA'),'The second trace is the second slice');
  for(const text of opened) for(const gone of [secretKey,'CIPHERCIPHER','toolUseResult','synthetic-account']) assert(!text.includes(gone),`Cleaned: ${gone.slice(0,12)}`);
  assert(opened[0].includes('summary of reasoning')&&opened[0].includes('[secret removed]'));
  console.log('PASS storage holds ciphertext; the owner\'s key opens each trace; slices are separate; credentials and provider ciphertext are gone');

  // The post two sessions downstream of the private tool has a record that says so and holds nothing else.
  const heldOut=join(work,'withheld.json');
  await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--state',stateFile,'--open',ids[2],'--owner-key-file',ownerKeyFile,'--out',heldOut]);
  const heldTrace=JSON.parse(await readFile(heldOut,'utf8'));
  assert.equal(heldTrace.records.length,0); assert.match(heldTrace.withheld,/descends from/); assert(!JSON.stringify(heldTrace).includes('PRIVATE-DIARY'));
  console.log('PASS a post two sessions downstream of a never-upload tool is withheld');

  // Two uploads for the same post at the same moment, against real storage: one is kept, and it opens.
  const raced=(await post('/api/entries',{secret_key:secretKey,content:'A post two uploads race for.',posting_intent:'user-requested'}));
  const racedId=(raced.receipt||raced).entry_id, mine=await post('/api/traces/owner',{secret_key:secretKey});
  const context={ownerDid:mine.owner_did,entryId:racedId};
  const attempts=['first ','second '].map(word=>{const sealed=sealFull(Buffer.from(word.repeat(60000)),context,mine.owner_public_key);
    return {word,sealed,reply:send('/api/traces',{secret_key:secretKey,entry_id:racedId,full:{meta:sealed.meta,data:sealed.ciphertext.toString('base64')}})};});
  const replies=await Promise.all(attempts.map(async a=>({...a,status:(await a.reply).status})));
  assert.deepEqual(replies.map(r=>r.status).sort(),[200,400],'Exactly one of two racing uploads is stored');
  const kept=replies.find(r=>r.status===200), got=await post('/api/traces/get',{secret_key:secretKey,entry_id:racedId});
  assert.equal(got.meta.sha256,kept.sealed.meta.sha256);
  assert(openFull(got.meta,Buffer.from(got.data,'base64'),context,ownerKey).toString().startsWith(kept.word));
  console.log('PASS of two uploads racing for one post, real storage keeps exactly one and it opens');

  // Nobody else can fetch it, and another key cannot open it.
  const strangerKey=randomBytes(32).toString('base64url');
  await post('/api/identity/register',{secret_key:strangerKey,handle:`other${suffix}`});
  assert.notEqual(await status('/api/traces/get',{secret_key:strangerKey,entry_id:ids[0]}),200);
  // Without a key in the Authorization header the server answers before reading the body.
  assert.equal((await fetch(base+'/api/traces',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret_key:secretKey,entry_id:ids[0]})})).status,401);
  const badKeyFile=join(work,'bad.key'); await writeFile(badKeyFile,privateKey());
  const cannot=await run(process.execPath,[cli,'--router',base,'--key-file',keyFile,'--state',stateFile,'--open',ids[0],'--owner-key-file',badKeyFile]).then(()=>null,e=>e);
  assert(cannot,'A different key does not open the trace');
  console.log('PASS another account cannot fetch a trace and another key cannot open one');
  console.log('\nALL PASSED (synthetic data; local Router without a release key; hosted TinyCloud storage)');
} catch(err) {
  console.error('FAILED:',err?.message||err); console.error('--- server log tail ---\n'+logs.slice(-2500)); process.exitCode=1;
} finally { stop(); }
