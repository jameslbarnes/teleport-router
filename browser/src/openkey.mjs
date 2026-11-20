import { OpenKey, OpenKeyProvider } from '@openkey/sdk';
import { TinyCloudWeb } from '@tinycloud/web-sdk';
import { Wallet, getBytes, hexlify } from 'ethers';

const DAY = 86400000;
export const appId = origin => new URL(origin).hostname.split('.').reverse().join('.');
export const recoveryKeyPath = origin => 'apps/' + appId(origin) + '/recovery';
export function keyManifest(origin) {
  return { name: 'Router', app_id: appId(origin), keys: [{ path: recoveryKeyPath(origin), abilities: ['key.create', 'decrypt'] }] };
}
export function networkCreationManifest(origin, ownerDid) {
  return {
    name: 'Router', app_id: appId(origin), defaults: false, prefix: '', space: 'router',
    includePublicSpace: false, expiry: '10m',
    permissions: [
      // OpenKey's signed session must identify the Router space. Reading its permission list grants no access to records.
      { service: 'tinycloud.capabilities', space: 'router', path: '', actions: ['tinycloud.capabilities/read'] },
      { service: 'tinycloud.encryption', path: 'urn:tinycloud:encryption:' + ownerDid + ':default', actions: ['network.create'] },
    ],
  };
}
const sorted = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v);
const digest = async value => hexlify(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sorted(value))))).slice(2);

/** OpenKey handles signing. Only the browser's recovery session gets the named decrypt permission. */
export async function openKeyOwner(host, { traceSession, expectedDid } = {}) {
  const origin = location.origin;
  const manifest = keyManifest(origin);
  const openkey = new OpenKey({ appName: 'Router', mode: 'iframe' });
  const account = await openkey.connect();
  const did = 'did:pkh:eip155:1:' + account.address;
  if (expectedDid && expectedDid.toLowerCase() !== did.toLowerCase()) throw Error('Choose the OpenKey account that owns this storage.');
  const manifestDigest = await digest(manifest);
  const space = traceSession?.spacePrefix || 'router';
  const traceScope = traceSession?.manifest.permissions[0];
  const permissions = traceScope ? [{ ...traceScope, path: 'router/recovery-v1' }, traceScope]
    : [{ service: 'tinycloud.kv', space, path: 'router/', actions: ['get', 'put', 'list', 'del'] }];
  const options = {
    openkey: { mode: 'iframe', client: {
      authorizeTinyCloud: (input, options) => openkey.authorizeTinyCloud({ ...input, keyId: account.keyId,
        presentation: { ...input.presentation, displayName: 'Router', manifestDigest } }, options),
    } },
    tinycloudHosts: [host], spacePrefix: space, autoDiscoverLocalNode: false, autoBootstrapAccount: false,
    includeAccountRegistryPermissions: false, persistSession: false, ui: false,
  };
  const owner = new TinyCloudWeb({
    ...options, provider: new OpenKeyProvider(openkey, account),
    manifest: { ...manifest, keys: [{ path: recoveryKeyPath(origin), abilities: traceSession ? ['decrypt'] : ['key.create', 'decrypt'] }],
      defaults: false, prefix: '', space, includePublicSpace: false, expiry: traceSession ? '2d' : '366d', permissions },
    autoCreateSpace: !traceSession, sessionExpirationMs: (traceSession ? 2 : 366) * DAY,
  });
  // Account setup is a separate short-lived approval. It cannot decrypt data and is never delegated to Router.
  async function initializeNetwork() {
    const setup = new TinyCloudWeb({
      ...options, provider: new OpenKeyProvider(openkey, account), manifest: networkCreationManifest(origin, did),
      autoCreateSpace: false, sessionExpirationMs: 10 * 60000,
    });
    try {
      await setup.signIn();
      if (setup.did.toLowerCase() !== did.toLowerCase()) throw Error('Choose the same OpenKey account to set up encrypted storage.');
      await setup.ensureEncryptionNetwork();
    } finally { setup.cleanup(); }
  }
  return { owner, initializeNetwork, sign: async message => (await openkey.signMessage({ message, keyId: account.keyId })).signature };
}

export async function grantRouterStorage(owner, router) {
  if (!owner.spaceId) throw Error('Open your Router storage before approving access.');
  const permission = { service: 'tinycloud.kv', space: owner.spaceId, path: router.folder, actions: router.actions };
  const { delegation } = await owner.delegateTo(router.did, [permission], { expiry: 365 * DAY, requireActivation: true });
  return delegation;
}

export async function openNetworkRecovery(owner, network, origin) {
  const e = network?.envelope;
  if (e?.v !== 2 || e.networkId.toLowerCase() !== ('urn:tinycloud:encryption:' + owner.did + ':default').toLowerCase()
      || e.keyPath !== recoveryKeyPath(origin)) throw Error('The recovery record names a different TinyCloud key.');
  const bytes = await owner.keys.decrypt(e);
  try {
    const secret = hexlify(bytes);
    if (new Wallet(secret).signingKey.compressedPublicKey !== network.publicKey) throw Error('The recovery record opened to a different key.');
    return secret;
  } finally { bytes.fill(0); }
}
async function ensureRecoveryKey(owner, path, { onProgress, initializeNetwork }) {
  try { await owner.keys.ensureKey(path); }
  catch (error) {
    if (error?.code !== 'NETWORK_NOT_FOUND' || !initializeNetwork) throw error;
    if (!await owner.getEncryptionNetwork()) {
      onProgress?.('Approve creating encrypted storage for this OpenKey account.');
      await initializeNetwork();
    }
    await owner.keys.ensureKey(path);
  }
}

export async function prepareNetworkRecovery(owner, origin, existing, setup = {}) {
  let network = existing;
  const pendingKey = 'router/openkey-recovery';
  if (!network) {
    const pending = await owner.kv.get(pendingKey, { source: 'network' });
    if (pending.ok && pending.data.data) network = typeof pending.data.data === 'string' ? JSON.parse(pending.data.data) : pending.data.data;
    else if (!pending.ok && !/not.?found|404/i.test(pending.error?.code + ' ' + pending.error?.message)) throw Error('Could not read the OpenKey recovery record.');
  }
  if (!network) {
    const path = recoveryKeyPath(origin);
    await ensureRecoveryKey(owner, path, setup);
    const local = Wallet.createRandom();
    const secret = getBytes(local.privateKey);
    try {
      network = { publicKey: local.signingKey.compressedPublicKey, envelope: await owner.keys.encrypt(path, secret) };
    } finally { secret.fill(0); }
    // A retry or another device must use the same recovery key, including after an interrupted owner move.
    const saved = await owner.kv.put(pendingKey, JSON.stringify(network), { ifNoneMatch: '*' });
    if (!saved.ok) throw Error('Could not save the recovery record. Reopen setup to retry.');
  }
  // Deliberately decrypt the network envelope even on first link. Generating the key is not proof of recovery.
  return { network, privateKey: await openNetworkRecovery(owner, network, origin) };
}
