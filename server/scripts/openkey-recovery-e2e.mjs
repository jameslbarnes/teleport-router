// Run from server/ after npm run build. Uses throwaway accounts and hosted TinyCloud storage.
// This checks Router's recovery calls. The OpenKey passkey prompt is a separate browser check.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { TinyCloudNode } from '@tinycloud/node-sdk';
import { networkRecovery } from '../dist/openkey-recovery.js';
import { keyManifest, openNetworkRecovery, prepareNetworkRecovery, recoveryKeyPath } from '../../browser/src/openkey.mjs';

const origin = 'https://router.example.test';
const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
const privateKey = '0x' + randomBytes(32).toString('hex');
const manifest = keyManifest(origin);

function recoverySession(renewal = false) {
  return new TinyCloudNode({
    privateKey, host, domain: new URL(origin).hostname, uri: origin, prefix: 'router',
    enablePublicSpace: false, autoCreateSpace: !renewal, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, sessionExpirationMs: 2 * 86400000,
    manifest: {
      ...manifest, defaults: false, prefix: '', space: 'router', includePublicSpace: false, expiry: '2d',
      keys: [{ path: recoveryKeyPath(origin), abilities: renewal ? ['decrypt'] : ['key.create', 'decrypt'] }],
      permissions: [{ service: 'tinycloud.kv', space: 'router', path: renewal ? 'router/recovery-v1' : 'router/',
        actions: renewal ? ['get'] : ['get', 'put', 'list', 'del'] }],
    },
  });
}

// OpenKey provisions a new account's network. Model its timing with a separate owner session.
async function finishAccountSetup() {
  const owner = new TinyCloudNode({ privateKey, host, prefix: 'router', autoCreateSpace: true,
    enablePublicSpace: false, autoBootstrapAccount: false });
  try {
    await owner.signIn();
    await owner.ensureEncryptionNetwork();
  } finally {
    await owner.signOut();
  }
}

const initial = recoverySession();
const renewal = recoverySession(true);
let accountSetup;
try {
  await initial.signIn();
  const created = await prepareNetworkRecovery(initial, origin, undefined, () => {
    // Collect an error here so a failed background setup is reported even if recovery also fails.
    accountSetup ??= finishAccountSetup().then(() => null, error => error);
  });
  assert.ok(accountSetup, 'Router should wait for this new account to finish setup');
  assert.deepEqual(networkRecovery(created.network, initial.did, origin), created.network);
  const reopened = await prepareNetworkRecovery(initial, origin);
  assert.deepEqual(reopened.network, created.network);
  assert.ok(reopened.privateKey === created.privateKey, 'Reopening setup must recover the original key');
  console.log('PASS Router waited for first-time account setup and reused the same encrypted recovery record');

  await initial.signOut();
  await renewal.signIn();
  const recovered = await openNetworkRecovery(renewal, created.network, origin);
  assert.ok(recovered === created.privateKey, 'A fresh session with the named decrypt permission must recover the original key');
  console.log('PASS a fresh session reopened the record with decrypt permission for the named key');
} finally {
  await Promise.allSettled([initial.signOut(), renewal.signOut()]);
  const setupError = await accountSetup;
  if (setupError) throw setupError;
}
