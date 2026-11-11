#!/usr/bin/env node
// Router setup for an agent to run on a person's behalf, in place of the guided setup page.
// Needs Node.js 20 or later. Read it before running it: it is one file and does only what is listed here.
//
//   node agent-setup.mjs join --invite <token or invitation link> --handle <name> [--approve-rules group]
//       Creates the person's Router account, joins the group, creates their encrypted note storage
//       and, with --approve-rules group, saves the posting rules the group suggests. Running the same
//       command again continues where an earlier run stopped.
//   node agent-setup.mjs status --handle <name>
//       What is set up: group membership, storage, posting rules, Discord.
//   node agent-setup.mjs discord --handle <name> --link "<private link from /router-link>" [--confirm]
//       Shows which Discord account asked to connect. With --confirm, connects it.
//   node agent-setup.mjs tools --handle <name> [tool-name]
//       Lists Router's tools, or prints one tool's inputs.
//   node agent-setup.mjs call --handle <name> <tool-name> --args-file <file.json>
//       Calls one Router tool as the person, for example to search the group or post a first note
//       before Router is connected to the agent app.
//
// Options: --router <url> (default https://router.teleport.computer), --home <dir> (default ~/.router),
//          --name "<display name>", --no-storage, --group <id> (when the account is in several groups).
//
// What it writes, all under <home>/accounts/<handle>/:
//   router-key          the Router account key. Anyone who has it can post as the person.
//   storage-key         the key that owns their note storage. It never leaves this machine.
//   storage-grant.json  the one-year permission Router was given to its own folder in that storage.
//   account.json        handle, Router address and group. No secrets.
// Keys are never printed. The storage step installs two published packages, @tinycloud/node-sdk and
// ethers, into <home>/setup with npm. Nothing is posted by `join`.
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SDK = '@tinycloud/node-sdk@3.9.1', ETHERS = 'ethers@6.17.0';
const [command, ...argv] = process.argv.slice(2);
const flag = name => argv.includes(name);
const value = name => { const i = argv.indexOf(name); return i < 0 || argv[i + 1]?.startsWith('--') ? undefined : argv[i + 1]; };
let secrets = [];
const clean = text => secrets.reduce((t, s) => s ? t.split(s).join('[key removed]') : t, String(text));
const fail = message => { console.error(clean(message)); process.exit(1); };
const say = message => console.error(clean(message));   // progress goes to stderr; the result is one JSON object on stdout

if (Number(process.versions.node.split('.')[0]) < 20) fail('This script needs Node.js 20 or later.');
const router = new URL(value('--router') || 'https://router.teleport.computer');
if (router.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(router.hostname)) fail('Use an https Router address.');
const home = value('--home') || join(homedir(), '.router');

async function api(path, { body, key, method } = {}) {
  const response = await fetch(new URL(path, router), { method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'error',
    headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`${path.split('?')[0]}: ${data.error || 'Router answered ' + response.status}`), { status: response.status, data });
  return data;
}

const handleArg = () => {
  const handle = (value('--handle') || '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z][a-z0-9_]{2,14}$/.test(handle)) fail('Give --handle <name>: 3 to 15 lowercase letters, digits or underscores, starting with a letter.');
  return handle;
};
const accountDir = handle => join(home, 'accounts', handle);
const readText = path => readFile(path, 'utf8').then(t => t.trim(), err => err.code === 'ENOENT' ? null : Promise.reject(err));
async function writeSecret(path, text) { await writeFile(path, text + '\n', { mode: 0o600, flag: 'wx' }); await chmod(path, 0o600).catch(() => {}); }
async function account(handle) {
  const dir = accountDir(handle), key = await readText(join(dir, 'router-key'));
  if (!key) fail(`No account files for @${handle} under ${dir}. Run "join" first, or pass the --home used then.`);
  secrets.push(key);
  const info = JSON.parse(await readText(join(dir, 'account.json')) || '{}');
  if (info.router && info.router !== router.origin) fail(`@${handle} was set up on ${info.router}. Pass --router ${info.router}.`);
  return { dir, key, info };
}

// ── Owner recovery, the same check the setup page makes: before Router stores anything, prove that the
// person's storage key can open the key their notes are encrypted with. Matches server/src/author-records.ts.
const utf8 = text => new TextEncoder().encode(text);
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const unb64 = (text, length) => {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('Unreadable recovery record.');
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  if (b64(bytes) !== text || (length !== undefined && bytes.length !== length)) throw new Error('Unreadable recovery record.');
  return bytes;
};
const recoveryContext = b => [b.ownerDid.toLowerCase(), b.space, b.prefix];
const recoveryInfo = (domain, b, ...rest) => utf8(JSON.stringify([domain, ...recoveryContext(b), ...rest]));
async function recoverAuthorKey(ethers, privateKey, raw, binding) {
  const e = JSON.parse(raw), signing = new ethers.SigningKey(privateKey), recipient = signing.compressedPublicKey;
  if (binding.ownerDid.toLowerCase() !== 'did:pkh:eip155:1:' + ethers.computeAddress(privateKey).toLowerCase()
      || e.version !== 1 || e.suite !== 'secp256k1-hkdf-sha256-aes256gcm'
      || JSON.stringify(recoveryContext(e)) !== JSON.stringify(recoveryContext(binding)) || e.recipient !== recipient
      || !/^0x(?:02|03)[a-f0-9]{64}$/.test(e.ephemeralPublicKey || '')) throw new Error('The recovery record belongs to a different storage account.');
  const aad = recoveryInfo('teleport-router/owner-recovery/v1', binding, recipient, e.ephemeralPublicKey);
  const secret = ethers.getBytes(signing.computeSharedSecret(e.ephemeralPublicKey)).slice(1, 33);
  const hk = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveBits']);
  const wrapping = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: aad }, hk, 256));
  try {
    const ciphertext = unb64(e.ciphertext), tag = unb64(e.tag, 16), joined = new Uint8Array(ciphertext.length + tag.length);
    joined.set(ciphertext); joined.set(tag, ciphertext.length);
    const aes = await crypto.subtle.importKey('raw', wrapping, 'AES-GCM', false, ['decrypt']);
    const opened = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.nonce, 12), additionalData: aad, tagLength: 128 }, aes, joined));
    return unb64(new TextDecoder('utf-8', { fatal: true }).decode(opened), 32);
  } finally { secret.fill(0); wrapping.fill(0); }
}
async function recoveryProof(ethers, privateKey, prepared) {
  const bytes = await recoverAuthorKey(ethers, privateKey, prepared.recovery, prepared.context);
  try {
    const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return Buffer.from(await crypto.subtle.sign('HMAC', key, recoveryInfo('teleport-router/recovery-confirmation/v1', prepared.context, prepared.message, prepared.recovery))).toString('hex');
  } finally { bytes.fill(0); }
}

async function storagePackages() {
  const dir = join(home, 'setup');
  await mkdir(dir, { recursive: true });
  const require = createRequire(join(dir, 'package.json'));
  const load = () => ({ sdk: require('@tinycloud/node-sdk'), ethers: require('ethers') });
  try { return load(); } catch { /* not installed yet */ }
  if (!await readText(join(dir, 'package.json'))) await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'router-setup-packages', private: true }) + '\n');
  say(`Installing ${SDK} and ${ETHERS} into ${dir} (about a minute)…`);
  // One fixed command line with nothing from outside in it; npm is a script on Windows and needs the shell.
  const done = spawnSync(`npm install --no-audit --no-fund --save-exact ${SDK} ${ETHERS}`, { cwd: dir, shell: true, encoding: 'utf8' });
  if (done.status !== 0) throw new Error(`npm install failed in ${dir}: ${(done.stderr || done.error?.message || '').slice(-600)}`);
  return load();
}

async function connectStorage(dir, key) {
  const status = await api('/api/tinycloud/status', { body: { secret_key: key } });
  if (status.linked && status.available && status.encryption?.version === 2) return { state: 'already connected', space: status.space };
  const service = await api('/api/tinycloud/router');
  if (service.mode !== 'authors' || service.folder !== 'router/' || service.ownerRecovery !== 'secp256k1-v1'
      || service.recordEncryption !== 'aes-256-gcm-v2' || !service.recoveryConfirmationRequired) throw new Error('This Router does not offer the encrypted storage this setup expects.');
  // Router may only be given these four operations on its own folder, whatever the server asks for.
  const allowed = ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'];
  if (!Array.isArray(service.actions) || !service.actions.length || service.actions.some(a => !allowed.includes(a))) throw new Error('This Router asked for storage permissions this setup does not grant.');
  if (new URL(service.host).protocol !== 'https:') throw new Error('Storage must use HTTPS.');
  const { sdk, ethers } = await storagePackages();
  let privateKey = await readText(join(dir, 'storage-key'));
  if (!privateKey) { privateKey = ethers.Wallet.createRandom().privateKey; await writeSecret(join(dir, 'storage-key'), privateKey); }
  if (!/^0x[\da-fA-F]{64}$/.test(privateKey)) throw new Error(`${join(dir, 'storage-key')} does not hold a storage key.`);
  secrets.push(privateKey, privateKey.slice(2));
  const year = 365 * 86400_000;
  const owner = new sdk.TinyCloudNode({ privateKey, host: service.host, prefix: 'router', autoCreateSpace: true, enablePublicSpace: false, sessionExpirationMs: year + 86400_000 });
  say('Opening the storage space…');
  await owner.signIn();
  const grantPath = join(dir, 'storage-grant.json');
  let grant, receipt = JSON.parse(await readText(grantPath) || 'null');
  if (receipt && receipt.ownerDid?.toLowerCase() === owner.did.toLowerCase() && receipt.routerDid?.toLowerCase() === service.did.toLowerCase()) {
    const prior = sdk.deserializeDelegation(receipt.delegation);
    if (new Date(prior.expiry).getTime() > Date.now() + 86400_000) grant = prior;   // an interrupted run keeps its grant
  }
  if (!grant) {
    grant = await owner.createDelegation({ delegateDID: service.did, path: service.folder, actions: service.actions, expiryMs: year, includePublicSpace: false });
    await writeFile(grantPath, JSON.stringify({ router: router.origin, ownerDid: owner.did, routerDid: service.did, cid: grant.cid, space: grant.spaceId,
      expiry: grant.expiry, delegation: sdk.serializeDelegation(grant) }, null, 1) + '\n', { mode: 0o600 });
  }
  const delegation = sdk.serializeDelegation(grant);
  say('Checking that the storage key can open the notes Router will keep…');
  const challenge = await api('/api/tinycloud/challenge', { body: { secret_key: key, delegation } });
  const signature = await new ethers.Wallet(privateKey).signMessage(challenge.message);
  const prepared = await api('/api/tinycloud/recovery', { body: { secret_key: key, delegation, signature } });
  if (prepared.message !== challenge.message || prepared.context.space !== grant.spaceId || prepared.context.prefix !== grant.path
      || prepared.context.ownerDid.toLowerCase() !== owner.did.toLowerCase()) throw new Error('Storage recovery did not match this account.');
  const recovery_proof = await recoveryProof(ethers, privateKey, prepared);
  await api('/api/tinycloud/link', { body: { secret_key: key, delegation, signature, recovery_proof } });
  for (const deadline = Date.now() + 180_000; ;) {
    const now = await api('/api/tinycloud/status', { body: { secret_key: key } });
    if (now.job?.status === 'failed') throw new Error('Storage setup did not finish. The keys on this machine are still valid; run the same command again.');
    if (now.job?.status === 'complete' || (!now.job && now.linked)) {
      if (!now.linked || !now.available || now.encryption?.version !== 2) throw new Error('Encrypted storage is not ready. Run the same command again.');
      // Read the stored recovery record back with the owner key before saying it worked.
      const check = await owner.kv.get('router/recovery-v1', { source: 'network' });
      if (!check.ok) throw new Error('Could not read the recovery record back. Run the same command again.');
      const raw = typeof check.data.data === 'string' ? check.data.data : JSON.stringify(check.data.data);
      (await recoverAuthorKey(ethers, privateKey, raw, prepared.context)).fill(0);
      return { state: 'connected', space: now.space, router_access_until: grant.expiry };
    }
    if (!now.job) throw new Error('Router restarted during storage setup. Run the same command again.');
    if (Date.now() > deadline) throw new Error('Storage is still being connected. Run "status" in a minute, then the same command again if it is not connected.');
    await new Promise(r => setTimeout(r, 1500));
  }
}

// ── One Router tool call over MCP, so an agent can read and post before Router is connected to its app.
async function mcp(key, calls) {
  let session, id = 0;
  const send = async (method, params, notify = false) => {
    const response = await fetch(new URL('/mcp/http', router), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180_000),
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', method, ...(params ? { params } : {}), ...(notify ? {} : { id: ++id }) }) });
    session ||= response.headers.get('mcp-session-id');
    const text = await response.text();
    if (!response.ok) throw new Error(`Router's tool endpoint answered ${response.status}: ${text.slice(0, 300)}`);
    if (notify) return null;
    const messages = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? text.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => JSON.parse(l.slice(5))) : [JSON.parse(text)];
    const reply = messages.find(m => m.id === id);
    if (!reply) throw new Error('Router did not answer the tool request.');
    if (reply.error) throw new Error(reply.error.message || 'Router refused the tool request.');
    return reply.result;
  };
  await send('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'router-agent-setup', version: '1' } });
  await send('notifications/initialized', undefined, true);
  try { return await calls(send); }
  finally { await fetch(new URL('/mcp/http', router), { method: 'DELETE', headers: { Authorization: 'Bearer ' + key, 'Mcp-Session-Id': session || '' }, signal: AbortSignal.timeout(10_000) }).catch(() => {}); }
}

async function overview(handle, key, groupId) {
  const out = { handle: '@' + handle, router: router.origin };
  if (groupId) {
    const view = await api('/api/group-onboarding?group=' + encodeURIComponent(groupId), { key }).catch(err => ({ error: err.message }));
    out.group = view.error ? { id: groupId, member: false, problem: view.error }
      : { id: view.group.id, name: view.group.name, private: view.group.private, who_can_read: view.group.audience, member: view.member, notes: view.group_url };
    const discord = await api('/api/discord/link/status', { key, body: { groupId } }).catch(() => null);
    out.discord = !discord?.configured ? { available: false } : { available: true, connected: !!discord.linked, channel: discord.channelUrl, account: discord.username || undefined };
  }
  const storage = await api('/api/tinycloud/status', { body: { secret_key: key } }).catch(() => null);
  out.storage = storage?.linked && storage.available ? 'connected' : 'not connected';
  const rules = await api('/api/posting-rules', { key });
  out.posting_rules = rules.rules ? { saved: true, mode: rules.rules.mode, audience: rules.rules.audience === 'selected' ? rules.rules.destinations.join(', ') : rules.rules.audience, revision: rules.revision }
    : { saved: false };
  return out;
}

async function run() {
  if (command === 'join') {
    const handle = handleArg(), dir = accountDir(handle);
    const invite = (value('--invite') || '').replace(/^.*[?&]channelinvite=([^&#]+).*$/, (_, t) => decodeURIComponent(t));
    if (!/^[\w-]{6,80}$/.test(invite)) fail('Give --invite <token>, or the whole invitation link.');
    const approve = value('--approve-rules');
    if (flag('--approve-rules') && approve !== 'group') fail('--approve-rules takes "group": save the rules this group suggests. Leave it out to choose rules later.');
    // Look at the invitation before creating anything, so a dead link leaves no account behind.
    let view = await api('/api/group-onboarding?channelinvite=' + encodeURIComponent(invite));
    await mkdir(dir, { recursive: true });
    const steps = {};

    // 1. Account. The key is written to disk before Router hears of it, so a crash cannot lose the account.
    let key = await readText(join(dir, 'router-key'));
    if (!key) { key = randomBytes(32).toString('base64url'); await writeSecret(join(dir, 'router-key'), key); }
    secrets.push(key);
    const known = await api('/api/identity/lookup', { body: { secret_key: key } }).catch(() => ({}));
    if (known.handle && known.handle !== handle) fail(`The key in ${dir} already belongs to @${known.handle}.`);
    if (known.handle) steps.account = 'already existed';
    else {
      try { await api('/api/identity/register', { body: { secret_key: key, handle, ...(value('--name') ? { displayName: value('--name').slice(0, 60) } : {}) } }); }
      catch (err) { if (err.status === 409) fail(`@${handle} is taken. Ask the person for another handle and run again with it.`); throw err; }
      steps.account = 'created';
    }

    // 2. Group.
    view = await api('/api/group-onboarding?channelinvite=' + encodeURIComponent(invite), { key });
    const groupId = view.group.id;
    await writeFile(join(dir, 'account.json'), JSON.stringify({ handle, router: router.origin, group: groupId, set_up_at: new Date().toISOString() }, null, 1) + '\n');
    if (view.member) steps.group = 'already a member';
    else {
      await api(`/api/channels/${encodeURIComponent(groupId)}/join`, { body: { secret_key: key, invite_token: invite } });
      view = await api('/api/group-onboarding?group=' + encodeURIComponent(groupId), { key });
      if (!view.member) throw new Error('Router did not confirm the group membership.');
      steps.group = 'joined';
    }

    // 3. Storage.
    if (flag('--no-storage')) steps.storage = 'skipped (--no-storage)';
    else {
      try { steps.storage = (await connectStorage(dir, key)).state; }
      catch (err) { steps.storage = 'not connected: ' + clean(err.message); }
    }

    // 4. Posting rules: saved only when the person approved the group's suggestion, and never over rules they already have.
    const current = await api('/api/posting-rules', { key });
    if (current.rules) steps.posting_rules = 'kept the rules already saved';
    else if (approve === 'group') {
      await api('/api/posting-rules', { key, body: { rules: view.suggested_rules, confirmed: true, expected_revision: current.revision || 0 } });
      steps.posting_rules = 'saved the group’s suggested rules';
    } else steps.posting_rules = 'not saved: choose them with the person, then save with router_posting_rules';

    const state = await overview(handle, key, groupId);
    const next = [];
    if (state.storage !== 'connected') next.push('Storage is not connected. Run the same join command again.');
    if (!state.posting_rules.saved) next.push('Choose posting rules with the person and save them.');
    if (state.discord?.available && !state.discord.connected) next.push(`Discord: the person joins the server, types /router-link in ${state.discord.channel} and gives you the private link it returns. Then run: node agent-setup.mjs discord --handle ${handle} --link "<that link>"`);
    console.log(JSON.stringify({ done: steps, ...state,
      keys: { folder: dir, files: ['router-key', ...(state.storage === 'connected' ? ['storage-key', 'storage-grant.json'] : [])],
        note: 'These files are the account. Router cannot recover them. Tell the person to back this folder up somewhere private. Never print or post their contents.' },
      suggested_rules_in_words: view.suggested_rules.instructions, next }, null, 1));
    return;
  }

  if (command === 'status') {
    const handle = handleArg(), { key, info } = await account(handle);
    console.log(JSON.stringify(await overview(handle, key, value('--group') || info.group), null, 1));
    return;
  }

  if (command === 'discord') {
    const handle = handleArg(), { key, info } = await account(handle);
    const link = value('--link') || '';
    const pairing = /RD-PAIR-[A-Za-z0-9_-]{32}/.exec(link)?.[0];
    if (!pairing) fail('Give --link "<the private link Discord showed after /router-link>". It is valid for ten minutes.');
    secrets.push(pairing);
    const groupId = /[?&]group=([a-z0-9-]+)/.exec(link)?.[1] || value('--group') || info.group;
    const body = { pairing, groupId };
    const pair = flag('--confirm') ? await api('/api/discord/pair/confirm', { key, body: { ...body, confirmed: true } }) : await api('/api/discord/pair/info', { key, body });
    let status = pair.status;
    // After confirming, the bot collects the permission and Discord shows the person that it worked.
    for (let i = 0; flag('--confirm') && status === 'approved' && i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      status = (await api('/api/discord/pair/info', { key, body }).catch(() => ({ status }))).status;
    }
    console.log(JSON.stringify({ discord_account: pair.username ? '@' + pair.username : pair.discordUserId, discord_display_name: pair.displayName || undefined,
      router_account: '@' + handle, group: '#' + groupId,
      state: status === 'connected' ? 'connected' : status === 'approved' ? 'confirmed; Discord is finishing the connection' : 'waiting for confirmation',
      next: status === 'waiting' ? 'Tell the person which Discord account this is. Only if it is theirs, run the same command with --confirm.' : undefined }, null, 1));
    return;
  }

  if (command === 'tools' || command === 'call') {
    const handle = handleArg(), { key } = await account(handle);
    const takesValue = ['--handle', '--router', '--home', '--args-file', '--group', '--link', '--invite', '--name', '--approve-rules'];
    const name = argv.find((a, i) => !a.startsWith('--') && !takesValue.includes(argv[i - 1]));
    if (command === 'tools') {
      const { tools } = await mcp(key, send => send('tools/list', {}));
      if (!name) { console.log(JSON.stringify(tools.map(t => ({ name: t.name, does: (t.description || '').split('\n')[0].slice(0, 160) })), null, 1)); return; }
      const tool = tools.find(t => t.name === name) || fail(`No Router tool named ${name}.`);
      console.log(JSON.stringify(tool, null, 1));
      return;
    }
    if (!name || !value('--args-file')) fail('Usage: call --handle <name> <tool-name> --args-file <file.json>');
    const args = JSON.parse(await readFile(value('--args-file'), 'utf8'));
    const result = await mcp(key, send => send('tools/call', { name, arguments: args }));
    for (const part of result.content || []) console.log(clean(part.type === 'text' ? part.text : JSON.stringify(part)));
    if (result.isError) process.exitCode = 1;
    return;
  }

  fail('Usage: node agent-setup.mjs <join|status|discord|tools|call> … (the comment at the top of this file lists each one)');
}

run().catch(err => fail(err?.message || String(err)));
