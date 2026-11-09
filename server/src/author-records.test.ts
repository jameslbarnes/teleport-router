import {describe,it,expect} from 'vitest';
import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {canonical,recordCodec,recoverAuthorKey,decryptOwnerRecord,ownerRecoveryProof,type RecordKind} from './author-records.js';
import {testWallet,legacyRecord} from './author-test-fixtures.js';
import type {JournalEntry} from './storage.js';

const wallet=testWallet('owner');
const b={ownerDid:`did:pkh:eip155:1:${wallet.address}`,space:'space:owner',prefix:'router/'};
const integrity=Buffer.alloc(32,11), root=Buffer.alloc(32,12), codec=recordCodec(integrity,root);
const value:JournalEntry={id:'record-1',pseudonym:'owner#123',handle:'owner',content:'Private research: violet otters',timestamp:1234,client:'code',to:['#aria']};

describe('Encrypted author records and independent owner recovery',()=>{
  it.each(['posts','conversations','summaries'] as RecordKind[])('encrypts all %s content and metadata with fresh nonces',kind=>{
    const first=codec.encode(b,kind,value),second=codec.encode(b,kind,value);
    expect(first).not.toEqual(second);
    for(const word of ['Private research: violet otters','owner#123','#aria','"content"','"value"','"pseudonym"'])expect(first).not.toContain(word);
    expect(Object.keys(JSON.parse(first)).sort()).toEqual(['ciphertext','nonce','tag','version']);
    expect(codec.decode(first,b,kind,value.id)).toEqual(value);
  });
  it('binds owner, space, prefix, kind, record ID, root key and Router integrity key',()=>{
    const raw=codec.encode(b,'posts',value);
    for(const wrong of [{...b,ownerDid:`did:pkh:eip155:1:${testWallet('other').address}`},{...b,space:'other'},{...b,prefix:'other/'}])
      expect(()=>codec.decode(raw,wrong,'posts',value.id)).toThrow();
    expect(()=>codec.decode(raw,b,'summaries',value.id)).toThrow();
    expect(()=>codec.decode(raw,b,'posts','record-2')).toThrow();
    expect(()=>recordCodec(integrity,Buffer.alloc(32,13)).decode(raw,b,'posts',value.id)).toThrow();
    expect(()=>recordCodec(Buffer.alloc(32,13),root).decode(raw,b,'posts',value.id)).toThrow('integrity');
  });
  it.each(['nonce','ciphertext','tag'])('rejects modified %s and invalid encodings',field=>{
    const envelope=JSON.parse(codec.encode(b,'posts',value));
    const bytes=Buffer.from(envelope[field],'base64url');bytes[0]^=1;envelope[field]=bytes.toString('base64url');
    expect(()=>codec.decode(JSON.stringify(envelope),b,'posts',value.id)).toThrow();
    envelope[field]='!invalid';expect(()=>codec.decode(JSON.stringify(envelope),b,'posts',value.id)).toThrow();
  });
  it('accepts authentic v1 only when explicitly migrating, and refuses modified v1',()=>{
    const old=legacyRecord(integrity,b.ownerDid,'posts',value);
    expect(()=>codec.decode(old,b,'posts',value.id)).toThrow();
    expect(codec.decode(old,b,'posts',value.id,1)).toEqual(value);
    expect(()=>codec.decode(old.replace('violet','orange'),b,'posts',value.id,1)).toThrow('integrity');
  });
  it('recovers using only the owner key, recovery blob and ciphertext; rejects the wrong owner or context',()=>{
    const recovery=codec.createRecovery(b,wallet.signingKey.publicKey),raw=codec.encode(b,'posts',value);
    codec.verifyRecovery(recovery,b,wallet.signingKey.publicKey);
    const key=recoverAuthorKey(wallet.privateKey,recovery,b);
    expect(decryptOwnerRecord(key,raw,b,'posts',value.id)).toEqual(value);
    expect(()=>recoverAuthorKey(testWallet('other').privateKey,recovery,b)).toThrow();
    expect(()=>recoverAuthorKey(wallet.privateKey,recovery,{...b,prefix:'other/'})).toThrow();
    expect(()=>codec.createRecovery(b,testWallet('other').signingKey.publicKey)).toThrow('owner');
    expect(()=>recordCodec(integrity,Buffer.alloc(32,15)).verifyRecovery(recovery,b,wallet.signingKey.publicKey)).toThrow();
    const modified=JSON.parse(recovery);modified.tag=randomBytes(16).toString('base64url');
    expect(()=>recoverAuthorKey(wallet.privateKey,JSON.stringify(modified),b)).toThrow();
    expect(()=>codec.verifyRecovery(JSON.stringify(modified),b,wallet.signingKey.publicKey)).toThrow();
  });
  it('does not let an owner forge Router authorization using their recovery key',()=>{
    const key=recoverAuthorKey(wallet.privateKey,codec.createRecovery(b,wallet.signingKey.publicKey),b);
    const wire=JSON.parse(codec.encode(b,'posts',value));
    const aad=Buffer.from(JSON.stringify(['teleport-router/record/v2',b.ownerDid.toLowerCase(),b.space,b.prefix,'posts',value.id]));
    const decrypt=createDecipheriv('aes-256-gcm',key,Buffer.from(wire.nonce,'base64url'));
    decrypt.setAAD(aad);decrypt.setAuthTag(Buffer.from(wire.tag,'base64url'));
    const signed=JSON.parse(Buffer.concat([decrypt.update(Buffer.from(wire.ciphertext,'base64url')),decrypt.final()]).toString());
    signed.value.to=['#group-the-owner-cannot-join'];
    const nonce=randomBytes(12),encrypt=createCipheriv('aes-256-gcm',key,nonce);encrypt.setAAD(aad);
    const ciphertext=Buffer.concat([encrypt.update(canonical(signed)),encrypt.final()]);
    const forged=JSON.stringify({version:2,nonce:nonce.toString('base64url'),ciphertext:ciphertext.toString('base64url'),tag:encrypt.getAuthTag().toString('base64url')});
    expect(()=>codec.decode(forged,b,'posts',value.id)).toThrow('integrity');
  });
  it('requires proof of decryption bound to this challenge, context and exact recovery envelope',()=>{
    const recovery=codec.createRecovery(b,wallet.signingKey.publicKey),challenge='one-time signed link request';
    const key=recoverAuthorKey(wallet.privateKey,recovery,b),proof=ownerRecoveryProof(key,b,challenge,recovery);
    codec.verifyOwnerRecovery(proof,b,challenge,recovery);
    expect(()=>codec.verifyOwnerRecovery(undefined,b,challenge,recovery)).toThrow();
    expect(()=>codec.verifyOwnerRecovery('a'.repeat(64),b,challenge,recovery)).toThrow();
    expect(()=>codec.verifyOwnerRecovery(proof,b,'a later signed request',recovery)).toThrow();
    expect(()=>codec.verifyOwnerRecovery(proof,{...b,prefix:'other/'},challenge,recovery)).toThrow();
    expect(()=>codec.verifyOwnerRecovery(proof,b,challenge,codec.createRecovery(b,wallet.signingKey.publicKey))).toThrow();
  });
});
