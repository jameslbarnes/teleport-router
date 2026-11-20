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
export async function readRecovery(owner) {
  const r = await owner.kv.get('router/recovery-v1', { source: 'network' });
  if (!r.ok) {
    if (/not.?found|404/i.test(`${r.error?.code} ${r.error?.message} ${r.error?.status} ${r.error?.statusCode}`)) return null;
    throw Error('Could not read the recovery record in your TinyCloud space.');
  }
  const value = r.data.data;
  return typeof value === 'string' ? JSON.parse(value) : value;
}
async function checkChallenge(message, signerDid, grant, network, migrateFrom, newDid) {
  const hash = async data => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))),
    v => v.toString(16).padStart(2, '0')).join('');
  const canonical = value => JSON.stringify(value, (_, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v).sort(([a],[b]) => a.localeCompare(b))) : v);
  const resources = ['- urn:router:grant:' + await hash(grant), '- urn:router:recovery:' + await hash(canonical(network || 'self-held'))];
  if (migrateFrom) resources.push('- urn:router:migrate-from:' + migrateFrom.did, '- urn:router:migrate-to:' + newDid);
  const lines = String(message).split('\n');
  if (lines[0] !== location.host + ' wants you to sign in with your Ethereum account:' || lines[1]?.toLowerCase() !== signerDid.split(':').at(-1).toLowerCase()
      || lines[5] !== 'URI: ' + location.origin || lines[6] !== 'Version: 1' || lines[7] !== 'Chain ID: 1' || !/^Nonce: [a-f0-9]{32}$/.test(lines[8])
      || !/^Issued At: /.test(lines[9]) || !/^Expiration Time: /.test(lines[10]) || !(Date.parse(lines[10].slice(17)) > Date.now())
      || lines[11] !== 'Resources:' || JSON.stringify(lines.slice(12)) !== JSON.stringify(resources))
    throw Error('The sign-in request does not match this site, owner and storage grant.');
}
export async function connectStorage({ privateKey, routerKey, request, onProgress, receipt, saveReceipt, useOpenKey = false, expectedDid, migrateFrom }) {
  const router = await request('/api/tinycloud/router');
  if (router.mode !== 'authors' || router.folder !== 'router/' || router.ownerRecovery !== 'secp256k1-v1'
      || router.recordEncryption !== 'aes-256-gcm-v2' || !router.recoveryConfirmationRequired) throw Error('This Router does not support the required storage and recovery setup.');
  // Router may only ask for these four operations on its own folder, whatever the server says.
  const allowed = ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'];
  if (!Array.isArray(router.actions) || !router.actions.length || router.actions.some(action => !allowed.includes(action))) throw Error('This Router asked for storage permissions this setup does not grant.');
  const url = new URL(router.host);
  if (url.protocol !== 'https:') throw Error('Storage must use HTTPS.');
  const open = useOpenKey ? await import('./openkey.mjs') : undefined;
  const selected = open ? await open.openKeyOwner(router.host, { expectedDid }) : undefined;
  const owner = selected?.owner || new TinyCloudWeb({ provider: localProvider(privateKey), tinycloudHosts: [router.host],
    spacePrefix: 'router', autoCreateSpace: true, autoDiscoverLocalNode: false, persistSession: false,
    autoBootstrapAccount: false, includeAccountRegistryPermissions: false, ui: false,
    sessionExpirationMs: 366 * 86400000 });
  const sign = selected?.sign || (message => new Wallet(privateKey).signMessage(message));
  const post = (path, body = {}) => request(path, { secret_key: routerKey, ...body });
  try {
    onProgress('Opening your storage…');
    await owner.signIn();
    let network;
    if (open) {
      const existing = await readRecovery(owner);
      if (existing && !existing.networkRecovery) throw Error('This space already uses a self-held recovery key. Choose its original setup.');
      const prepared = await open.prepareNetworkRecovery(owner, location.origin, existing?.networkRecovery, onProgress);
      network = prepared.network;
      privateKey = prepared.privateKey;
    }
    let grant;
    if (receipt && receipt.ownerDid.toLowerCase() === owner.did.toLowerCase() && receipt.routerDid.toLowerCase() === router.did.toLowerCase()) {
      const prior = deserializeDelegation(receipt.delegation);
      if (prior.expiry.getTime() > Date.now() + 86400000) grant = prior;
    }
    if (!grant) {
      grant = await owner.createDelegation({ delegateDID: router.did, path: router.folder, actions: router.actions, includePublicSpace: false, expiryMs: 365 * 86400000 });
      // Retain the same grant across interrupted attempts. This is scoped to the Router, never an owner key.
      saveReceipt({ ownerDid: owner.did, routerDid: router.did, delegation: serializeDelegation(grant), cid: grant.cid });
    }
    const delegation = serializeDelegation(grant);
    onProgress('Checking that your recovery key can open your notes…');
    const link = { delegation, ...(network ? { network_recovery: network } : {}), ...(migrateFrom ? { migrate_from: migrateFrom.did } : {}) };
    if (migrateFrom) {
      const { prepareTraceMove } = await import('./trace-keys.mjs');
      onProgress('Checking the keys for your existing traces on this device…');
      await prepareTraceMove(post, owner, migrateFrom, privateKey);
    }
    const challenge = await post('/api/tinycloud/challenge', link);
    await checkChallenge(challenge.message, owner.did, delegation, network, migrateFrom, owner.did);
    if (migrateFrom) await checkChallenge(challenge.previous_message, migrateFrom.did, delegation, network, migrateFrom, owner.did);
    const signature = await sign(challenge.message);
    const previous_signature = migrateFrom ? await migrateFrom.sign(challenge.previous_message) : undefined;
    const proof = { ...link, signature, ...(previous_signature ? { previous_signature } : {}) };
    const prepared = await post('/api/tinycloud/recovery', proof);
    if (prepared.message !== challenge.message || prepared.context.space !== grant.spaceId || prepared.context.prefix !== grant.path
        || prepared.context.ownerDid.toLowerCase() !== owner.did.toLowerCase()) throw Error('Storage recovery did not match this account.');
    const recovery_proof = await confirmOwnerRecovery(privateKey, prepared);
    await post('/api/tinycloud/link', { ...proof, recovery_proof });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const status = await post('/api/tinycloud/status');
      if (status.job?.status === 'failed') throw Error(status.job.error || 'Storage setup did not finish. Your current storage is still linked.');
      if (status.job?.status === 'complete') {
        if (!status.linked || !status.available || status.encryption?.version !== 2) throw Error('Encrypted storage is not ready. Retry the connection.');
        const check = await owner.kv.get('router/recovery-v1', { source: 'network' });
        if (!check.ok) throw Error('Could not read back your recovery record. Retry the connection.');
        const raw = typeof check.data.data === 'string' ? check.data.data : JSON.stringify(check.data.data);
        (await recoverAuthorKey(privateKey, raw, prepared.context)).fill(0);
        return { ...status, tracePublicKey: network?.publicKey };
      }
      if (!status.job) throw Error('Router restarted during setup. Retry with the same recovery file.');
      onProgress('Connecting your encrypted notes. You can leave this page and return to check progress.');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    throw Error('Storage is still being connected. Return to setup to check progress before retrying.');
  } finally { owner.cleanup(); }
}
