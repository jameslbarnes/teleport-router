// Owner-only export. It never contacts Router or needs Router's grant/TEE key.
// npm run build, then node scripts/decrypt-my-router-data.mjs
//   --tinycloud-key-file <protected file> --output <new private export.json>
// Optional: --space-prefix router --host https://tee.node.tinycloud.xyz
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {TinyCloudNode} from '@tinycloud/node-sdk';
import {recoverAuthorKey,decryptOwnerRecord,RECOVERY_KEY} from '../dist/author-records.js';

const {values}=parseArgs({options:{'tinycloud-key-file':{type:'string'},output:{type:'string'},
  'space-prefix':{type:'string',default:'router'},host:{type:'string',default:'https://tee.node.tinycloud.xyz'}}});
if(!values['tinycloud-key-file']||!values.output)throw new Error('Supply an existing TinyCloud key file and a NEW private export filename. Never put the key on the command line.');
const host=new URL(values.host);
if(host.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(host.hostname))throw new Error('Use HTTPS for a remote TinyCloud node.');
const privateKey=(await readFile(resolve(values['tinycloud-key-file']),'utf8')).trim();
if(!/^0x[\da-fA-F]{64}$/.test(privateKey))throw new Error('Invalid TinyCloud key file.');
const owner=new TinyCloudNode({privateKey,host:host.origin,prefix:values['space-prefix'],autoCreateSpace:false,enablePublicSpace:false});
try {
  await owner.signIn();
  const binding={ownerDid:owner.did,space:owner.spaceId,prefix:'router/'};
  if(!binding.space)throw new Error('Owner space is unavailable. Check --space-prefix.');
  const read=async key=>{
    const result=await owner.kv.get(binding.prefix+key,{source:'network'});
    if(!result.ok)throw new Error('Cannot read owner record; no partial export was written.');
    return typeof result.data.data==='string'?result.data.data:JSON.stringify(result.data.data);
  };
  const key=recoverAuthorKey(privateKey,await read(RECOVERY_KEY),binding);
  const records=[];
  try {
    for(const kind of ['posts','conversations','summaries']) {
      const listed=await owner.kv.list({path:binding.prefix+kind+'/'});
      if(!listed.ok)throw new Error('Cannot list owner records; no partial export was written.');
      for(const path of listed.data.keys||[]) {
        // Node versions return relative or space-root keys; require one exact record suffix.
        const relative=path.startsWith(binding.prefix)?path.slice(binding.prefix.length):path;
        const match=new RegExp(`^(?:${kind}/)?([\\w-]{1,160})$`).exec(relative);
        if(!match)throw new Error('Unexpected owner record path.');
        const id=match[1];
        records.push({kind,value:decryptOwnerRecord(key,await read(`${kind}/${id}`),binding,kind,id)});
      }
    }
    // This output is intentionally plaintext, for the owner's private use. Do not
    // overwrite an existing file or print its contents. Windows uses the parent ACL.
    await writeFile(resolve(values.output),JSON.stringify({exportedAt:new Date().toISOString(),...binding,records},null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(`Recovered ${records.length} records into the private export file. Router was not contacted.`);
  } finally {key.fill(0);}
} catch {
  console.error('Owner export failed. Check the key, space, recovery record and node access; no plaintext was printed.');
  process.exitCode=1;
} finally {setTimeout(()=>process.exit(process.exitCode||0),500).unref();}
