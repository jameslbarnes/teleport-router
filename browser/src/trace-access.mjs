import { grantTraceRead, traceReadSession } from './trace-permission.mjs';

const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('entry');
let key = localStorage.getItem('router_key'), storage, account, busy = false;
const status = text => { $('status').textContent = text; };
async function api(path, body) {
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), cache: 'no-store', redirect: 'error' });
  const result = await r.json();
  if (!r.ok) throw Error(result.error || 'Router could not complete the request.');
  return result;
}
const access = body => api('/api/trace-access', body);
async function act(fn) {
  if (busy) return;
  busy = true;
  try { await fn(); } catch (e) { status(e.message); } finally { busy = false; }
}
function element(tag, text, css) {
  const el = document.createElement(tag); el.textContent = text; if (css) el.className = css; return el;
}
function card(r) {
  const panel = element('article', '', 'r-perm');
  const link = element('a', 'Read the note'); link.href = '/e/' + encodeURIComponent(r.entry_id);
  panel.append(element('h2', r.requester + ' asks ' + r.owner + ' for a trace'), link,
    element('p', 'To do this, allow this agent to read the full session slice behind this note.'),
    element('p', 'Under these conditions, TinyCloud permits reads of this one trace for 24 hours. The reader can keep a copy.'),
    element('p', 'Reader key ' + r.reader_public_key));
  const yes = element('button', 'Allow', 'r-btn r-btn--primary'), no = element('button', 'Decline', 'r-btn');
  yes.onclick = () => act(async () => { await grant(r); panel.remove(); status('Access granted for 24 hours.'); });
  no.onclick = () => act(async () => { await access({ action: 'decline', request_id: r.request_id, revision: r.revision }); panel.remove(); status('Request declined.'); });
  panel.append(yes, no); return panel;
}
async function grant(r) {
  const { host } = await api('/api/tinycloud/router');
  let owner, privateKey;
  if (!storage?.linked) throw Error('Connect your TinyCloud storage from setup before approving.');
  const [{ TinyCloudWeb, serializeDelegation }, { localProvider, readRecovery }, { rewrapTraceKey }] = await Promise.all([
    import('@tinycloud/web-sdk'), import('./storage.mjs'), import('./trace-keys.mjs')]);
  const session = traceReadSession(storage.space, r.entry_id, location.origin);
  if (storage.recoveryMode === 'openkey') {
    const { openKeyOwner } = await import('./openkey.mjs');
    owner = (await openKeyOwner(host, { traceSession: session, expectedDid: storage.ownerDid })).owner;
  } else {
    const { unlockOldStorage } = await import('./unlock-backup.mjs');
    const saved = await unlockOldStorage(account.handle, key, $('backup').files[0], $('password').value);
    $('password').value = ''; privateKey = saved.tinycloudKey;
    owner = new TinyCloudWeb({ provider: localProvider(privateKey), tinycloudHosts: [host], ...session,
      autoCreateSpace: false, autoBootstrapAccount: false, includeAccountRegistryPermissions: false, autoDiscoverLocalNode: false,
      persistSession: false, ui: false, sessionExpirationMs: 2 * 86400000 });
  }
  try {
    await owner.signIn();
    if (owner.did.toLowerCase() !== storage.ownerDid.toLowerCase()) throw Error('This is a different storage owner.');
    if (!privateKey) {
      const { openNetworkRecovery } = await import('./openkey.mjs');
      privateKey = await openNetworkRecovery(owner, (await readRecovery(owner))?.networkRecovery, location.origin);
    }
    const folder = 'router/traces/' + r.entry_id + '/';
    const result = await owner.kv.get(folder + 'meta', { source: 'network' });
    if (!result.ok || !result.data.data) throw Error('No readable trace is stored for this note. Capture and upload its session slice before approving.');
    const meta = typeof result.data.data === 'string' ? JSON.parse(result.data.data) : result.data.data;
    if (meta.entryId !== r.entry_id || meta.ownerDid.toLowerCase() !== owner.did.toLowerCase()) throw Error('The stored trace belongs to a different note or owner.');
    const wrap = await rewrapTraceKey(meta.full, meta.sealedOwnerDid || meta.ownerDid, r.entry_id, privateKey, r.reader_public_key);
    const d = await grantTraceRead(owner, r.reader_did, session);
    await access({ action: 'approve', request_id: r.request_id, revision: r.revision, delegation: serializeDelegation(d), wrap });
  } finally { owner.cleanup(); }
}
async function show() {
  $('ask').hidden = true; $('credentials').hidden = true; $('requests').replaceChildren(); $('signin').hidden = !!key;
  if (id) {
    const note = await api('/api/entry/' + encodeURIComponent(id));
    $('heading').textContent = 'Private trace'; $('note').hidden = false; $('note-link').href = '/e/' + encodeURIComponent(id); $('inbox-link').hidden = false;
    if (!key) { status('Sign in to request this trace.'); return; }
    if (!note.canDelete) { $('ask').hidden = false; status('Only the owner can release this trace.'); return; }
  }
  if (!key) { status('Sign in to see requests for your traces.'); return; }
  const { requests } = await access({ action: 'inbox' });
  const list = requests.filter(r => !id || r.entry_id === id);
  if (!list.length) { status('No pending requests.'); return; }
  account = await api('/api/identity/lookup', { secret_key: key });
  storage = await api('/api/tinycloud/status', {secret_key: key}).catch(() => null);
  for (const r of list) $('requests').append(card(r));
  $('credentials').hidden = !storage?.linked || storage.recoveryMode === 'openkey';
  status('Review each request before giving access.');
}
$('signin').onsubmit = event => { event.preventDefault(); act(async () => { key = $('key').value.trim(); await api('/api/identity/lookup', { secret_key: key }); localStorage.setItem('router_key', key); $('key').value = ''; await show(); }); };
$('ask').onsubmit = event => { event.preventDefault(); act(async () => { const r = await access({ action: 'request', entry_id: id, reader_public_key: $('public-key').value.trim() });
  status('Request ' + r.request_id + ' is ' + r.state + '. Your agent can check it with router_trace_access.'); }); };
act(show);
