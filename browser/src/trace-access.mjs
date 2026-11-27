import { SigningKey } from 'ethers';
import { decryptBackup } from './recovery.mjs';
import { sealAgentGrant } from './pair-seal.mjs';

const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('entry');
let key = localStorage.getItem('router_key'), busy = false;
const status = text => { $('status').textContent = text; };

// Capture #pair=<token> from the URL fragment and remove it from the address bar immediately.
let pairToken = null;
{
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('pair');
  if (fromHash && /^[A-Za-z0-9_-]{20,128}$/.test(fromHash)) {
    pairToken = fromHash;
    sessionStorage.setItem('router_trace_agent_pair', fromHash);
    history.replaceState(null, '', location.pathname + location.search);
  } else {
    const saved = sessionStorage.getItem('router_trace_agent_pair');
    if (saved && /^[A-Za-z0-9_-]{20,128}$/.test(saved)) pairToken = saved;
  }
}

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

/** Delegate get-only access on router/traces/ to the local agent and seal the handoff to its public key. */
async function authorizeAgent(info, { password, file } = {}) {
  const DAY = 86400000;
  const hostUrl = new URL(info.storage.host);
  if (hostUrl.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(hostUrl.hostname)) {
    throw Error('Storage must use HTTPS.');
  }
  const [{ TinyCloudWeb, serializeDelegation }, { localProvider, readRecovery }] = await Promise.all([
    import('@tinycloud/web-sdk'),
    import('./storage.mjs'),
  ]);

  let owner = null;
  let traceKey = null;
  try {
    if (info.storage.mode === 'openkey') {
      status('Opening OpenKey to authorize your agent…');
      const { openKeyOwner, openNetworkRecovery } = await import('./openkey.mjs');
      const selected = await openKeyOwner(info.storage.host, { expectedDid: info.storage.owner_did, agentSpace: info.storage.space });
      owner = selected.owner;
      await owner.signIn();
      const recovery = await readRecovery(owner);
      if (!recovery?.networkRecovery) throw Error('Could not find the OpenKey recovery record in your storage.');
      traceKey = await openNetworkRecovery(owner, recovery.networkRecovery, location.origin);
    } else {
      let envelope = null;
      if (file) {
        if (file.size > 25000) throw Error('That file is too large to be a Router recovery file.');
        try { envelope = JSON.parse(await file.text()); } catch { throw Error('That file is not a Router recovery file.'); }
      } else {
        const stored = localStorage.getItem('router_recovery:' + info.handle);
        if (!stored) throw Error('No saved backup in this browser. Choose your Router recovery file below.');
        envelope = JSON.parse(stored);
      }
      status('Unlocking your saved storage key…');
      const backup = await decryptBackup(envelope, password);
      if (backup.handle !== info.handle) throw Error('That backup belongs to @' + backup.handle + ', not @' + info.handle + '.');
      traceKey = backup.tinycloudKey;
      const spacePrefix = info.storage.space.split(':').slice(5).join(':') || 'router';
      owner = new TinyCloudWeb({
        provider: localProvider(traceKey),
        tinycloudHosts: [info.storage.host],
        spacePrefix,
        autoCreateSpace: false,
        autoDiscoverLocalNode: false,
        persistSession: false,
        autoBootstrapAccount: false,
        includeAccountRegistryPermissions: false,
        ui: false,
        sessionExpirationMs: 366 * DAY,
      });
      await owner.signIn();
    }

    if (owner.did.toLowerCase() !== info.storage.owner_did.toLowerCase()) {
      throw Error('This storage account does not match your Router account.');
    }
    const tracePub = new SigningKey(traceKey).compressedPublicKey;
    if (info.storage.owner_public_key && SigningKey.computePublicKey(info.storage.owner_public_key, true) !== tracePub) {
      throw Error('The unlocked key does not match the trace key linked to your Router account.');
    }

    status('Creating a read-only grant for router/traces/…');
    const { delegation } = await owner.delegateTo(
      info.agent_did,
      [{ service: 'tinycloud.kv', space: info.storage.space, path: 'router/traces/', actions: ['get'] }],
      { expiry: 365 * DAY, requireActivation: true },
    );

    status('Sealing the authorization for your local agent…');
    const sealed = await sealAgentGrant({
      v: 1,
      routerKey: key,
      traceKey,
      delegation: serializeDelegation(delegation),
      ownerDid: owner.did,
      space: info.storage.space,
      host: info.storage.host,
      handle: info.handle,
    }, { pairId: info.pair_id, ownerDid: owner.did, agentPublicKey: info.agent_public_key });

    await api('/api/trace-agent/pair/complete', { token: pairToken, sealed });
    sessionStorage.removeItem('router_trace_agent_pair');
    pairToken = null;
  } finally {
    owner?.cleanup?.();
  }
}

function renderPairCard(info) {
  $('heading').textContent = 'Authorize your agent';
  $('note').hidden = true;
  $('ask').hidden = true;
  $('inbox-link').hidden = false;
  $('requests').replaceChildren();

  const panel = element('article', '', 'r-perm');
  const isOpenKey = info.storage.mode === 'openkey';
  const hasSavedBackup = !isOpenKey && !!localStorage.getItem('router_recovery:' + info.handle);

  panel.append(
    element('h2', 'Allow your local agent to approve trace runs for @' + info.handle + '?'),
    element('p', 'Verification code: ' + info.verify_code + ' (confirm this matches what your agent showed you).'),
    element('p', 'Agent address: ' + info.agent_did),
    element('p', 'What this grants: read-only access to router/traces/ for 1 year, so your agent can verify enclave runs and issue 10-minute reads of individual traces when you say yes. It cannot read or edit your published notes (router/posts/) or your insights folder.'),
    element('p', isOpenKey
      ? 'Your OpenKey account stays in OpenKey; only your trace decryption key and the read-only router/traces/ grant are sealed to your local agent.'
      : 'Your trace decryption key is sealed end-to-end to this agent (Router only relays ciphertext). For recovery-file accounts, this is the same key that backs your storage.'),
  );

  if (isOpenKey) {
    const allow = element('button', 'Allow with OpenKey', 'r-btn');
    allow.type = 'button';
    allow.onclick = () => act(async () => {
      await authorizeAgent(info);
      panel.replaceChildren(
        element('h2', 'Agent authorized'),
        element('p', 'Return to your agent — it can now inspect and run trace apps you approve.'),
      );
      status('Done. You can close this tab.');
    });
    panel.append(allow);
  } else {
    const form = document.createElement('form');
    let fileInput = null;
    if (!hasSavedBackup) {
      const fileLabel = element('label', 'Router recovery file (not saved in this browser)');
      fileInput = document.createElement('input');
      fileInput.type = 'file';
      fileInput.accept = '.json,application/json';
      fileInput.required = true;
      fileInput.className = 'r-input';
      form.append(fileLabel, fileInput);
    }
    const pwLabel = element('label', hasSavedBackup ? 'Storage backup password (saved in this browser)' : 'Recovery file password');
    const pwInput = document.createElement('input');
    pwInput.type = 'password';
    pwInput.required = true;
    pwInput.autocomplete = 'current-password';
    pwInput.className = 'r-input';
    const allow = element('button', 'Allow', 'r-btn');
    allow.type = 'submit';
    form.append(pwLabel, pwInput, allow);
    form.onsubmit = event => {
      event.preventDefault();
      act(async () => {
        const pw = pwInput.value;
        pwInput.value = '';
        await authorizeAgent(info, { password: pw, file: fileInput?.files?.[0] || null });
        panel.replaceChildren(
          element('h2', 'Agent authorized'),
          element('p', 'Return to your agent — it can now inspect and run trace apps you approve.'),
        );
        status('Done. You can close this tab.');
      });
    };
    panel.append(form);
  }

  const cancel = element('button', 'Not now', 'r-btn');
  cancel.type = 'button';
  cancel.onclick = () => {
    sessionStorage.removeItem('router_trace_agent_pair');
    pairToken = null;
    status('Cancelled. Nothing was sent.');
    act(show);
  };
  panel.append(cancel);
  $('requests').append(panel);
  status('Check that the verification code matches your agent before allowing.');
}

/** What the app may do with a model. Router writes these lines from the declaration's fixed fields; they are still shown as text only. */
function modelUse(r) {
  const box = element('div', '', 'trace-app-model');
  const lines = Array.isArray(r.model?.lines) ? r.model.lines.filter(line => typeof line === 'string') : ['This app cannot call a model or reach the network.'];
  box.append(element('h3', r.model?.declaration ? 'This app may call a model' : 'No model'));
  for (const line of lines) box.append(element('p', line));
  return box;
}
function card(r) {
  const panel = element('article', '', 'r-perm');
  const link = element('a', 'Read the note'); link.href = '/e/' + encodeURIComponent(r.entry_id);
  const revision = { request_id: r.request_id, revision: r.revision };
  if (!r.app) {
    panel.append(element('h2', r.requester + ' asked ' + r.owner + ' for a trace'), link,
      element('p', 'This request was made before requests had to carry an app, so it can only be declined. The requester can ask again with an app.'));
  } else {
    panel.append(element('h2', r.requester + ' wants to run an app on the trace behind this note'), link,
      element('p', 'What it is for: ' + r.app.purpose),
      element('p', 'The app gets the trace and returns a short answer. It runs in an attested enclave with no network, files or keys of its own; if it declared a model, the runner sends its prompts to that model, as described below. You read its answer before deciding whether the requester gets it. The requester never gets the trace itself.'),
      modelUse(r),
      element('pre', r.app.code, 'trace-app-code'),
      element('p', 'Code hash ' + r.app.hash),
      element('p', r.state === 'answered' ? 'It has run. Ask your agent (or open your owner tool) to read and release or withhold its answer.' : 'Ask your agent to review and run it for you, or run it with your owner tool.'));
  }
  const no = element('button', r.state === 'answered' ? 'Withhold the answer' : 'Decline', 'r-btn');
  no.onclick = () => act(async () => {
    await access({ action: r.state === 'answered' ? 'withhold' : 'decline', ...revision });
    panel.remove(); status(r.state === 'answered' ? 'Answer withheld.' : 'Request declined.');
  });
  panel.append(no); return panel;
}
async function show() {
  $('ask').hidden = true; $('requests').replaceChildren(); $('signin').hidden = !!key;
  if (pairToken) {
    if (!key) { $('heading').textContent = 'Authorize your agent'; status('Sign in to Router to authorize your local agent.'); return; }
    try {
      const info = await api('/api/trace-agent/pair/info', { token: pairToken });
      renderPairCard(info);
      return;
    } catch (e) {
      sessionStorage.removeItem('router_trace_agent_pair');
      pairToken = null;
      status(e.message);
    }
  }
  $('heading').textContent = 'Trace access requests';
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
  for (const r of list) $('requests').append(card(r));
  status('Review each app before running it.');
}
$('signin').onsubmit = event => { event.preventDefault(); act(async () => { key = $('key').value.trim(); await api('/api/identity/lookup', { secret_key: key }); localStorage.setItem('router_key', key); $('key').value = ''; await show(); }); };
act(show);
