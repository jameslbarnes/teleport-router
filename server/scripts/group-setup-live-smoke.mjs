/** Real browser + local Router + hosted TinyCloud. Throwaway identities only; no Discord messages. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { TinyCloudNode } from '@tinycloud/node-sdk';
import { recoverAuthorKey, decryptOwnerRecord } from '../dist/author-records.js';
import { decryptBackup } from '../../browser/src/recovery.mjs';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const host = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
const port = 22000 + Math.floor(Math.random() * 2000), base = `http://127.0.0.1:${port}`;
const dir = await mkdtemp(join(tmpdir(), 'ellis-router-browser-'));
const routerKey = '0x' + randomBytes(32).toString('hex'), ownerKey = randomBytes(32).toString('base64url'), botKey = randomBytes(32).toString('base64url');
const server = spawn(process.execPath, ['dist/http.js'], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'], env: {
  ...process.env, NODE_ENV: 'test', PORT: String(port), LISTEN_HOST: '127.0.0.1', BASE_URL: base,
  FIREBASE_SERVICE_ACCOUNT: '', FIREBASE_SERVICE_ACCOUNT_BASE64: '', GOOGLE_APPLICATION_CREDENTIALS: '', ANTHROPIC_API_KEY: '',
  MODERATOR_URL: '', MODERATOR_API_KEY: '', MATRIX_HOMESERVER_URL: '', TELEGRAM_BOT_TOKEN: '',
  TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: 'tinycloud', TINYCLOUD_KEY_SOURCE: 'test-key', TINYCLOUD_ROUTER_KEY: routerKey,
  TINYCLOUD_HOST: host, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', RECOVERY_FILE: join(dir, 'pending.json'),
} });
server.stderr.resume();
const api = async (path, body, key) => {
  const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90000) });
  if (!r.ok) throw Error(path + ': HTTP ' + r.status);
  return r.json();
};
let browser, page, account, receipt, owner, saved, solo, soloPage, soloReceipt;
try {
  for (let i = 0; i < 120; i++) { try { await api('/health'); break; } catch { if (i === 119) throw Error('Local server did not start'); await new Promise(r => setTimeout(r, 250)); } }
  await api('/api/identity/register', { secret_key: ownerKey, handle: 'browser_host' });
  await api('/api/identity/register', { secret_key: botKey, handle: 'browser_bot' });
  const groupId = 'browser-private';
  await api('/api/channels', { secret_key: ownerKey, id: groupId, name: 'Browser test group', join_rule: 'invite' });
  const actor = { guildId: '100000000000000001', channelId: '100000000000000002', discordUserId: '100000000000000003' };
  await api('/api/discord/bind', { groupId, botHandle: 'browser_bot', scope: 'guild', guildId: actor.guildId }, ownerKey);
  const invite = await api(`/api/channels/${groupId}/invite`, { secret_key: ownerKey, max_uses: 1 });
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ acceptDownloads: true });
  const blockedOrigins = [];
  await context.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if ([base, new URL(host).origin].includes(origin)) return route.continue();
    blockedOrigins.push(origin); return route.abort();
  });
  page = await context.newPage(); page.setDefaultTimeout(120000);
  const pageErrors = [], posted = [], consoleErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); });
  page.on('request', req => { if (req.postData()) posted.push(req.postData()); });
  await page.goto(base + '/join?channelinvite=' + invite.token);
  await page.locator('#handle').fill('browser_reader');
  await page.locator('#create-account button').click();
  await page.locator('#storage-new').waitFor();
  await page.locator('#backup-password').fill('synthetic live browser password');
  await page.locator('#backup-repeat').fill('synthetic live browser password');
  const downloading = page.waitForEvent('download');
  await page.locator('#prepare-backup button').click();
  const stream = await (await downloading).createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  account = await decryptBackup(JSON.parse(Buffer.concat(chunks).toString()), 'synthetic live browser password');
  await page.locator('#backup-kept').check();
  await page.locator('#connect-storage').click();
  // Wait for either confirmed success or a usable, sanitized error instead of hiding it behind a timeout.
  await page.waitForFunction(() => !document.getElementById('storage-ready').hidden || document.getElementById('status').classList.contains('error'));
  if (await page.locator('#status.error').count()) {
    const raw = await page.locator('#status').textContent();
    throw Error('Browser storage: ' + raw.replaceAll(account.tinycloudKey, '[key]').replaceAll(account.routerKey, '[key]').slice(0, 350));
  }
  receipt = await page.evaluate(handle => JSON.parse(localStorage.getItem('router_storage_grant:' + handle)), account.handle);
  assert.equal(posted.some(body => body.includes(account.tinycloudKey)), false, 'Owner key never leaves browser');
  console.log('PASS browser creates its own TinyCloud space, delegates, proves recovery and verifies encrypted activation');
  await page.locator('#storage-next').click();
  await page.locator('#discord-start').waitFor();
  const pair = await api('/api/discord/pair/start', { ...actor, groupId, displayName: 'Synthetic Discord member', username: 'synthetic_discord' }, botKey);
  await page.goto(pair.url);
  await page.waitForFunction(() => !document.getElementById('discord-confirm').hidden || document.getElementById('status').classList.contains('error'));
  if (await page.locator('#status.error').count()) throw Error('Discord confirmation did not open: ' + (await page.locator('#status').textContent()).slice(0, 250));
  await page.locator('#discord-confirm').waitFor();
  assert.equal(new URL(page.url()).hash, '', 'Pair capability removed from the visible URL');
  await page.locator('#discord-self').check();
  await page.locator('#confirm-discord').click();
  await page.locator('#discord-state').filter({ hasText: 'Confirmed.' }).waitFor();
  const paired = await api('/api/discord/pair/poll', { ...actor, groupId, pairing: pair.pairing }, botKey);
  assert.equal(paired.handle, account.handle);
  await api('/api/discord/pair/ack', { ...actor, groupId, pairing: pair.pairing }, botKey);
  await page.locator('#check-discord').click();
  await page.locator('#discord-next').click();
  await page.locator('#choose-rules').click();
  await page.locator('#use-group').click();
  await page.locator('#preview').click();
  await page.locator('#confirmed').check();
  await page.locator('#save').click();
  await page.locator('#status').filter({ hasText: 'Saved' }).waitFor();
  await page.getByRole('link', { name: 'Continue group setup' }).click();
  await page.locator('#ready').waitFor();
  console.log('PASS browser confirms the actual Discord identity and saves private-group rules through the existing editor');
  const operated = await api('/api/discord/operate', { ...actor, grant: paired.grant, action: 'save', content: 'Synthetic browser onboarding note', interactionId: '100000000000000010' }, botKey);
  saved = operated.entry.id;
  const reread = await api('/api/discord/operate', { ...actor, grant: paired.grant, action: 'read', entryId: saved }, botKey);
  assert.equal(reread.entry.content, 'Synthetic browser onboarding note');
  owner = new TinyCloudNode({ privateKey: account.tinycloudKey, host, prefix: 'router', autoCreateSpace: false, enablePublicSpace: false });
  await owner.signIn();
  const status = await api('/api/tinycloud/status', { secret_key: account.routerKey });
  const binding = { ownerDid: owner.did, space: status.space, prefix: 'router/' };
  const recovery = await owner.kv.get('router/recovery-v1', { source: 'network' }), encrypted = await owner.kv.get('router/posts/' + saved, { source: 'network' });
  assert(recovery.ok && encrypted.ok);
  const raw = data => typeof data === 'string' ? data : JSON.stringify(data);
  const authorKey = recoverAuthorKey(account.tinycloudKey, raw(recovery.data.data), binding);
  assert.equal(decryptOwnerRecord(authorKey, raw(encrypted.data.data), binding, 'posts', saved).content, 'Synthetic browser onboarding note');
  authorKey.fill(0); assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedOrigins, [], 'The browser contacts only this Router and its TinyCloud node');
  assert.equal(consoleErrors.some(message => /Content Security Policy|Refused to|dynamically imported module/i.test(message)), false, 'No blocked script, network or WASM resources');
  console.log('PASS private save/read and independent owner decryption of the browser-created account');

  // The same page with no invitation and no group: a person setting up on their own, against real storage.
  const soloContext = await browser.newContext({ acceptDownloads: true });
  await soloContext.route('**/*', route => {
    const origin = new URL(route.request().url()).origin;
    if ([base, new URL(host).origin].includes(origin)) return route.continue();
    blockedOrigins.push(origin); return route.abort();
  });
  soloPage = await soloContext.newPage(); soloPage.setDefaultTimeout(120000);
  const soloPosted = [];
  soloPage.on('pageerror', error => pageErrors.push(error.message));
  soloPage.on('console', event => { if (event.type() === 'error') consoleErrors.push(event.text()); });
  soloPage.on('request', req => { if (req.postData()) soloPosted.push(req.postData()); });
  await soloPage.goto(base + '/group-setup');
  await soloPage.locator('#handle').fill('browser_solo');
  await soloPage.locator('#create-submit').click();
  await soloPage.locator('#storage-new').waitFor();
  await soloPage.locator('#backup-password').fill('synthetic live solo password');
  await soloPage.locator('#backup-repeat').fill('synthetic live solo password');
  const soloDownloading = soloPage.waitForEvent('download');
  await soloPage.locator('#prepare-backup button').click();
  const soloStream = await (await soloDownloading).createReadStream(), soloChunks = [];
  for await (const chunk of soloStream) soloChunks.push(chunk);
  solo = await decryptBackup(JSON.parse(Buffer.concat(soloChunks).toString()), 'synthetic live solo password');
  assert.equal(solo.handle, 'browser_solo');
  await soloPage.locator('#backup-kept').check();
  await soloPage.locator('#connect-storage').click();
  await soloPage.waitForFunction(() => !document.getElementById('storage-ready').hidden || document.getElementById('status').classList.contains('error'));
  if (await soloPage.locator('#status.error').count()) {
    const raw = await soloPage.locator('#status').textContent();
    throw Error('Browser storage without a group: ' + raw.replaceAll(solo.tinycloudKey, '[key]').replaceAll(solo.routerKey, '[key]').slice(0, 350));
  }
  soloReceipt = await soloPage.evaluate(handle => JSON.parse(localStorage.getItem('router_storage_grant:' + handle)), solo.handle);
  assert.equal(soloPosted.some(body => body.includes(solo.tinycloudKey)), false, 'Owner key never leaves browser');
  // Coming back signed in, with storage connected, goes on to the posting rules.
  await soloPage.reload();
  await soloPage.locator('#choose-rules[href]').waitFor();
  assert.equal(await soloPage.locator('#step-discord').isVisible(), false);
  await soloPage.locator('#choose-rules').click();
  await soloPage.locator('input[name=mode][value=manual]').check();
  await soloPage.locator('input[name=audience][value=ask]').check();
  await soloPage.locator('#preview').click();
  await soloPage.locator('#confirmed').check();
  await soloPage.locator('#save').click();
  await soloPage.locator('#status').filter({ hasText: 'Saved' }).waitFor();
  await soloPage.getByRole('link', { name: 'Continue setup' }).click();
  await soloPage.locator('#ready').waitFor();
  assert.equal(await soloPage.locator('#ready-connect').isVisible(), true);
  assert.doesNotMatch(await soloPage.locator('#ready-state').textContent(), /kept only in this browser|not connected/);
  // The owner can recover the account's record key with nothing but their own key.
  const soloOwner = new TinyCloudNode({ privateKey: solo.tinycloudKey, host, prefix: 'router', autoCreateSpace: false, enablePublicSpace: false });
  await soloOwner.signIn();
  const soloStatus = await api('/api/tinycloud/status', { secret_key: solo.routerKey });
  assert.equal(soloStatus.linked && soloStatus.available && soloStatus.encryption?.version === 2, true);
  const soloRecovery = await soloOwner.kv.get('router/recovery-v1', { source: 'network' });
  assert(soloRecovery.ok);
  const soloKey = recoverAuthorKey(solo.tinycloudKey, raw(soloRecovery.data.data), { ownerDid: soloOwner.did, space: soloStatus.space, prefix: 'router/' });
  assert.equal(soloKey.length > 0, true); soloKey.fill(0);
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(blockedOrigins, [], 'The browser contacts only this Router and its TinyCloud node');
  assert.equal(consoleErrors.some(message => /Content Security Policy|Refused to|dynamically imported module/i.test(message)), false, 'No blocked script, network or WASM resources');
  console.log('PASS setup without an invitation: account, recovery file, real storage, posting rules, and owner recovery of the record key');
} finally {
  if (solo) {
    try {
      if (!soloReceipt && soloPage && !soloPage.isClosed()) soloReceipt = await soloPage.evaluate(handle => JSON.parse(localStorage.getItem('router_storage_grant:' + handle)), solo.handle);
      const soloOwner = new TinyCloudNode({ privateKey: solo.tinycloudKey, host, prefix: 'router', autoCreateSpace: false, enablePublicSpace: false });
      await soloOwner.signIn();
      if (soloReceipt?.cid) { const revoked = await soloOwner.revokeDelegation(soloReceipt.cid); if (!revoked.ok) console.error('Synthetic grant cleanup needs retry.'); }
    } catch { console.error('Synthetic storage cleanup was unavailable. No personal account was used.'); }
  }
  if (account) {
    try {
      if (!receipt && page && !page.isClosed()) receipt = await page.evaluate(handle => JSON.parse(localStorage.getItem('router_storage_grant:' + handle)), account.handle);
      owner ||= new TinyCloudNode({ privateKey: account.tinycloudKey, host, prefix: 'router', autoCreateSpace: false, enablePublicSpace: false });
      await owner.signIn();
      if (saved) await owner.kv.delete('router/posts/' + saved);
      if (receipt?.cid) { const revoked = await owner.revokeDelegation(receipt.cid); if (!revoked.ok) console.error('Synthetic grant cleanup needs retry.'); }
    } catch { console.error('Synthetic storage cleanup was unavailable. No personal account was used.'); }
  }
  await browser?.close(); server.kill();
}
setTimeout(() => process.exit(0), 100).unref();
