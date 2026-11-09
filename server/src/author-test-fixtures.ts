// Synthetic wallets and a versioned in-memory store for author/Discord tests.
import {createHash,createHmac} from 'node:crypto';
import {Wallet} from 'ethers';
import {GroupStoreConflictError,type GroupStore} from './group-store.js';
import {canonical,type RecordKind,type RecordValue} from './author-records.js';
export const testWallet = (name: string) => new Wallet('0x'+createHash('sha256').update('Router synthetic fixture: '+name).digest('hex'));
export function versionedMemoryStore(map: Map<string,string>, check = () => {}): GroupStore {
  const etag = (raw: string) => '"'+createHash('sha256').update(raw).digest('hex')+'"';
  return {
    async get(k){check();return map.get(k)??null;},
    async getVersioned(k){check();const value=map.get(k);return value===undefined?null:{value,etag:etag(value)};},
    async put(k,v,condition){check();const old=map.get(k);
      if((condition?.ifNoneMatch==='*'&&old!==undefined)||(condition?.ifMatch&&(old===undefined||etag(old)!==condition.ifMatch)))throw new GroupStoreConflictError();
      map.set(k,v);},
    async list(p){check();return [...map.keys()].filter(k=>k.startsWith(p));},
    async delete(k){check();map.delete(k);},
  };
}
export function legacyRecord(key: Uint8Array, owner: string, kind: RecordKind, value: RecordValue) {
  const mac=createHmac('sha256',key).update(`router-record-v1\0${owner}\0${kind}\0${canonical(value)}`).digest('hex');
  return canonical({version:1,value,mac});
}
