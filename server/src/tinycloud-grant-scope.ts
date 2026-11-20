import { deserializeDelegation } from '@tinycloud/node-sdk';
import { parseUcanGrant } from '@tinycloud/replica';

interface Expected { space: string; ownerDid: string; delegateDid: string; path: string; actions: string[]; host: string; maxMs: number }

/** Check the signed capability itself before retaining or forwarding it. TinyCloud checks the chain on use. */
export function signedFolderGrant(wire: string, expected: Expected, now: number) {
  const d = deserializeDelegation(wire);
  const matches = (actions: string[]) => Array.isArray(actions) && actions.length === expected.actions.length && expected.actions.every(a => actions.includes(a));
  const reject = () => { throw new Error('The signed TinyCloud permission must match the approved account, folder, actions and expiry.'); };
  if (d.spaceId !== expected.space || d.delegateDID?.toLowerCase() !== expected.delegateDid.toLowerCase()
      || d.path !== expected.path || !matches(d.actions) || d.chainId !== 1
      || d.ownerAddress?.toLowerCase() !== expected.ownerDid.split(':').at(-1)?.toLowerCase()
      || d.publicDelegation || (d.resources && (d.resources.length !== 1 || d.resources.some(r =>
        r.service !== 'kv' || r.space !== expected.space || r.path !== expected.path || !matches(r.actions))))
      || (d.host && d.host !== expected.host)
      || !d.expiry || !(d.expiry.getTime() > now && d.expiry.getTime() <= now + expected.maxMs + 1000)) reject();
  const signed = parseUcanGrant(d.delegationHeader.Authorization);
  const scopes = Object.entries(signed.att);
  const resource = expected.space + '/kv/' + expected.path;
  if (signed.cid !== d.cid || signed.audience.toLowerCase() !== expected.delegateDid.toLowerCase()
      || signed.expiresAt !== Math.floor(d.expiry!.getTime() / 1000)
      || (signed.notBefore !== null && signed.notBefore > now / 1000)
      || scopes.length !== 1 || ![resource, 'tinycloud://' + resource].includes(scopes[0][0]) || !matches(Object.keys(scopes[0][1]))) reject();
  return d.expiry!.getTime();
}
