import { serializeDelegation } from '@tinycloud/node-sdk';
import {recoverAuthorKey,ownerRecoveryProof} from '../dist/author-records.js';

export function confirmOwnerRecovery(privateKey,prepared) {
  const key=recoverAuthorKey(privateKey,prepared.recovery,prepared.context);
  try{return ownerRecoveryProof(key,prepared.context,prepared.message,prepared.recovery);}finally{key.fill(0);}
}

export async function request(base,path,body) {
  const response=await fetch(new URL(path,base),{method:body?'POST':'GET',
    headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(120000)});
  const json=await response.json();
  if(!response.ok)throw new Error(`${path}: HTTP ${response.status}${json.error?` (${String(json.error).slice(0,250)})`:''}`);
  return json;
}

/** Caller keeps both keys local. Prove recovery works before any record is migrated. */
export async function linkOwner({base,secretKey,signMessage,confirmRecovery,grant,onProgress=()=>{}}) {
  if(typeof confirmRecovery!=='function')throw new Error('A client that can decrypt the owner recovery key is required before linking.');
  const delegation=serializeDelegation(grant);
  const challenge=await request(base,'/api/tinycloud/challenge',{secret_key:secretKey,delegation});
  const signature=await signMessage(challenge.message);
  const prepared=await request(base,'/api/tinycloud/recovery',{secret_key:secretKey,delegation,signature});
  if(prepared.message!==challenge.message||prepared.context.space!==grant.spaceId||prepared.context.prefix!==grant.path)
    throw new Error('Recovery confirmation does not match this link request.');
  const recovery_proof=await confirmRecovery(prepared);
  await request(base,'/api/tinycloud/link',{secret_key:secretKey,delegation,signature,recovery_proof});
  let last='';
  for(;;) {
    const status=await request(base,'/api/tinycloud/status',{secret_key:secretKey});
    if(status.job?.progress!==last) {last=status.job?.progress;onProgress(last);}
    if(status.job?.status==='failed')throw new Error(status.job.error);
    if(status.job?.status==='complete')return status;
    if(!status.job)throw new Error('Router restarted during linking. Retry the same grant; verified copies are retained.');
    await new Promise(r=>setTimeout(r,1000));
  }
}
