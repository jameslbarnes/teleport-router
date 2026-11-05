// Exercise the actual SIGTERM handler on Linux/macOS, where Docker sends SIGTERM.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,unlink,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';

if(process.platform==='win32') {console.log('SKIP: real SIGTERM recovery is checked on Linux CI.');process.exit(0);}
const dir=await mkdtemp(join(tmpdir(),'router-recovery-')),recovery=join(dir,'pending.json');
const port=24000+Math.floor(Math.random()*3000),base=`http://127.0.0.1:${port}`,key=randomBytes(32).toString('base64url');
let server,client;
const env={...process.env,PORT:String(port),LISTEN_HOST:'127.0.0.1',BASE_URL:base,STAGED_STORAGE:'memory',RECOVERY_FILE:recovery,
  STAGING_DELAY_MS:'3600000',TINYCLOUD_AUTHORS:'',TINYCLOUD_GROUPS:'',FIREBASE_SERVICE_ACCOUNT_BASE64:'',FIREBASE_SERVICE_ACCOUNT:'',
  GOOGLE_APPLICATION_CREDENTIALS:'',ANTHROPIC_API_KEY:'',MODERATOR_URL:'',MODERATOR_API_KEY:''};
async function start(){
  server=spawn(process.execPath,['dist/http.js'],{env,stdio:'ignore'});
  for(let i=0;i<150;i++) {
    if(server.exitCode!==null)throw new Error('Test Router exited before readiness');
    try{if((await fetch(`${base}/health`)).ok)return;}catch{}
    await new Promise(r=>setTimeout(r,200));
  }throw new Error('Test Router readiness timeout');
}
async function stop(){
  if(!server||server.exitCode!==null)return;
  const child=server;
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Graceful shutdown exceeded 8 seconds'));},8000);
    child.once('exit',code=>{clearTimeout(timeout);code===0?resolve():reject(new Error(`Shutdown exit ${code}`));});
    child.kill('SIGTERM');
  });server=undefined;
}
try {
  await start();
  client=new Client({name:'recovery-smoke',version:'1'});
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  const wrote=await client.callTool({name:'router_write_entry',arguments:{client:'code',entry:'Synthetic waiting post for restart verification.',
    sensitivity_check:'Synthetic test data only. I, Claude, certify I am completing this check before writing my entry.'}});
  const id=(wrote.content?.[0]?.text||'').match(/Entry ID: (\S+)/)?.[1];assert(id);
  await client.close();client=undefined;await stop();
  assert(JSON.parse(await readFile(recovery,'utf8')).entries.some(e=>e.id===id));
  await start();
  assert.equal((await fetch(`${base}/api/entry/${id}`)).status,404);
  const own=await fetch(`${base}/api/entry/${id}?key=${key}`);assert.equal(own.status,200);
  assert.equal((await own.json()).id,id);
  const deleted=await fetch(`${base}/api/entries/${id}?key=${key}`,{method:'DELETE'});assert(deleted.ok);
  await stop();
  console.log('PASS actual SIGTERM recovery restores the same waiting post, private to its author');
} finally {
  await client?.close().catch(()=>{});
  await stop().catch(()=>{});
  for(const name of await readdir(dir))await unlink(join(dir,name));
  await rmdir(dir);
}
