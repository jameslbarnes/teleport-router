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

/** A synthetic trace in the shape the capture client uploads: what the person typed, what the agent wrote,
 * tool calls and what they returned. `steps` items are [kind, text]; kinds: person, agent, call (text is the
 * command), result, failed. Times are one minute apart. */
export function syntheticTrace(steps: [kind: 'person' | 'agent' | 'call' | 'result' | 'failed', text: string][]): string {
  const start = Date.parse('2026-11-01T09:00:00Z');
  return JSON.stringify({ v: 1, kind: 'router-post-trace', entry_id: 'synthetic', agent: 'claude-code', records: steps.map(([kind, text], i) => {
    const timestamp = new Date(start + i * 60_000).toISOString();
    if (kind === 'person') return { type: 'user', timestamp, message: { role: 'user', content: text } };
    if (kind === 'agent') return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'text', text }] } };
    if (kind === 'call') return { type: 'assistant', timestamp, message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: text } }] } };
    return { type: 'user', timestamp, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i - 1}`, content: text, ...(kind === 'failed' ? { is_error: true } : {}) }] } };
  }) });
}
