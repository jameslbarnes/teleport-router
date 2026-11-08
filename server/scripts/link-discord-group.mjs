// Operator setup. Personal Router keys stay outside the bot; only a one-use code goes to Discord.
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import {dirname,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';

const {values:v}=parseArgs({options:{...Object.fromEntries([
  'base','router-key-file','bot-key-file','bot-handle','group','guild','channel','scope','discord-user','code-file'
].map(key=>[key,{type:'string'}])), 'create-group':{type:'boolean',default:false}}});
for(const key of ['router-key-file','bot-key-file','bot-handle','group','guild','discord-user','code-file'])
  if(!v[key])throw new Error('Missing --'+key);
const scope=v.scope||'channel';
if(!['channel','guild'].includes(scope)||(scope==='channel'&&!v.channel)||(scope==='guild'&&v.channel))
  throw new Error('Use --scope channel with --channel, or --scope guild without --channel.');
const base=v.base||'https://router.teleport.computer';
if(new URL(base).protocol!=='https:')throw new Error('Setup requires HTTPS.');
const ownerKey=(await readFile(v['router-key-file'],'utf8')).trim();
if(!/^[A-Za-z0-9_-]{32,64}$/.test(ownerKey))throw new Error('Invalid Router key file.');
if(v['bot-handle']==='router_discord')throw new Error('The ordinary public-search identity cannot be the private-command identity.');
async function protectedWrite(path,text){
  path=resolve(path);await mkdir(dirname(path),{recursive:true,mode:0o700});
  await writeFile(path,text,{mode:0o600,flag:'wx'});
  if(process.platform==='win32')execFileSync('icacls',[path,'/inheritance:r','/grant:r',`${process.env.USERNAME}:F`,'SYSTEM:F'],{stdio:'ignore'});
}
async function post(path,key,body,allowConflict=false){
  const response=await fetch(new URL(path,base),{method:'POST',redirect:'error',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
  const result=await response.json();
  if(!response.ok&&!(allowConflict&&response.status===409))throw new Error(`${path}: HTTP ${response.status}`);
  return {status:response.status,result};
}
// Reusing a group is the default. A typo must never create and bind an empty group.
const groupUrl=new URL('/api/channels/'+encodeURIComponent(v.group),base);
groupUrl.searchParams.set('secret_key',ownerKey);
let existing;
try {existing=await fetch(groupUrl,{redirect:'error',signal:AbortSignal.timeout(45000)});}
catch {throw new Error('Could not verify the private group. Nothing was changed.');}
if(existing.status===404){
  if(!v['create-group'])throw new Error('The private group does not exist. Use --create-group only to deliberately create a new group.');
  await post('/api/channels',ownerKey,{secret_key:ownerKey,id:v.group,name:v.group,
    description:'Selected notes from a linked Discord space.',visibility:'private',join_rule:'invite'});
} else {
  if(!existing.ok)throw new Error('Could not read the private group: HTTP '+existing.status);
  const group=await existing.json();
  if(group.id!==v.group||(group.joinRule||(group.visibility==='private'?'invite':'open'))!=='invite')
    throw new Error('The existing group must match the requested ID and be invite-only.');
}
let botKey;
try{botKey=(await readFile(v['bot-key-file'],'utf8')).trim();}
catch(error){if(error.code!=='ENOENT')throw error;botKey=randomBytes(32).toString('base64url');await protectedWrite(v['bot-key-file'],botKey+'\n');}
if(!/^[A-Za-z0-9_-]{32,64}$/.test(botKey)||botKey===ownerKey)throw new Error('Use a separate private service key.');
const identity=await post('/api/identity/register',botKey,{secret_key:botKey,handle:v['bot-handle']},true);
if(identity.result.handle!==v['bot-handle'])throw new Error('The private service handle belongs to a different identity.');
const binding={groupId:v.group,guildId:v.guild,scope,...(scope==='channel'?{channelId:v.channel}:{}),botHandle:v['bot-handle']};
const bound=await post('/api/discord/bind',ownerKey,binding);
if((bound.result.scope||'channel')!==scope||bound.result.guildId!==v.guild||bound.result.channelId!==v.channel)
  throw new Error('Router did not confirm the requested Discord scope.');
const {result}=await post('/api/discord/link/start',ownerKey,{groupId:v.group,discordUserId:v['discord-user']});
await protectedWrite(v['code-file'],JSON.stringify({code:result.code,expiresAt:result.expiresAt,groupId:result.groupId},null,2)+'\n');
console.log(JSON.stringify({groupId:result.groupId,scope,guildId:v.guild,...(v.channel?{channelId:v.channel}:{}),
  botHandle:v['bot-handle'],codeFile:resolve(v['code-file']),expiresAt:result.expiresAt}));
