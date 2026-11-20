// Run from server/ after npm run build. Uses throwaway accounts and hosted TinyCloud storage.
// This checks Router's recovery calls. The OpenKey passkey prompt is a separate browser check.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
import { Wallet } from 'ethers';
import { signedFolderGrant } from '../dist/tinycloud-grant-scope.js';
import { tinyCloudGroups } from '../dist/tinycloud-group-store.js';
import { networkRecovery } from '../dist/openkey-recovery.js';
import { grantRouterStorage, keyManifest, networkCreationManifest, openNetworkRecovery, prepareNetworkRecovery, recoveryKeyPath } from '../../browser/src/openkey.mjs';

const origin = 'https://router.example.test';
const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
const privateKey = '0x' + randomBytes(32).toString('hex');
const manifest = keyManifest(origin);

function recoverySession(renewal = false) {
  return new TinyCloudNode({
    privateKey, host, domain: new URL(origin).hostname, uri: origin, prefix: 'router',
    enablePublicSpace: false, autoCreateSpace: !renewal, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, sessionExpirationMs: (renewal ? 2 : 366) * 86400000,
    manifest: {
      ...manifest, defaults: false, prefix: '', space: 'router', includePublicSpace: false, expiry: renewal ? '2d' : '366d',
      keys: [{ path: recoveryKeyPath(origin), abilities: renewal ? ['decrypt'] : ['key.create', 'decrypt'] }],
      permissions: [{ service: 'tinycloud.kv', space: 'router', path: renewal ? 'router/recovery-v1' : 'router/',
        actions: renewal ? ['get'] : ['get', 'put', 'list', 'del'] }],
    },
  });
}

// Use exactly the account-setup permission the browser requests from OpenKey.
async function finishAccountSetup(ownerDid) {
  const owner = new TinyCloudNode({
    privateKey, host, prefix: 'router', domain: new URL(origin).hostname, uri: origin,
    manifest: networkCreationManifest(origin, ownerDid), autoCreateSpace: false,
    enablePublicSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false,
    sessionExpirationMs: 10 * 60000,
  });
  try {
    await owner.signIn();
    await owner.ensureEncryptionNetwork();
  } finally {
    await owner.signOut();
  }
}

const initial = recoverySession();
const renewal = recoverySession(true);
let setupCalls = 0;
try {
  await initial.signIn();
  const setup = { initializeNetwork: async () => { setupCalls++; await finishAccountSetup(initial.did); } };
  const created = await prepareNetworkRecovery(initial, origin, undefined, setup);
  assert.equal(setupCalls, 1, 'A fresh account needs explicit network creation');
  assert.deepEqual(networkRecovery(created.network, initial.did, origin), created.network);
  const reopened = await prepareNetworkRecovery(initial, origin, undefined, setup);
  assert.equal(setupCalls, 1, 'Reopening storage must not ask for network creation again');
  assert.deepEqual(reopened.network, created.network);
  assert.ok(reopened.privateKey === created.privateKey, 'Reopening setup must recover the original key');
  console.log('PASS Router created the missing network with a create-only approval and reused the same encrypted recovery record');

  const serviceWallet = Wallet.createRandom();
  const router = { did: 'did:pkh:eip155:1:' + serviceWallet.address, folder: 'router/',
    actions: ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'] };
  const grant = await grantRouterStorage(initial, router);
  const expiry = signedFolderGrant(serializeDelegation(grant), { space: initial.spaceId, ownerDid: initial.did,
    delegateDid: router.did, host, path: router.folder, actions: router.actions, maxMs: 365 * 86400000 }, Date.now());
  assert.ok(expiry > Date.now() + 364 * 86400000);
  const store = await tinyCloudGroups({ privateKey: serviceWallet.privateKey, host }).accessFor(serializeDelegation(grant));
  assert.ok((await store.list('')).includes('openkey-recovery'), 'The service can list the complete, exact folder it was granted');
  console.log('PASS Router accepts the signed one-year grant and lists its own folder');

  await initial.signOut();
  await renewal.signIn();
  const recovered = await openNetworkRecovery(renewal, created.network, origin);
  assert.ok(recovered === created.privateKey, 'A fresh session with the named decrypt permission must recover the original key');
  console.log('PASS a fresh session reopened the record with decrypt permission for the named key');
} finally {
  await Promise.allSettled([initial.signOut(), renewal.signOut()]);
}
