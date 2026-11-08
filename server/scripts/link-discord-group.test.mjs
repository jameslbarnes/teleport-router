import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const script=new URL('./link-discord-group.mjs',import.meta.url);
async function setup(groupStatus,create=false){
  const tempRoot=resolve(tmpdir());
  const dir=await mkdtemp(join(tempRoot,'router-discord-link-test-'));
  try {
    const owner=join(dir,'owner.key'),bot=join(dir,'bot.key'),code=join(dir,'code.json'),calls=join(dir,'calls.json');
    await writeFile(owner,'a'.repeat(43));await writeFile(bot,'b'.repeat(43));
    const args=['--router-key-file',owner,'--bot-key-file',bot,'--bot-handle','router_private',
      '--group','private-test','--scope','guild','--guild','100000000000000001',
      '--discord-user','100000000000000003','--code-file',code,...(create?['--create-group']:[])];
    const source=`
      import {writeFile} from 'node:fs/promises';
      const calls=[];
      process.argv=['node',${JSON.stringify(fileURLToPath(script))},...${JSON.stringify(args)}];
      globalThis.fetch=async(url,options={})=>{
        const path=new URL(url).pathname,method=options.method||'GET';
        const body=options.body?JSON.parse(options.body):{};
        calls.push({method,path,scope:body.scope,groupId:body.groupId,channelId:body.channelId});
        if(method==='GET')return Response.json({id:'private-test',visibility:'private',joinRule:'invite'},{status:${groupStatus}});
        if(path==='/api/identity/register')return Response.json({handle:'router_private'});
        if(path==='/api/channels')return Response.json({id:body.id},{status:201});
        if(path==='/api/discord/bind')return Response.json({...body,version:'synthetic'});
        if(path==='/api/discord/link/start')return Response.json({groupId:'private-test',code:'RD-LINK-synthetic',expiresAt:1});
        throw new Error('Unexpected request');
      };
      try{await import(${JSON.stringify(script.href)});}catch(error){console.error(error.message);process.exitCode=1;}
      finally{await writeFile(${JSON.stringify(calls)},JSON.stringify(calls));}
    `;
    const runner=join(dir,'run-setup.mjs');
    await writeFile(runner,source);
    const child=spawnSync(process.execPath,[runner],{encoding:'utf8',timeout:10000});
    return {status:child.status,stderr:child.stderr,calls:JSON.parse(await readFile(calls,'utf8'))};
  } finally {
    const inside=relative(tempRoot,resolve(dir));
    if(!inside||inside.startsWith('..')||isAbsolute(inside))throw new Error('Unsafe test cleanup path');
    await rm(dir,{recursive:true,force:true});
  }
}

test('a missing existing group stops before identity creation or binding',async()=>{
  const result=await setup(404);
  assert.equal(result.status,1);
  assert.match(result.stderr,/does not exist/);
  assert.deepEqual(result.calls.map(c=>c.method),['GET']);
});
test('a denied group read never creates a group or binds a service',async()=>{
  const result=await setup(403,true);
  assert.equal(result.status,1);
  assert.deepEqual(result.calls.map(c=>c.method),['GET']);
});
test('server setup reuses an existing group and confirms guild scope',async()=>{
  const result=await setup(200);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.calls.some(c=>c.path==='/api/channels'),false);
  assert.deepEqual(result.calls.find(c=>c.path==='/api/discord/bind'),
    {method:'POST',path:'/api/discord/bind',scope:'guild',groupId:'private-test'});
});
test('creating a new private group requires the explicit flag',async()=>{
  const result=await setup(404,true);
  assert.equal(result.status,0,result.stderr);
  assert.equal(result.calls.filter(c=>c.path==='/api/channels'&&c.method==='POST').length,1);
});
