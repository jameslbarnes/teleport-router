import { serializeDelegation } from '@tinycloud/node-sdk';

export async function request(base,path,body) {
  const response=await fetch(new URL(path,base),{method:body?'POST':'GET',
    headers:body?{'Content-Type':'application/json'}:undefined,body:body?JSON.stringify(body):undefined,
    signal:AbortSignal.timeout(120000)});
  const json=await response.json();
  if(!response.ok)throw new Error(`${path}: HTTP ${response.status}${json.error?` (${String(json.error).slice(0,250)})`:''}`);
  return json;
}

/** Caller keeps both keys local. Only the scoped grant and one-time signature go to Router. */
export async function linkOwner({base,secretKey,signMessage,grant,onProgress=()=>{}}) {
  const delegation=serializeDelegation(grant);
  const challenge=await request(base,'/api/tinycloud/challenge',{secret_key:secretKey,delegation});
  const signature=await signMessage(challenge.message);
  await request(base,'/api/tinycloud/link',{secret_key:secretKey,delegation,signature});
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
