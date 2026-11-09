// Existing key files only: this command never silently creates or replaces an identity.
// node scripts/link-tinycloud.mjs --tinycloud-key-file <path> --router-key-file <path>
// Optional: --base <url> --space-prefix router --receipt <path> --revoke --renew
import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {Wallet} from 'ethers';
import {TinyCloudNode,serializeDelegation,deserializeDelegation} from '@tinycloud/node-sdk';
import {linkOwner,request,confirmOwnerRecovery} from './tinycloud-link-lib.mjs';
import {recoverAuthorKey} from '../dist/author-records.js';

const {values}=parseArgs({options:{'tinycloud-key-file':{type:'string'},'router-key-file':{type:'string'},base:{type:'string',default:'https://router.teleport.computer'},
  'space-prefix':{type:'string',default:'router'},receipt:{type:'string'},revoke:{type:'boolean',default:false},renew:{type:'boolean',default:false}}});
if(!values['tinycloud-key-file']||!values['router-key-file'])throw new Error('Provide both existing key file paths. Key values must never be command-line arguments.');
const base=new URL(values.base);
if(base.protocol!=='https:'&&!['127.0.0.1','localhost'].includes(base.hostname))throw new Error('Use HTTPS for a remote Router.');
const keyPath=resolve(values['tinycloud-key-file']),receiptPath=resolve(values.receipt||`${keyPath}.router-grant.json`);
const privateKey=(await readFile(keyPath,'utf8')).trim(),secretKey=(await readFile(resolve(values['router-key-file']),'utf8')).trim();
if(!/^0x[\da-fA-F]{64}$/.test(privateKey))throw new Error('TinyCloud key file is not a 32-byte hex key.');
if(!/^[A-Za-z0-9_-]{32,64}$/.test(secretKey))throw new Error('Router key file is not a valid Router identity key.');
const router=await request(base,'/api/tinycloud/router');
if(router.mode!=='authors'||router.folder!=='router/')throw new Error('This Router has not enabled per-author TinyCloud storage.');
const grantLifetime=365*24*3600*1000;
const owner=new TinyCloudNode({privateKey,host:router.host,prefix:values['space-prefix'],autoCreateSpace:true,
  enablePublicSpace:false,sessionExpirationMs:grantLifetime+86400000});
await owner.signIn();
if(values.revoke) {
  const receipt=JSON.parse(await readFile(receiptPath,'utf8'));
  if(receipt.ownerDid.toLowerCase()!==owner.did.toLowerCase()||receipt.base!==base.origin)throw new Error('The receipt does not belong to this identity and Router.');
  for(const cid of new Set([receipt.cid,...(receipt.previousCids||[])])) {
    const result=await owner.revokeDelegation(cid);
    if(!result.ok)throw new Error('TinyCloud did not confirm revocation. Retry before treating access as withdrawn.');
  }
  console.log('Router access revoked. Your records remain in your own TinyCloud space.');
} else {
  let receipt;
  try{receipt=JSON.parse(await readFile(receiptPath,'utf8'));}catch(err){if(err.code!=='ENOENT')throw err;}
  let grant;
  if(receipt && (receipt.base!==base.origin || receipt.ownerDid.toLowerCase()!==owner.did.toLowerCase()))
    throw new Error('The existing receipt belongs to a different identity or Router. Choose a separate receipt path.');
  if(receipt && !values.renew && receipt.routerDid.toLowerCase()===router.did.toLowerCase() && Date.parse(receipt.expiry)>Date.now()+30*86400000) {
    const status=await owner.getDelegationStatus(receipt.cid);
    if(!status.ok || status.data?.status==='unavailable')throw new Error('Cannot verify the existing grant. Retry when TinyCloud is available.');
    if(status.ok && status.data?.status==='active')grant=deserializeDelegation(receipt.delegation);
  }
  if(!grant)grant=await owner.createDelegation({delegateDID:router.did,path:router.folder,actions:router.actions,
    expiryMs:grantLifetime,includePublicSpace:false});
  // The grant is scoped to Router's account, but still sensitive. Keep it beside the
  // already protected key file; POSIX mode 0600, parent ACL on Windows.
  const previousCids=[...new Set([...(receipt?.previousCids||[]),...(receipt&&receipt.cid!==grant.cid?[receipt.cid]:[])])];
  const savedReceipt={base:base.origin,ownerDid:owner.did,routerDid:router.did,cid:grant.cid,previousCids,
    space:grant.spaceId,expiry:grant.expiry,delegation:serializeDelegation(grant)};
  await writeFile(receiptPath,JSON.stringify(savedReceipt,null,2)+'\n',{mode:0o600});
  const status=await linkOwner({base,secretKey,signMessage:message=>new Wallet(privateKey).signMessage(message),
    confirmRecovery:prepared=>confirmOwnerRecovery(privateKey,prepared),grant,onProgress:message=>console.log(message)});
  // Verify the actual persisted recovery blob with the owner key before reporting success.
  const recovery=await owner.kv.get('router/recovery-v1',{source:'network'});
  if(!recovery.ok)throw new Error('Migration completed but owner recovery readback failed. Keep both existing keys and retry.');
  const raw=typeof recovery.data.data==='string'?recovery.data.data:JSON.stringify(recovery.data.data);
  recoverAuthorKey(privateKey,raw,{ownerDid:owner.did,space:grant.spaceId,prefix:grant.path}).fill(0);
  const remaining=[];
  for(const cid of previousCids) {const result=await owner.revokeDelegation(cid);if(!result.ok)remaining.push(cid);}
  savedReceipt.previousCids=remaining;
  await writeFile(receiptPath,JSON.stringify(savedReceipt,null,2)+'\n',{mode:0o600});
  if(remaining.length)console.log('The new grant is active; earlier grants still need revocation. Rerun to retry.');
  console.log(JSON.stringify({linked:status.linked,available:status.available,space:status.space,encryption:status.encryption,grantExpires:grant.expiry,result:status.job.result}));
  if(status.encryption?.version===2)console.log('Your existing TinyCloud key can recover these encrypted records independently: scripts/decrypt-my-router-data.mjs. Keep the recovery-v1 record with your data.');
}
setTimeout(()=>process.exit(0),500).unref();
