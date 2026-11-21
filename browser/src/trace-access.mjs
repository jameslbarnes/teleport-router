const $ = id => document.getElementById(id);
const id = new URLSearchParams(location.search).get('entry');
let key = localStorage.getItem('router_key'), busy = false;
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
  const revision = { request_id: r.request_id, revision: r.revision };
  if (!r.app) {
    panel.append(element('h2', r.requester + ' asked ' + r.owner + ' for a trace'), link,
      element('p', 'This request was made before requests had to carry an app, so it can only be declined. The requester can ask again with an app.'));
  } else {
    panel.append(element('h2', r.requester + ' wants to run an app on the trace behind this note'), link,
      element('p', 'What it is for: ' + r.app.purpose),
      element('p', 'The app gets the trace and returns a short answer. It runs in an attested enclave with no network, files or keys. You read its answer before deciding whether the requester gets it. The requester never gets the trace itself.'),
      element('pre', r.app.code, 'trace-app-code'),
      element('p', 'Code hash ' + r.app.hash),
      element('p', r.state === 'answered' ? 'It has run. Open its answer, and release or withhold it, with the owner tool.' : 'Run it with the owner tool, which checks the enclave before giving the run a 15-minute read of this one trace.'));
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
