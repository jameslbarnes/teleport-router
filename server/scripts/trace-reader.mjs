// A read grant can travel through Router. The matching reader key stays on this device.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { Wallet } from 'ethers';
import { TinyCloudNode, deserializeDelegation } from '@tinycloud/node-sdk';
import { openPart } from '../dist/trace-envelope.js';
import { sessionExpiryFor } from '../dist/tinycloud-group-store.js';

export async function readGrantedTrace(request, privateKey, host) {
  const { grant, entry_id: id } = request, d = deserializeDelegation(grant.delegation);
  const did = 'did:pkh:eip155:1:' + new Wallet(privateKey).address;
  if (!/^[\w-]{1,160}$/.test(id) || d.delegateDID.toLowerCase() !== did.toLowerCase() ||
      !d.expiry || d.expiry.getTime() <= Date.now() || grant.host !== host || (d.host && d.host !== host) ||
      d.spaceId.split(':').slice(1,5).join(':').toLowerCase() !== grant.ownerDid.slice(4).toLowerCase() ||
      d.path !== 'router/traces/' + id + '/' || d.actions.length !== 1 || d.actions[0] !== 'tinycloud.kv/get')
    throw Error('The read grant does not match this reader, trace, storage host or owner.');
  const node = new TinyCloudNode({ privateKey, host, autoCreateSpace: false, enablePublicSpace: false,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false });
  await node.signIn();
  try {
    const access = await node.useDelegation({ ...d, host, expiry: sessionExpiryFor(d.expiry) });
    return await openGrantedTrace(access, grant, id, privateKey);
  } finally { await node.signOut(); }
}

export async function openGrantedTrace(access, grant, id, privateKey) {
  const get = async path => {
    const r = await access.kv.get(path, { source: 'network' });
    if (!r.ok || r.data.data == null) throw Error('TinyCloud refused the read or this trace is incomplete.');
    return r.data.data;
  };
  const raw = await get('meta'), record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const meta = record.full;
  if (record.v !== 1 || record.entryId !== id || record.ownerDid.toLowerCase() !== grant.ownerDid.toLowerCase() ||
      (record.upload && !/^[\w-]{1,160}$/.test(record.upload)) || !Number.isInteger(meta.chunks) || meta.chunks < 1 || meta.chunks > 48)
    throw Error('The trace record is invalid.');
  const pieces = [];
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = await get((record.upload ? record.upload + '/' : '') + 'full-' + String(i).padStart(3, '0'));
    if (typeof chunk !== 'string' || chunk.length > 180000) throw Error('Invalid trace chunk.');
    pieces.push(chunk);
  }
  const bytes = openPart({ ...meta, wraps: { reader: grant.wrap } }, Buffer.from(pieces.join(''), 'base64'),
    { ownerDid: record.sealedOwnerDid || record.ownerDid, entryId: id }, 'full', 'reader', privateKey);
  return gunzipSync(bytes, { maxOutputLength: 128 * 1024 * 1024 });
}

async function main() {
  const { values: v, positionals: [action, id] } = parseArgs({ allowPositionals: true, options: {
    'reader-key-file': {type:'string'}, 'router-key-file':{type:'string'}, router:{type:'string', default:'https://router.teleport.computer'},
    host:{type:'string', default:'https://tee.node.tinycloud.xyz'}, out:{type:'string'},
  } });
  const keyFile = v['reader-key-file'];
  if (!keyFile) throw Error('Give --reader-key-file <local key file>.');
  if (action === 'keygen') {
    const wallet = Wallet.createRandom(); await writeFile(keyFile, wallet.privateKey, { flag:'wx', mode:0o600 });
    console.log(wallet.signingKey.compressedPublicKey); return;
  }
  if (!['request','read','status'].includes(action) || !id || !v['router-key-file'])
    throw Error('Use keygen, request <post-id>, status <request-id>, or read <request-id> --out <new file>.');
  if (action === 'read' && !v.out) throw Error('Use --out <new file> for the private trace.');
  const privateKey = (await readFile(keyFile,'utf8')).trim();
  const key = (await readFile(v['router-key-file'],'utf8')).trim();
  const base = new URL(v.router);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1'].includes(base.hostname))) throw Error('Use an HTTPS Router.');
  const r = await fetch(new URL('/api/trace-access',base), {method:'POST',redirect:'error',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
    body: JSON.stringify(action === 'request' ? {action,entry_id:id,reader_public_key:new Wallet(privateKey).signingKey.compressedPublicKey}
      : {action:'status',request_id:id})});
  const request = await r.json();
  if (!r.ok) throw Error(request.error || 'Router did not accept the request.');
  if (action === 'read') {
    if (!request.grant) throw Error('The trace request is ' + request.state + '.');
    await writeFile(v.out, await readGrantedTrace(request, privateKey, v.host), { flag:'wx', mode:0o600 });
  }
  console.log(JSON.stringify({request_id:request.request_id, state:request.state, entry_id:request.entry_id, expires_at:request.expires_at}));
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main().catch(e => { console.error(e.message); process.exitCode=1; });
