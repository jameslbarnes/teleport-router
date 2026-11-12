import { Wallet } from 'ethers';
import { b64, encryptBackup, decryptBackup } from './recovery.mjs';

const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const screens = ['account', 'storage', 'discord', 'rules', 'connect', 'ready'];
let groupId = params.get('group'), invite = params.get('channelinvite'), key = localStorage.getItem('router_key');
let identity, context, storage, discord, rules, backup, envelope, step = 0, busy = false;
let pairing;
const retryText = 'This step did not finish. Try again.';
// No invitation and no group: a person setting up Router for themselves. The same steps, without the group ones.
const isSolo = !invite && !groupId, solo = () => isSolo;
function showSolo() {
  $('group-name').textContent = 'Set up Router'; document.title = 'Set up Router';
  $('description').textContent = 'Create your account, keep a recovery file, choose your posting rules, then connect your agent.'; $('description').hidden = false;
  $('audience').hidden = true; $('eyebrow').hidden = true; $('step-discord').hidden = true; $('step-connect').hidden = false;
  $('create-submit').textContent = 'Create account';
  $('rules-intro').textContent = 'Posting rules say when your agent may post, who can read it, and what to leave out. They are your personal rules, used wherever you connect an agent to Router.';
  $('rules-discord-hint').hidden = true;
}
function capturePairing() {
  const candidate = new URLSearchParams(location.hash.slice(1)).get('discord-pair');
  if (!candidate || !/^RD-PAIR-[A-Za-z0-9_-]{32}$/.test(candidate)) return false;
  pairing = candidate;
  sessionStorage.setItem('router_setup_pair', JSON.stringify({ group: groupId, pairing }));
  history.replaceState(null, '', location.pathname + location.search);
  return true;
}
capturePairing();
try { const saved = JSON.parse(sessionStorage.getItem('router_setup_pair')); if (!pairing && saved?.group === groupId) pairing = saved.pairing; } catch {}
const message = (value, error = false) => { $('status').textContent = value; $('status').classList.toggle('error', error); $('status').classList.toggle('r-status--error', error); };
export async function request(path, body, credential = key) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
    headers: { ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || retryText), { status: response.status });
  return result;
}
// While someone is being asked to allow a connection, the page shows the permission card and nothing around it.
const asking = on => document.body.toggleAttribute('data-permission', on);
function screen(index) {
  step = index; screens.forEach((id, i) => { $(id).hidden = i !== index; }); asking(false);
  $('no-invite').hidden = true; $('steps').hidden = false;
  document.querySelectorAll('#steps li').forEach((li, i) => { if (i === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
  $('back').hidden = index < 2; $('retry').hidden = true;
}
async function act(operation) {
  if (busy) return; busy = true;
  const enabled = [...document.querySelectorAll('button:not(:disabled)')]; enabled.forEach(b => b.disabled = true);
  try { await operation(); } catch (error) { message(error.message || retryText, true); $('retry').hidden = false; }
  finally { busy = false; enabled.forEach(b => b.disabled = false); $('connect-storage').disabled = !$('backup-kept').checked; $('confirm-discord').disabled = !$('discord-self').checked; }
}
const backupName = () => 'router_recovery:' + identity.handle;
const receiptName = () => 'router_storage_grant:' + identity.handle;
async function lookup(candidate) {
  const result = await request('/api/identity/lookup', { secret_key: candidate }, null);
  if (!result.handle) throw Error('This Router account has no handle yet.');
  return result;
}
async function groupContext() {
  if (groupId && identity) {
    try { return await request('/api/group-onboarding?group=' + encodeURIComponent(groupId)); }
    catch (error) { if (!invite) throw error; }
  }
  if (!invite) throw Error('To join a group, open its invitation link.');
  return request('/api/group-onboarding?channelinvite=' + encodeURIComponent(invite) + (groupId ? '&group=' + encodeURIComponent(groupId) : ''));
}
function showGroup() {
  groupId = context.group.id;
  $('group-name').textContent = context.group.name;
  $('description').textContent = context.group.description || 'Keep useful ideas and questions with your group.'; $('description').hidden = false;
  $('audience').textContent = 'Who can read notes: ' + context.group.audience; $('audience').hidden = false;
  $('eyebrow').hidden = !invite;
  // An invited person who has not joined yet sees, first, what to hand to their own agent.
  const forAgent = !!invite && !context.member && typeof context.agent_message === 'string';
  $('for-agent').hidden = !forAgent; if (forAgent) $('agent-message').textContent = context.agent_message;
  // Public groups have no Discord connection, so that step never appears for them.
  if (!context.group.private) $('step-discord').hidden = true;
  document.title = context.group.name + ' · Router';
}
function accountView(signInOnly) {
  $('account-heading').textContent = signInOnly ? 'Sign in or restore your account' : identity ? 'Join this group' : 'Pick a name';
  $('account-intro').hidden = signInOnly || solo(); $('restore-summary').hidden = signInOnly;
  if (signInOnly) $('restore').open = true;
}
async function load() {
  if (key) { try { identity = await lookup(key); } catch (error) { if (error.status !== 401 && error.status !== 404) throw error; identity = undefined; key = undefined; } }
  if (!identity && !invite && groupId) {
    // Signed out, continuing a group's setup without its invitation: sign in or restore a recovery file.
    screen(0); $('steps').hidden = true; $('create-account').hidden = true; $('signed-in').hidden = true;
    $('group-name').textContent = 'Group setup'; $('description').hidden = true; $('audience').hidden = true;
    accountView(true);
    message('Sign in to continue your group setup. To create a new account, open the group’s invitation link.'); return;
  }
  if (solo()) {
    showSolo();
    if (!identity) {
      screen(0); $('step-discord').hidden = true; $('create-account').hidden = false; $('signed-in').hidden = true; accountView(false);
      message('Pick a handle to create your account.'); return;
    }
    // Signed in already, for example straight after restoring a recovery file on a new device.
    await checkStorage();
    if (storage?.linked && storage.available && storage.encryption?.version === 2 && storage.job?.status !== 'running') await showRules();
    return;
  }
  context = await groupContext(); showGroup();
  $('create-account').hidden = !!identity; $('signed-in').hidden = !identity;
  if (identity) $('account-name').textContent = 'You’re signed in as @' + identity.handle + '.';
  accountView(false);
  if (!context.member) { screen(0); message(identity ? 'Join the group to continue. Your posting rules stay as they are.' : 'Pick a handle to create your account and join the group.'); return; }
  invite = undefined; history.replaceState(null, '', '/group-setup?group=' + encodeURIComponent(groupId));
  await checkStorage();
  if (storage?.linked && storage.available && storage.encryption?.version === 2 && storage.job?.status !== 'running') await showDiscord();
}
async function joinGroup() {
  if (!identity) throw Error('Create an account or sign in first.');
  await request('/api/channels/' + encodeURIComponent(groupId) + '/join', { secret_key: key, ...(invite ? { invite_token: invite } : {}) });
  context = await request('/api/group-onboarding?group=' + encodeURIComponent(groupId));
  if (!context.member) throw Error('Your membership could not be confirmed.');
  invite = undefined; history.replaceState(null, '', '/group-setup?group=' + encodeURIComponent(groupId));
  await checkStorage();
}
async function checkStorage() {
  screen(1);
  try { storage = await request('/api/tinycloud/status', { secret_key: key }); }
  catch (error) { if (error.status === 404) throw Error('Personal storage is not turned on for this Router yet. ' + (solo() ? 'Your account is saved. You can skip this step.' : 'Your account and group membership are saved. Come back when it has been turned on.')); throw error; }
  let saved; try { saved = JSON.parse(localStorage.getItem(backupName())); } catch { throw Error('The saved recovery file could not be read. Restore your downloaded file before continuing.'); }
  envelope ||= saved;
  const ready = storage.linked && storage.available && storage.encryption?.version === 2;
  $('storage-ready').hidden = !ready; $('storage-new').hidden = ready || !!envelope || !!backup;
  $('storage-unlock').hidden = ready || !envelope || !!backup;
  $('storage-connect').hidden = ready || !backup;
  // Skipping only risks the Router key while no recovery file holds a copy of it.
  $('skip-storage').hidden = ready; $('skip-note').hidden = ready || !!envelope;
  if (ready) { $('storage-state').textContent = 'Your encrypted storage is connected.'; message('Storage is ready.'); }
  else if (storage.job?.status === 'running') { $('storage-new').hidden = $('storage-unlock').hidden = $('storage-connect').hidden = true; message('Your storage is still being connected. Use “Check connection again” in a moment.'); }
  else if (storage.linked) { $('storage-new').hidden = $('storage-unlock').hidden = $('storage-connect').hidden = true; throw Error('Your existing storage cannot be reached. Keep your original recovery file and check the connection again. This setup will not replace your storage.'); }
  else message('Make a recovery file before connecting your storage.');
}
function download() {
  if (!envelope) throw Error('Create or unlock your recovery file first.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `router-${identity.handle}-recovery.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function acceptBackup(data, encrypted) {
  if (data.origin !== location.origin) throw Error('This recovery file belongs to a different Router website.');
  const who = await lookup(data.routerKey);
  if (who.handle !== data.handle) throw Error('The recovery file does not match this account.');
  if (identity && who.handle !== identity.handle && !confirm('Switch from @' + identity.handle + ' to @' + who.handle + '?')) return;
  key = data.routerKey; identity = who; backup = data; envelope = encrypted;
  localStorage.setItem('router_key', key); localStorage.setItem(backupName(), JSON.stringify(envelope));
  await load();
}
async function showDiscord(back = false) {
  if (solo()) return back ? checkStorage() : showRules();
  discord = context.group.private ? await request('/api/discord/link/status', { groupId }) : { configured: false, linked: false };
  // A group with no Discord connection has nothing to do on this screen, so it is passed over in both directions.
  const skip = !discord.configured && !discord.linked && !discord.pending && !discord.grantId && !pairing;
  $('step-discord').hidden = skip;
  if (skip) return back ? checkStorage() : showRules();
  screen(2);
  $('discord-start').hidden = !discord.configured || !!discord.linked || !!pairing;
  $('discord-confirm').hidden = true; $('discord-next').hidden = !discord.linked; $('skip-discord').hidden = !!discord.linked;
  $('unlink-discord').hidden = !discord.grantId;
  $('discord-explanation').textContent = discord.configured ? 'Connect your own Discord account to @' + identity.handle + ' in this group.' : 'This group is not connected to Discord at the moment. You can finish your Router setup now and connect Discord later.';
  if (discord.configured) $('open-discord').href = discord.channelUrl;
  // Only Discord's own invitation addresses are linked, whatever the server sent.
  const serverInvite = /^https:\/\/(?:discord\.gg|discord\.com\/invite)\/[A-Za-z0-9-]{2,40}$/.test(context.discord_invite || '') ? context.discord_invite : '';
  $('discord-invite').hidden = !serverInvite; $('discord-invite-missing').hidden = !!serverInvite; if (serverInvite) $('discord-invite').href = serverInvite;
  $('discord-state').textContent = discord.linked ? 'Connected to Discord ' + (discord.username ? '@' + discord.username : discord.discordUserId) + '. It stays connected while you use it. Without use, it ends on ' + new Date(discord.expiresAt).toLocaleDateString() + '.' : discord.pending ? 'You approved a connection, but Discord has not finished it. Use /router-link again to retry.' : '';
  if (pairing && context.group.private) {
    let pair;
    try { pair = await request('/api/discord/pair/info', { pairing, groupId }); }
    catch (error) {
      if (error.status === 410 || error.status === 403) {
        pairing = undefined; sessionStorage.removeItem('router_setup_pair');
        $('discord-start').hidden = !discord.configured || !!discord.linked;
      }
      throw error;
    }
    const each = (name, value) => document.querySelectorAll('.' + name).forEach(el => { el.textContent = value; });
    each('perm-discord', pair.username ? '@' + pair.username : 'Account ' + pair.discordUserId);
    $('discord-confirm').dataset.notes = pair.notes ? 'true' : 'false';
    if (pair.notes && pair.status === 'waiting') {
      // What the person is really agreeing to is their own rules, so the card shows those back.
      const saved = (await request('/api/posting-rules')).rules, here = '#' + groupId;
      $('perm-rules-line').textContent = !saved ? 'You have no posting rules yet, so it will ask you before each note.'
        : saved.mode === 'manual' ? 'Only when you ask. It writes a note when you put 📝 on your own message.'
        : saved.mode === 'automatic' && saved.audience === 'selected' && saved.destinations.includes(here) ? 'Post automatically, to ' + here + '.'
        : saved.mode === 'automatic' ? 'Your automatic posting does not name ' + here + ', so it will ask you before each note.'
        : 'Show you a draft first. It will ask you before each note.';
      const own = saved?.instructions?.trim() || '';
      $('perm-rules-own').textContent = own ? '“' + (own.length > 220 ? own.slice(0, 220).trimEnd() + '…' : own) + '”' : '';
    }
    $('perm-discord-initial').textContent = (Array.from(pair.username || '')[0] || 'd').toLowerCase();
    $('perm-you-initial').textContent = identity.handle[0];
    each('perm-display', pair.displayName ? 'Discord shows it as “' + pair.displayName + '”. ' : '');
    each('perm-handle', '@' + identity.handle);
    document.querySelectorAll('.perm-group').forEach(el => { el.textContent = '#' + groupId; });
    $('discord-confirm').hidden = pair.status !== 'waiting'; asking(pair.status === 'waiting');
    if (pair.status === 'waiting') return message('');
    if (pair.status === 'approved') { $('discord-state').textContent = 'Confirmed. Return to Discord; the bot is finishing the connection.'; $('discord-next').hidden = true; }
    if (pair.status === 'connected') { $('discord-state').textContent = 'Discord has confirmed the connection.'; $('discord-next').hidden = false; sessionStorage.removeItem('router_setup_pair'); pairing = undefined; }
  }
  message('Connecting Discord is optional. Group notes stay with this group.');
}
async function showRules() {
  screen(3); rules = await request('/api/posting-rules');
  $('choose-rules').href = solo() ? '/posting-rules?onboarding=1' : '/posting-rules?group=' + encodeURIComponent(groupId) + '&onboarding=1';
  // Someone new to a private group answers one question, and each answer opens the editor with matching rules.
  const asking = !rules.rules && !solo() && !!context.group.private;
  $('public-question').hidden = !asking; $('choose-rules-group-only').hidden = !asking;
  $('choose-rules-group-only').href = $('choose-rules').href + '&public=never';
  $('choose-rules').textContent = asking ? 'This group, and public when I approve' : 'Choose my posting rules';
  $('rules-next').hidden = !rules.rules;
  $('rules-next').textContent = rules.rules?.mode === 'automatic' && rules.rules?.audience === 'public'
    ? 'Keep automatic public posting and continue' : 'Keep these saved rules and continue';
  $('rules-state').textContent = rules.rules ? 'Your current choice: ' + ({ automatic: 'automatic posting', review: 'show a draft first', manual: 'only when asked' }[rules.rules.mode]) + '. Audience: ' + (rules.rules.audience === 'selected' ? rules.rules.destinations.join(', ') : rules.rules.audience === 'public' ? 'public (anyone on the internet can read it)' : 'chosen with you for each note') + '. Keep it or edit it below.' : solo()
    ? 'You have no posting rules yet. Until you save some, an agent you connect is told to help you choose before it posts anything.'
    : context.group.private
    ? 'Either way, your agent posts useful notes to this group without asking each time. With the second choice it may also post publicly, but only after you approve the exact text. You review the wording before saving.'
    : 'This group is public. Suggested rules: your agent shows you each draft and waits for your approval before posting. You review the exact wording before saving.';
  message('Your posting rules apply to every agent you connect.');
}
// A setup with no group ends by connecting an agent. The plugin commands carry no key; the key is copied separately.
async function showConnect() {
  rules = await request('/api/posting-rules');
  if (!rules.rules) throw Error('Save your posting rules before continuing.');
  screen(4); $('copy-state').textContent = '';
  message('Connect your agent, or do it later from the Connect page.');
}
async function copy(text, done) {
  try { await navigator.clipboard.writeText(text); $('copy-state').textContent = done; }
  catch { $('copy-state').textContent = 'Could not copy. Select the text and copy it yourself.'; }
}
async function finish() {
  // After the posting rules page this script has started afresh, so look again for the recovery file kept in this browser.
  try { envelope ||= JSON.parse(localStorage.getItem(backupName())) || undefined; } catch {}
  // Re-read saved settings and membership: finishing a page is never evidence of a successful write.
  if (solo()) {
    rules = await request('/api/posting-rules');
    if (!rules.rules) throw Error('Save your posting rules before continuing.');
    try { storage = await request('/api/tinycloud/status', { secret_key: key }); } catch { storage = undefined; }
    screen(5); $('step-discord').hidden = true;
    $('ready-heading').textContent = 'Your account is set up';
    $('ready-intro').textContent = 'Nothing is posted until an agent you connected posts within your rules. When it does, it shows you the note in the conversation, with who can read it and a link to delete it.';
    $('ready-later').hidden = true; $('ready-discord').hidden = true;
    $('read-group').href = '/'; $('read-group').textContent = 'Open the notebook';
    $('ready-state').textContent = 'Your posting rules are saved. You can change them at any time.' +
      (!envelope && !storage?.linked ? ' Your Router key is kept only in this browser. Go back to the storage step and download a recovery file before clearing the browser’s data or moving to another device.' : '') +
      (envelope && (!storage?.linked || !storage?.available) ? ' Your recovery file is saved, but storage is not connected yet; you can finish that from the storage step.' : '');
    message('Setup saved. Nothing has been posted.'); return;
  }
  const fresh = await request('/api/group-onboarding?group=' + encodeURIComponent(groupId));
  rules = await request('/api/posting-rules');
  if (!fresh.member || !rules.rules) throw Error('Confirm your membership and save your posting rules before continuing.');
  try { storage = await request('/api/tinycloud/status', { secret_key: key }); } catch { storage = undefined; }
  try { discord = await request('/api/discord/link/status', { groupId }); } catch { discord = undefined; }
  screen(5); $('read-group').href = fresh.group_url;
  $('step-discord').hidden = !(discord?.configured || discord?.linked);
  $('ready-state').textContent = 'Your posting rules are saved. You can change them at any time.' +
    (!envelope && !storage?.linked ? ' Your Router key is kept only in this browser. Go back to the storage step and download a recovery file before clearing the browser’s data or moving to another device.' : '') +
    (!storage?.linked || !storage?.available ? ' Storage setup is still pending; return here before using Discord’s private commands.' : '') +
    (!discord?.linked ? ' Discord is not connected yet.' : '');
  $('ready-discord').hidden = !discord?.linked;
  message('Setup saved. Nothing has been posted.');
}
$('create-account').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const candidate = b64(crypto.getRandomValues(new Uint8Array(32)));
  const result = await request('/api/identity/register', { secret_key: candidate, handle: $('handle').value.trim() }, null);
  if (!result.handle) throw Error('Account creation could not be confirmed.');
  key = candidate; identity = result; localStorage.setItem('router_key', key);
  if (solo()) { await checkStorage(); return; }
  $('create-account').hidden = true; $('signed-in').hidden = false; $('account-name').textContent = 'You’re signed in as @' + identity.handle + '.'; accountView(false);
  await joinGroup();
}); });
$('join-group').onclick = () => act(joinGroup);
$('existing-account').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const candidate = $('existing-key').value.trim(); identity = await lookup(candidate); key = candidate; backup = envelope = undefined; localStorage.setItem('router_key', key); $('existing-key').value = ''; await load();
}); });
$('restore-account').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const file = $('restore-file').files[0]; if (!file || file.size > 25000) throw Error('Choose your Router recovery file.');
  let encrypted; try { encrypted = JSON.parse(await file.text()); } catch { throw Error('That file is not a Router recovery file.'); }
  const data = await decryptBackup(encrypted, $('restore-password').value);
  $('restore-password').value = ''; await acceptBackup(data, encrypted);
}); });
$('prepare-backup').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  if ($('backup-password').value !== $('backup-repeat').value) throw Error('The two passwords do not match.');
  const imported = $('tinycloud-key-file').files[0]; if (imported?.size > 200) throw Error('That file is too large to be a TinyCloud key file.');
  let privateKey = imported ? (await imported.text()).trim() : Wallet.createRandom().privateKey;
  if (/^[a-fA-F0-9]{64}$/.test(privateKey)) privateKey = '0x' + privateKey;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) throw Error('Use the TinyCloud key file containing one 64-character hexadecimal key, with or without 0x.');
  new Wallet(privateKey);
  backup = { format: 'router-account', version: 1, origin: location.origin, handle: identity.handle, routerKey: key, tinycloudKey: privateKey, createdAt: new Date().toISOString() };
  envelope = await encryptBackup(backup, $('backup-password').value);
  localStorage.setItem(backupName(), JSON.stringify(envelope)); $('backup-password').value = $('backup-repeat').value = '';
  download(); await checkStorage(); message('Your recovery file is ready. Save it and its password before connecting storage.');
}); });
$('unlock-backup').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const data = await decryptBackup(envelope, $('unlock-password').value); $('unlock-password').value = '';
  if (data.origin !== location.origin || data.routerKey !== key || data.handle !== identity.handle) throw Error('This recovery file belongs to a different Router account.');
  backup = data; await checkStorage();
}); });
$('download-backup').onclick = () => act(async () => download());
$('backup-kept').onchange = () => { $('connect-storage').disabled = !$('backup-kept').checked; };
$('connect-storage').onclick = () => act(async () => {
  if (!backup || !$('backup-kept').checked) throw Error('Save your recovery file and password first.');
  const { connectStorage } = await import('./storage.mjs');
  let receipt; try { receipt = JSON.parse(localStorage.getItem(receiptName())); } catch {}
  storage = await connectStorage({ privateKey: backup.tinycloudKey, routerKey: key, request, onProgress: message, receipt, saveReceipt: value => localStorage.setItem(receiptName(), JSON.stringify(value)) });
  backup = undefined; await checkStorage();
});
$('check-storage').onclick = () => act(checkStorage); $('storage-next').onclick = () => act(() => showDiscord());
$('skip-storage').onclick = () => act(showRules);
$('check-discord').onclick = () => act(() => showDiscord());
$('discord-self').onchange = () => { $('confirm-discord').disabled = !$('discord-self').checked; };
$('confirm-discord').onclick = () => act(async () => {
  if (!$('discord-self').checked) throw Error('Confirm only the Discord account you just used yourself.');
  await request('/api/discord/pair/confirm', { pairing, groupId, confirmed: true }); await showDiscord();
});
// Not now: nothing is sent. The link from Discord simply runs out, ten minutes after it was made.
$('decline-discord').onclick = () => act(async () => {
  pairing = undefined; sessionStorage.removeItem('router_setup_pair'); $('discord-self').checked = false; await showDiscord();
});
$('unlink-discord').onclick = () => act(async () => {
  if (!discord?.grantId) return;
  await request('/api/discord/grants/revoke', { grantId: discord.grantId });
  pairing = undefined; sessionStorage.removeItem('router_setup_pair'); await showDiscord();
});
$('discord-next').onclick = $('skip-discord').onclick = () => act(showRules);
$('rules-next').onclick = () => act(() => solo() ? showConnect() : finish());
$('copy-plugin').onclick = () => copy($('plugin-commands').textContent, 'Commands copied.');
$('copy-agent-message').onclick = async () => {
  try { await navigator.clipboard.writeText($('agent-message').textContent); $('agent-copy-state').textContent = 'Copied. Paste it into your agent.'; }
  catch { $('agent-copy-state').textContent = 'Could not copy. Select the text and copy it yourself.'; }
};
$('copy-key').onclick = () => copy(key, 'Router key copied. Paste it when Claude Code asks, and nowhere else.');
$('connect-next').onclick = $('connect-later').onclick = () => act(finish);
$('back').onclick = () => act(() => step === 5 ? (solo() ? showConnect() : showRules()) : step === 4 ? showRules() : step === 3 ? showDiscord(true) : checkStorage());
$('retry').onclick = () => act(() => step === 0 ? load() : step === 1 ? checkStorage() : step === 2 ? showDiscord() : step === 4 ? showConnect() : showRules());
// Discord can reuse the current tab. A fragment-only navigation does not reload
// the module, so consume that capability just as we do when opening a new tab.
window.addEventListener('hashchange', () => { if (capturePairing()) act(load); });
act(async () => {
  if (params.get('rules') === 'saved' && key && solo()) {
    // Back from the posting rules editor in a setup with no group.
    identity = await lookup(key); showSolo();
    rules = await request('/api/posting-rules');
    history.replaceState(null, '', '/group-setup');
    if (rules.rules) { await showConnect(); return; }
    await showRules(); return;
  }
  if (params.get('rules') === 'saved' && key && groupId) {
    // Back from the posting rules editor. The rules were reviewed and saved there, so finish() re-reads
    // them and goes to the last screen without asking the person to confirm them again.
    identity = await lookup(key); context = await groupContext(); showGroup();
    if (context.member) {
      rules = await request('/api/posting-rules');
      if (rules.rules) { await finish(); return; }
      try { storage = await request('/api/tinycloud/status', { secret_key: key }); } catch {}
      await showRules(); return;
    }
  }
  await load();
});
