import { Wallet } from 'ethers';
import { b64, encryptBackup, decryptBackup } from './recovery.mjs';

const $ = id => document.getElementById(id), params = new URLSearchParams(location.search);
const screens = ['account', 'storage', 'discord', 'rules', 'ready'];
let groupId = params.get('group'), invite = params.get('channelinvite'), key = localStorage.getItem('router_key');
let identity, context, storage, discord, rules, backup, envelope, step = 0, busy = false;
const fragment = new URLSearchParams(location.hash.slice(1));
let pairing = fragment.get('discord-pair');
if (pairing && /^RD-PAIR-[A-Za-z0-9_-]{32}$/.test(pairing)) {
  sessionStorage.setItem('router_setup_pair', JSON.stringify({ group: groupId, pairing }));
  history.replaceState(null, '', location.pathname + location.search);
} else pairing = undefined;
try { const saved = JSON.parse(sessionStorage.getItem('router_setup_pair')); if (!pairing && saved?.group === groupId) pairing = saved.pairing; } catch {}
const message = (value, error = false) => { $('status').textContent = value; $('status').classList.toggle('error', error); };
export async function request(path, body, credential = key) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', cache: 'no-store', redirect: 'error',
    headers: { ...(credential ? { Authorization: 'Bearer ' + credential } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(Error(result.error || 'This step could not finish. Please retry.'), { status: response.status });
  return result;
}
function screen(index) {
  step = index; screens.forEach((id, i) => { $(id).hidden = i !== index; });
  document.querySelectorAll('#steps li').forEach((li, i) => { if (i === index) li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current'); });
  $('back').hidden = index < 2; $('retry').hidden = true;
}
async function act(operation) {
  if (busy) return; busy = true;
  const enabled = [...document.querySelectorAll('button:not(:disabled)')]; enabled.forEach(b => b.disabled = true);
  try { await operation(); } catch (error) { message(error.message || 'This step could not finish. Please retry.', true); $('retry').hidden = false; }
  finally { busy = false; enabled.forEach(b => b.disabled = false); $('connect-storage').disabled = !$('backup-kept').checked; $('confirm-discord').disabled = !$('discord-self').checked; }
}
const backupName = () => 'router_recovery:' + identity.handle;
const receiptName = () => 'router_storage_grant:' + identity.handle;
async function lookup(candidate) {
  const result = await request('/api/identity/lookup', { secret_key: candidate }, null);
  if (!result.handle) throw Error('This Router account has no name yet.');
  return result;
}
async function groupContext() {
  if (groupId && identity) {
    try { return await request('/api/group-onboarding?group=' + encodeURIComponent(groupId)); }
    catch (error) { if (!invite) throw error; }
  }
  if (!invite) throw Error('Open your group’s invitation link to join.');
  return request('/api/group-onboarding?channelinvite=' + encodeURIComponent(invite) + (groupId ? '&group=' + encodeURIComponent(groupId) : ''));
}
async function load() {
  if (key) { try { identity = await lookup(key); } catch (error) { if (error.status !== 401 && error.status !== 404) throw error; identity = undefined; key = undefined; } }
  if (!identity && !invite) {
    screen(0); $('create-account').hidden = true; $('signed-in').hidden = true;
    $('account').querySelector('details').open = true;
    message('Sign in to continue your group setup. New members need an invitation from the group host.'); return;
  }
  context = await groupContext(); groupId = context.group.id;
  $('group-name').textContent = context.group.name; $('description').textContent = context.group.description || 'Keep useful ideas and questions with your group.';
  $('audience').textContent = 'Who can read notes: ' + context.group.audience;
  document.title = context.group.name + ' · Router setup';
  $('create-account').hidden = !!identity; $('signed-in').hidden = !identity;
  if (identity) $('account-name').textContent = 'You’re signed in as @' + identity.handle + '.';
  if (!context.member) { screen(0); message('Join the group to continue. Your personal sharing rules will stay unchanged.'); return; }
  invite = undefined; history.replaceState(null, '', '/group-setup?group=' + encodeURIComponent(groupId));
  await checkStorage();
  if (storage?.linked && storage.available && storage.encryption?.version === 2 && storage.job?.status !== 'running') await showDiscord();
}
async function joinGroup() {
  if (!identity) throw Error('Create or sign into your Router account first.');
  await request('/api/channels/' + encodeURIComponent(groupId) + '/join', { secret_key: key, ...(invite ? { invite_token: invite } : {}) });
  context = await request('/api/group-onboarding?group=' + encodeURIComponent(groupId));
  if (!context.member) throw Error('Your membership could not be confirmed.');
  invite = undefined; history.replaceState(null, '', '/group-setup?group=' + encodeURIComponent(groupId));
  await checkStorage();
}
async function checkStorage() {
  screen(1);
  try { storage = await request('/api/tinycloud/status', { secret_key: key }); }
  catch (error) { if (error.status === 404) throw Error('This Router has not enabled personal storage yet. Your account and group membership are saved; return when your host has enabled it.'); throw error; }
  let saved; try { saved = JSON.parse(localStorage.getItem(backupName())); } catch { throw Error('The saved recovery file could not be read. Restore your downloaded file before continuing.'); }
  envelope ||= saved;
  const ready = storage.linked && storage.available && storage.encryption?.version === 2;
  $('storage-ready').hidden = !ready; $('storage-new').hidden = ready || !!envelope || !!backup;
  $('storage-unlock').hidden = ready || !envelope || !!backup;
  $('storage-connect').hidden = ready || !backup;
  if (ready) { $('storage-state').textContent = 'Your encrypted storage is connected.'; message('Storage is ready.'); }
  else if (storage.job?.status === 'running') { $('storage-new').hidden = $('storage-unlock').hidden = $('storage-connect').hidden = true; message('Your storage is still being connected. Use “Check connection again” in a moment.'); }
  else if (storage.linked) { $('storage-new').hidden = $('storage-unlock').hidden = $('storage-connect').hidden = true; throw Error('Your existing storage is unavailable. Keep your original recovery key and check the connection; this setup will not replace it.'); }
  else message('Make a recovery file before connecting your notes.');
}
function download() {
  if (!envelope) throw Error('Create or unlock your recovery file first.');
  const url = URL.createObjectURL(new Blob([JSON.stringify(envelope, null, 2) + '\n'], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `router-${identity.handle}-recovery.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function acceptBackup(data, encrypted) {
  if (data.origin !== location.origin) throw Error('This backup belongs to a different Router website.');
  const who = await lookup(data.routerKey);
  if (who.handle !== data.handle) throw Error('The recovery file does not match this account.');
  if (identity && who.handle !== identity.handle && !confirm('Switch from @' + identity.handle + ' to @' + who.handle + '?')) return;
  key = data.routerKey; identity = who; backup = data; envelope = encrypted;
  localStorage.setItem('router_key', key); localStorage.setItem(backupName(), JSON.stringify(envelope));
  await load();
}
async function showDiscord() {
  screen(2);
  discord = await request('/api/discord/link/status', { groupId });
  $('discord-start').hidden = !discord.configured || !!discord.linked || !!pairing;
  $('discord-confirm').hidden = true; $('discord-next').hidden = !discord.linked; $('skip-discord').hidden = !!discord.linked;
  $('unlink-discord').hidden = !discord.grantId;
  $('discord-explanation').textContent = discord.configured ? 'Connect your own Discord account to @' + identity.handle + ' in this group.' : 'Your host has not connected this group to Discord yet. You can finish your Router setup now and link Discord later.';
  if (discord.configured) $('open-discord').href = discord.channelUrl;
  $('discord-state').textContent = discord.linked ? 'Connected to Discord ' + (discord.username ? '@' + discord.username : discord.discordUserId) + '. The permission expires ' + new Date(discord.expiresAt).toLocaleDateString() + '.' : discord.pending ? 'You approved a connection, but Discord has not finished it. Use /router-link again to retry.' : '';
  if (pairing) {
    let pair;
    try { pair = await request('/api/discord/pair/info', { pairing, groupId }); }
    catch (error) {
      if (error.status === 410 || error.status === 403) {
        pairing = undefined; sessionStorage.removeItem('router_setup_pair');
        $('discord-start').hidden = !discord.configured || !!discord.linked;
      }
      throw error;
    }
    $('discord-account').textContent = 'Connect Discord ' + (pair.username ? '@' + pair.username : 'account ' + pair.discordUserId) + ' to Router @' + identity.handle + ' in #' + groupId + '? Only continue if this is your Discord account; someone else’s link would give them access under your Router name.';
    $('discord-confirm').hidden = pair.status !== 'waiting';
    if (pair.status === 'approved') { $('discord-state').textContent = 'Confirmed. Return to Discord; the bot is finishing the connection.'; $('discord-next').hidden = true; }
    if (pair.status === 'connected') { $('discord-state').textContent = 'Discord has confirmed the connection.'; $('discord-next').hidden = false; sessionStorage.removeItem('router_setup_pair'); pairing = undefined; }
  }
  message('You choose whether to connect Discord. Group notes stay with this group.');
}
async function showRules() {
  screen(3); rules = await request('/api/posting-rules');
  $('choose-rules').href = '/posting-rules?group=' + encodeURIComponent(groupId) + '&onboarding=1';
  $('rules-next').hidden = !rules.rules;
  $('rules-next').textContent = rules.rules?.mode === 'automatic' && rules.rules?.audience === 'public'
    ? 'Keep automatic public posting and continue' : 'Keep these saved rules and continue';
  $('rules-state').textContent = rules.rules ? 'Your current choice: ' + ({ automatic: 'automatic posting', review: 'show a draft first', manual: 'only when asked' }[rules.rules.mode]) + '. Audience: ' + (rules.rules.audience === 'selected' ? rules.rules.destinations.join(', ') : rules.rules.audience === 'public' ? 'public — anyone on the internet' : 'choose each time') + '. Keep it or edit it below.' : context.group.private
    ? 'Suggested for a private group: useful notes here automatically, with your approval before public publication. Review the exact wording before saving.'
    : 'This group is public. Suggested rules: see and approve each draft before it is published. Review the exact wording before saving.';
  message('Your saved rules apply to every connected agent.');
}
async function finish() {
  // Re-read saved settings and membership: finishing a page is never evidence of a successful write.
  const fresh = await request('/api/group-onboarding?group=' + encodeURIComponent(groupId));
  rules = await request('/api/posting-rules');
  if (!fresh.member || !rules.rules) throw Error('Confirm your membership and save your sharing rules before continuing.');
  try { storage = await request('/api/tinycloud/status', { secret_key: key }); } catch { storage = undefined; }
  try { discord = await request('/api/discord/link/status', { groupId }); } catch { discord = undefined; }
  screen(4); $('read-group').href = fresh.group_url;
  $('ready-state').textContent = 'Your personal sharing rules are saved. You can change them at any time.' +
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
  $('create-account').hidden = true; $('signed-in').hidden = false; $('account-name').textContent = 'Signed in as @' + identity.handle + '.';
  await joinGroup();
}); });
$('join-group').onclick = () => act(joinGroup);
$('existing-account').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const candidate = $('existing-key').value.trim(); identity = await lookup(candidate); key = candidate; backup = envelope = undefined; localStorage.setItem('router_key', key); $('existing-key').value = ''; await load();
}); });
$('restore-account').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  const file = $('restore-file').files[0]; if (!file || file.size > 25000) throw Error('Choose your Router recovery file.');
  const encrypted = JSON.parse(await file.text()), data = await decryptBackup(encrypted, $('restore-password').value);
  $('restore-password').value = ''; await acceptBackup(data, encrypted);
}); });
$('prepare-backup').addEventListener('submit', event => { event.preventDefault(); act(async () => {
  if ($('backup-password').value !== $('backup-repeat').value) throw Error('The two passwords do not match.');
  const imported = $('tinycloud-key-file').files[0]; if (imported?.size > 200) throw Error('Choose the small TinyCloud key file.');
  let privateKey = imported ? (await imported.text()).trim() : Wallet.createRandom().privateKey;
  if (/^[a-fA-F0-9]{64}$/.test(privateKey)) privateKey = '0x' + privateKey;
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) throw Error('Use the TinyCloud key file containing one 64-character hexadecimal key, with or without 0x.');
  new Wallet(privateKey);
  backup = { format: 'router-account', version: 1, origin: location.origin, handle: identity.handle, routerKey: key, tinycloudKey: privateKey, createdAt: new Date().toISOString() };
  envelope = await encryptBackup(backup, $('backup-password').value);
  localStorage.setItem(backupName(), JSON.stringify(envelope)); $('backup-password').value = $('backup-repeat').value = '';
  download(); await checkStorage(); message('Recovery file prepared. Save it and its password before connecting.');
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
$('check-storage').onclick = () => act(checkStorage); $('storage-next').onclick = () => act(showDiscord);
$('skip-storage').onclick = () => act(showRules);
$('check-discord').onclick = () => act(showDiscord);
$('discord-self').onchange = () => { $('confirm-discord').disabled = !$('discord-self').checked; };
$('confirm-discord').onclick = () => act(async () => {
  if (!$('discord-self').checked) throw Error('Confirm only the Discord account you just used yourself.');
  await request('/api/discord/pair/confirm', { pairing, groupId, confirmed: true }); await showDiscord();
});
$('unlink-discord').onclick = () => act(async () => {
  if (!discord?.grantId) return;
  await request('/api/discord/grants/revoke', { grantId: discord.grantId });
  pairing = undefined; sessionStorage.removeItem('router_setup_pair'); await showDiscord();
});
$('discord-next').onclick = $('skip-discord').onclick = () => act(showRules);
$('rules-next').onclick = () => act(finish);
$('back').onclick = () => act(() => step === 4 ? showRules() : step === 3 ? showDiscord() : checkStorage());
$('retry').onclick = () => act(() => step === 0 ? load() : step === 1 ? checkStorage() : step === 2 ? showDiscord() : showRules());
act(async () => {
  if (params.get('rules') === 'saved' && key) {
    identity = await lookup(key); context = await groupContext(); groupId = context.group.id;
    $('group-name').textContent = context.group.name; $('audience').textContent = 'Who can read notes: ' + context.group.audience;
    if (context.member) { try { storage = await request('/api/tinycloud/status', { secret_key: key }); } catch {} await showRules(); return; }
  }
  await load();
});
