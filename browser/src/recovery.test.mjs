import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { recordCodec, ownerRecoveryProof } from '../server-records-fixture.mjs';
import { confirmOwnerRecovery, recoverAuthorKey, encryptBackup, decryptBackup } from './recovery.mjs';

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
