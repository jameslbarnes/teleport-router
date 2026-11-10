import { TinyCloudWeb, serializeDelegation, deserializeDelegation } from '@tinycloud/web-sdk';
import { Wallet, getBytes } from 'ethers';
import { confirmOwnerRecovery, recoverAuthorKey } from './recovery.mjs';

export function localProvider(privateKey) {
  const wallet = new Wallet(privateKey);
  return { on() {}, removeListener() {}, async request({ method, params = [] }) {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [wallet.address];
    if (method === 'personal_sign') {
      if (String(params[1]).toLowerCase() !== wallet.address.toLowerCase()) throw Error('Different storage account requested.');
      return wallet.signMessage(getBytes(params[0]));
    }
    throw Error('Unsupported storage account request: ' + method);
  } };
}
export async function connectStorage({ privateKey, routerKey, request, onProgress, receipt, saveReceipt }) {
  const router = await request('/api/tinycloud/router');
  if (router.mode !== 'authors' || router.folder !== 'router/' || router.ownerRecovery !== 'secp256k1-v1'
      || router.recordEncryption !== 'aes-256-gcm-v2' || !router.recoveryConfirmationRequired) throw Error('This Router does not support the required storage and recovery setup.');
  // Router may only ask for these four operations on its own folder, whatever the server says.
  const allowed = ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'];
  if (!Array.isArray(router.actions) || !router.actions.length || router.actions.some(action => !allowed.includes(action))) throw Error('This Router asked for storage permissions this setup does not grant.');
  const url = new URL(router.host);
  if (url.protocol !== 'https:') throw Error('Storage must use HTTPS.');
  const owner = new TinyCloudWeb({ provider: localProvider(privateKey), tinycloudHosts: [router.host],
    spacePrefix: 'router', autoCreateSpace: true, autoDiscoverLocalNode: false, persistSession: false,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, ui: false,
    sessionExpirationMs: 366 * 86400000 });
  const wallet = new Wallet(privateKey);
  const post = (path, body = {}) => request(path, { secret_key: routerKey, ...body });
  try {
    onProgress('Opening your storage…');
    await owner.signIn();
    let grant;
    if (receipt && receipt.ownerDid.toLowerCase() === owner.did.toLowerCase() && receipt.routerDid.toLowerCase() === router.did.toLowerCase()) {
      const prior = deserializeDelegation(receipt.delegation);
      if (prior.expiry.getTime() > Date.now() + 86400000) grant = prior;
    }
    if (!grant) {
      grant = await owner.createDelegation({ delegateDID: router.did, path: router.folder, actions: router.actions, expiryMs: 365 * 86400000 });
      // Retain the same grant across interrupted attempts. This is scoped to the Router, never an owner key.
      saveReceipt({ ownerDid: owner.did, routerDid: router.did, delegation: serializeDelegation(grant), cid: grant.cid });
    }
    const delegation = serializeDelegation(grant);
    onProgress('Checking that your recovery key can open your notes…');
    const challenge = await post('/api/tinycloud/challenge', { delegation });
    const signature = await wallet.signMessage(challenge.message);
    const prepared = await post('/api/tinycloud/recovery', { delegation, signature });
    if (prepared.message !== challenge.message || prepared.context.space !== grant.spaceId || prepared.context.prefix !== grant.path
        || prepared.context.ownerDid.toLowerCase() !== owner.did.toLowerCase()) throw Error('Storage recovery did not match this account.');
    const recovery_proof = await confirmOwnerRecovery(privateKey, prepared);
    await post('/api/tinycloud/link', { delegation, signature, recovery_proof });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const status = await post('/api/tinycloud/status');
      if (status.job?.status === 'failed') throw Error('Storage setup did not finish. Your recovery file is still valid; retry this step.');
      if (status.job?.status === 'complete') {
        if (!status.linked || !status.available || status.encryption?.version !== 2) throw Error('Encrypted storage is not ready. Retry the connection.');
        const check = await owner.kv.get('router/recovery-v1', { source: 'network' });
        if (!check.ok) throw Error('Could not read back your recovery record. Retry the connection.');
        const raw = typeof check.data.data === 'string' ? check.data.data : JSON.stringify(check.data.data);
        (await recoverAuthorKey(privateKey, raw, prepared.context)).fill(0);
        return status;
      }
      if (!status.job) throw Error('Router restarted during setup. Retry with the same recovery file.');
      onProgress('Connecting your encrypted notes. You can leave this page and return to check progress.');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw Error('Storage is still being connected. Return to setup to check progress before retrying.');
  } finally { owner.cleanup(); }
}
