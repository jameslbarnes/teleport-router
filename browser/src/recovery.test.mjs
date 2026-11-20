import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { gzipSync } from 'node:zlib';
import { sealPart } from '../../server/dist/trace-envelope.js';
import { openGrantedTrace } from '../../server/scripts/trace-reader.mjs';
import { rewrapTraceKey } from './trace-keys.mjs';
import { recordCodec, ownerRecoveryProof } from '../server-records-fixture.mjs';
import { confirmOwnerRecovery, recoverAuthorKey, encryptBackup, decryptBackup } from './recovery.mjs';

test('the reader CLI opens chunked ciphertext with the key wrapped by the approval page', async () => {
  const owner = Wallet.createRandom(), reader = Wallet.createRandom(), ownerDid = 'did:pkh:eip155:1:' + owner.address, entryId = 'demo';
  const privateTrace = Buffer.from('{"records":["synthetic private session"]}');
  const sealed = sealPart(gzipSync(privateTrace), {ownerDid,entryId}, 'full', {owner:owner.signingKey.compressedPublicKey});
  const wrap = await rewrapTraceKey(sealed.meta,ownerDid,entryId,owner.privateKey,reader.signingKey.compressedPublicKey);
  const text = sealed.ciphertext.toString('base64');
  const data = {meta:JSON.stringify({v:1,ownerDid,entryId,upload:'slot',full:{...sealed.meta,chunks:2}}),
    'slot/full-000':text.slice(0,12),'slot/full-001':text.slice(12)};
  const access = {kv:{get:async path=>({ok:path in data,data:{data:data[path]}})}};
  assert.deepEqual(await openGrantedTrace(access,{ownerDid,wrap},entryId,reader.privateKey),privateTrace);
  await assert.rejects(openGrantedTrace(access,{ownerDid,wrap},entryId,owner.privateKey));
  delete data['slot/full-001'];
  await assert.rejects(openGrantedTrace(access,{ownerDid,wrap},entryId,reader.privateKey));
});

test('the OpenKey signer and the key recovered from the encryption network have independent roles', async () => {
  const signer = Wallet.createRandom(), recovery = Wallet.createRandom();
  const codec = recordCodec(randomBytes(32),randomBytes(32));
  const ownerDid = 'did:pkh:eip155:1:' + signer.address;
  const ctx = {ownerDid, space:ownerDid.replace('did:', 'tinycloud:') + ':router', prefix:'router/',
    networkRecovery:{publicKey:recovery.signingKey.compressedPublicKey,envelope:{v:2,networkId:'urn:tinycloud:encryption:'+ownerDid+':default',keyPath:'apps/test.router/recovery'}}};
  const wire = codec.createRecovery(ctx, signer.signingKey.compressedPublicKey);
  const proof = await confirmOwnerRecovery(recovery.privateKey,{context:ctx,recovery:wire,message:'this link'});
  codec.verifyOwnerRecovery(proof,ctx,'this link',wire);
  assert.throws(()=>codec.verifyOwnerRecovery(proof,ctx,'other link',wire));
  await assert.rejects(recoverAuthorKey(signer.privateKey,wire,ctx));
  assert.throws(()=>codec.verifyRecovery(wire,{...ctx,networkRecovery:undefined},signer.signingKey.compressedPublicKey));
});

test('browser recovery opens the actual server envelope and returns the identical proof', async () => {
  const owner = Wallet.createRandom(), codec = recordCodec(randomBytes(32), randomBytes(32));
  const context = { ownerDid: 'did:pkh:eip155:1:' + owner.address, space: 'tinycloud:pkh:eip155:1:' + owner.address + ':router', prefix: 'router/' };
  const recovery = codec.createRecovery(context, owner.signingKey.compressedPublicKey), message = 'Synthetic owner proof';
  const key = await recoverAuthorKey(owner.privateKey, recovery, context);
  const proof = await confirmOwnerRecovery(owner.privateKey, { context, recovery, message });
  assert.equal(proof, ownerRecoveryProof(key, context, message, recovery));
  codec.verifyOwnerRecovery(proof, context, message, recovery);
  await assert.rejects(recoverAuthorKey(Wallet.createRandom().privateKey, recovery, context));
  await assert.rejects(recoverAuthorKey(owner.privateKey, recovery, { ...context, space: context.space + 'other' }));
  const altered = JSON.parse(recovery); altered.ciphertext = (altered.ciphertext[0] === 'a' ? 'b' : 'a') + altered.ciphertext.slice(1);
  await assert.rejects(recoverAuthorKey(owner.privateKey, JSON.stringify(altered), context));
  key.fill(0);
});

test('recovery file round trip preserves both identities; wrong passwords and tampering fail', async () => {
  const data = { format: 'router-account', version: 1, handle: 'synthetic', origin: 'https://router.example', routerKey: randomBytes(32).toString('base64url'), tinycloudKey: Wallet.createRandom().privateKey };
  const encrypted = await encryptBackup(data, 'synthetic recovery password');
  assert(!JSON.stringify(encrypted).includes(data.routerKey));
  assert(!JSON.stringify(encrypted).includes(data.tinycloudKey));
  assert.deepEqual(await decryptBackup(encrypted, 'synthetic recovery password'), data);
  await assert.rejects(decryptBackup(encrypted, 'different recovery password'));
  await assert.rejects(decryptBackup({ ...encrypted, iterations: 1 }, 'synthetic recovery password'));
  await assert.rejects(decryptBackup({ ...encrypted, ciphertext: encrypted.ciphertext.slice(1) }, 'synthetic recovery password'));
});
