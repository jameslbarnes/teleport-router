/** Real pages and an isolated in-memory server. No live accounts or external requests. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const reservation = createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const cwd = fileURLToPath(new URL('..', import.meta.url));
const evidence = process.env.BROWSER_EVIDENCE_DIR;
if (evidence) await mkdir(evidence, { recursive: true });
const child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], { cwd, env: {
  ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000',
  TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', ANTHROPIC_API_KEY: '',
}, stdio: ['ignore', 'ignore', 'pipe'] });
let serverError = ''; child.stderr.on('data', d => { serverError = (serverError + d).slice(-2000); });
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw Error(`${path}: ${response.status}`);
  return response.json();
};
let browser;
try {
  let ready = false;
  for (let i = 0; i < 200; i++) { try { await api('/health'); ready = true; break; } catch {} await new Promise(r => setTimeout(r, 150)); }
  if (!ready) throw Error('Local browser fixture failed: ' + serverError);
  const ownerKey = randomBytes(32).toString('base64url');
  await api('/api/identity/register', { secret_key: ownerKey, handle: 'local_host' });
  for (const [id, name, join_rule] of [['reading-club', 'Reading club', 'invite'], ['open-club', 'Open club', 'open']]) {
    await api('/api/channels', { secret_key: ownerKey, id, name, join_rule, description: 'Ideas, references and questions we want to explore together.' });
  }
  const { token } = await api('/api/channels/reading-club/invite', { secret_key: ownerKey, max_uses: 10 });
  const inviteUrl = base + '/join?channelinvite=' + encodeURIComponent(token);
  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const newContext = async (options = {}) => {
    const context = await browser.newContext(options);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    // This local walkthrough tests page state, account creation and saved rules. Real
    // TinyCloud linking is exercised separately; these two unavailable local services are explicit fixtures.
    await context.route('**/api/tinycloud/status', route => route.fulfill({ json: { linked: true, available: true, encryption: { version: 2 } } }));
    await context.route('**/api/discord/link/status', route => route.fulfill({ json: { configured: false, linked: false } }));
    return context;
  };
  const context = await newContext({ viewport: { width: 1160, height: 1000 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const rules = () => page.evaluate(async () => {
    const r = await fetch('/api/posting-rules', { headers: { Authorization: 'Bearer ' + localStorage.getItem('router_key') } });
    return r.json();
  });
  const saveRules = async revision => {
    await page.locator('#preview').click();
    await page.locator('#confirmed').check();
    await page.locator('#save').click();
    await page.locator('#status').filter({ hasText: `Saved · revision ${revision}` }).waitFor();
  };
  await page.goto(inviteUrl);
  await page.locator('#group-name').filter({ hasText: 'Reading club' }).waitFor();
  assert.equal(await page.locator('#create-account').isVisible(), true);
  await page.locator('#handle').fill('local_reader');
  await page.locator('#create-account button').click();
  await page.locator('#storage-ready').waitFor();
  if (evidence) await page.screenshot({ path: resolve(evidence, 'setup-desktop.png'), fullPage: true });
  await page.locator('#storage-next').click();
  // This fixture has no Discord connection, so setup goes straight to the posting rules.
  await page.locator('#choose-rules').click();
  await page.locator('#group-start').waitFor();
  assert.equal((await rules()).revision, 0);
  assert.match(await page.locator('#group-audience').textContent(), /including people who join later/);
  if (evidence) await page.screenshot({ path: resolve(evidence, 'group-start-desktop.png'), fullPage: true });
  await page.locator('#use-group').click();
  assert.equal(await page.locator('input[name=mode]:checked').inputValue(), 'automatic');
  assert.equal(await page.locator('#destinations').inputValue(), '#reading-club');
  assert.equal((await rules()).revision, 0);
  const wording = 'Ask me before publishing on the public notebook. Keep my research questions in my words.';
  await page.locator('#instructions').fill(wording);
  await page.locator('#preview').click();
  assert.match(await page.locator('#draft').textContent(), /public notebook: only after your approval/);
  await saveRules(1);
  assert.equal((await rules()).rules.instructions, wording);
  await page.reload();
  await page.locator('#group-start').waitFor();
  assert.equal(await page.locator('#instructions').inputValue(), wording);
  await page.locator('input[name=mode][value=manual]').check();
  await saveRules(2);
  await page.locator('#use-group').click();
  assert.equal(await page.locator('input[name=mode]:checked').inputValue(), 'manual');
  assert.equal(await page.locator('#instructions').inputValue(), wording);
  assert.equal((await rules()).revision, 2);
  page.on('dialog', dialog => dialog.accept());
  await page.goto(inviteUrl);
  await page.locator('#choose-rules').click();
  await page.locator('#group-start').waitFor();
  assert.equal((await rules()).revision, 2);
  await page.setViewportSize({ width: 390, height: 844 });
  if (evidence) await page.screenshot({ path: resolve(evidence, 'group-start-phone.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);

  // A removed member can still edit their personal rules to choose another audience.
  assert.equal(await page.evaluate(async () => (await fetch('/api/channels/reading-club/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret_key: localStorage.getItem('router_key') }) })).ok), true);
  await page.reload();
  await page.locator('#group-error').waitFor();
  await page.locator('#editor:not([disabled])').waitFor();
  assert.equal(await page.locator('#instructions').inputValue(), wording);
  assert.equal(await page.locator('#group-start').isVisible(), false);

  // Public groups visibly offer review mode, including for a new rules profile.
  const publicContext = await newContext();
  await publicContext.addInitScript(key => localStorage.setItem('router_key', key), ownerKey);
  const openPage = await publicContext.newPage();
  await openPage.goto(base + '/posting-rules?group=open-club');
  await openPage.locator('#group-start').waitFor();
  assert.match(await openPage.locator('#group-audience').textContent(), /Public:.*without joining/);
  await openPage.locator('#use-group').click();
  assert.equal(await openPage.locator('input[name=mode]:checked').inputValue(), 'review');
  await openPage.locator('input[name=mode][value=automatic]').check();
  await openPage.locator('input[name=audience][value=public]').check();
  await openPage.locator('#preview').click();
  await openPage.locator('#confirmed').check();
  await openPage.locator('#save').click();
  await openPage.locator('#status').filter({ hasText: 'Saved' }).waitFor();
  await openPage.goto(base + '/group-setup?group=open-club');
  await openPage.locator('#rules-next').filter({ hasText: 'Keep automatic public posting and continue' }).waitFor();
  assert.equal(await openPage.locator('#rules-next').textContent(), 'Keep automatic public posting and continue');
  await publicContext.close();

  // Retry a failed join without creating another account or falling into public setup.
  const second = await newContext({ viewport: { width: 390, height: 844 } });
  const failure = await second.newPage();
  await failure.goto(inviteUrl);
  await failure.locator('#group-name').filter({ hasText: 'Reading club' }).waitFor();
  await failure.route('**/api/channels/reading-club/join', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic unavailable"}' }));
  await failure.locator('#handle').fill('local_retry');
  await failure.locator('#create-account button').click();
  await failure.locator('#status.error').waitFor();
  assert.equal(await failure.locator('#create-account').isVisible(), false);
  assert.equal(await failure.locator('#join-group').isVisible(), true);
  assert.equal(await failure.evaluate(() => !!localStorage.getItem('router_key')), true);
  await failure.unroute('**/api/channels/reading-club/join');
  await failure.locator('#join-group').click();
  await failure.locator('#storage-ready').waitFor();
  await second.close();

  // Owner recovery file is created and encrypted in the real browser, then unlocked
  // after a reload. No owner private key is sent to the local Router endpoints.
  const recoveryContext = await newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  await recoveryContext.route('**/api/tinycloud/status', route => route.fulfill({ json: { linked: false } }));
  const recoveryPage = await recoveryContext.newPage();
  const requests = []; recoveryPage.on('request', r => { if (r.postData()) requests.push(r.postData()); });
  recoveryPage.on('pageerror', error => errors.push(error.message));
  await recoveryPage.goto(inviteUrl);
  await recoveryPage.locator('#handle').fill('local_recovery');
  await recoveryPage.locator('#create-account button').click();
  await recoveryPage.locator('#storage-new').waitFor();
  await recoveryPage.locator('#backup-password').fill('synthetic browser recovery password');
  await recoveryPage.locator('#backup-repeat').fill('synthetic browser recovery password');
  const downloaded = recoveryPage.waitForEvent('download');
  await recoveryPage.locator('#prepare-backup button').click();
  const stream = await (await downloaded).createReadStream(), chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  assert.equal(envelope.format, 'router-encrypted-backup');
  const { decryptBackup } = await import('../../browser/src/recovery.mjs');
  const recovered = await decryptBackup(envelope, 'synthetic browser recovery password');
  assert.equal(recovered.handle, 'local_recovery');
  assert.equal(requests.some(body => body.includes(recovered.tinycloudKey)), false);
  assert.equal(await recoveryPage.evaluate(privateKey => JSON.stringify(localStorage).includes(privateKey), recovered.tinycloudKey), false);
  assert.equal(await recoveryPage.locator('#connect-storage').isDisabled(), true);
  if (evidence) await recoveryPage.screenshot({ path: resolve(evidence, 'recovery-phone.png'), fullPage: true });
  assert.equal(await recoveryPage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await recoveryPage.reload();
  await recoveryPage.locator('#storage-unlock').waitFor();
  await recoveryPage.locator('#unlock-password').fill('incorrect browser recovery password');
  await recoveryPage.locator('#unlock-backup button').click();
  await recoveryPage.locator('#status.error').waitFor();
  assert.equal(await recoveryPage.locator('#storage-connect').isVisible(), false);
  await recoveryPage.locator('#unlock-password').fill('synthetic browser recovery password');
  await recoveryPage.locator('#unlock-backup button').click();
  await recoveryPage.locator('#storage-connect').waitFor();
  await recoveryPage.locator('#skip-storage').click();
  await recoveryPage.locator('#choose-rules').click();
  await recoveryPage.locator('#use-group').click();
  await recoveryPage.locator('#preview').click();
  await recoveryPage.locator('#confirmed').check();
  await recoveryPage.locator('#save').click();
  await recoveryPage.locator('#status').filter({ hasText: 'Saved' }).waitFor();
  // Coming back from saving rules goes straight to the finish, with no second confirmation.
  await recoveryPage.getByRole('link', { name: 'Continue group setup' }).click();
  await recoveryPage.locator('#ready').waitFor();
  assert.match(await recoveryPage.locator('#ready-state').textContent(), /Storage setup is still pending/);
  assert.equal(await recoveryPage.locator('#read-group').getAttribute('href'), base + '/?view=channel&id=reading-club');
  await recoveryContext.close();

  // A Discord link often opens a signed-out browser. The member can restore their
  // downloaded backup there without needing another invitation or a new account.
  const restoredContext = await newContext();
  const restoredPage = await restoredContext.newPage();
  restoredPage.on('pageerror', error => errors.push(error.message));
  await restoredPage.goto(base + '/group-setup?group=reading-club');
  await restoredPage.locator('#restore-account').waitFor();
  assert.equal(await restoredPage.locator('#create-account').isVisible(), false);
  await restoredPage.locator('#restore-file').setInputFiles({ name: 'router-recovery.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(envelope)) });
  await restoredPage.locator('#restore-password').fill('synthetic browser recovery password');
  await restoredPage.locator('#restore-account button').click();
  await restoredPage.locator('#rules').waitFor();
  assert.equal(await restoredPage.evaluate(() => localStorage.getItem('router_key')), recovered.routerKey);
  assert.equal(await restoredPage.evaluate(privateKey => JSON.stringify(localStorage).includes(privateKey), recovered.tinycloudKey), false);
  await restoredContext.close();

  // A person with no invitation sets up on the same page: account, recovery file, posting rules, done.
  const soloContext = await newContext({ acceptDownloads: true });
  await soloContext.route('**/api/tinycloud/status', route => route.fulfill({ json: { linked: false } }));
  const soloPage = await soloContext.newPage();
  soloPage.on('pageerror', error => errors.push(error.message));
  const soloLoads = []; soloPage.on('request', r => soloLoads.push(new URL(r.url()).pathname));
  // /join is the guided setup. Arriving from another page keeps the way back for the end.
  await soloPage.goto(base + '/join?next=' + encodeURIComponent('/?view=channel&id=open-club'));
  await soloPage.locator('#create-account').waitFor();
  assert.equal(await soloPage.locator('#step-discord').isVisible(), false);
  assert.equal(await soloPage.locator('#create-submit').textContent(), 'Create account');
  await soloPage.locator('#handle').fill('local_solo');
  await soloPage.locator('#create-submit').click();
  await soloPage.locator('#storage-new').waitFor();
  assert.equal(await soloPage.locator('#skip-note').isVisible(), true);
  await soloPage.locator('#backup-password').fill('synthetic solo recovery password');
  await soloPage.locator('#backup-repeat').fill('synthetic solo recovery password');
  const soloDownload = soloPage.waitForEvent('download');
  await soloPage.locator('#prepare-backup button').click();
  assert.equal((await soloDownload).suggestedFilename(), 'router-local_solo-recovery.json');
  await soloPage.locator('#storage-connect').waitFor();
  // The storage library is fetched only when someone connects storage.
  assert.equal(soloLoads.some(path => /\/onboarding-assets\/chunks\/storage-/.test(path)), false);
  await soloPage.locator('#skip-storage').click();
  await soloPage.locator('#choose-rules[href]').waitFor();
  assert.equal(await soloPage.locator('#choose-rules').getAttribute('href'), '/posting-rules?onboarding=1');
  await soloPage.locator('#choose-rules').click();
  await soloPage.locator('input[name=mode][value=manual]').check();
  await soloPage.locator('input[name=audience][value=ask]').check();
  await soloPage.locator('#preview').click();
  await soloPage.locator('#confirmed').check();
  await soloPage.locator('#save').click();
  await soloPage.locator('#status').filter({ hasText: 'Saved' }).waitFor();
  await soloPage.getByRole('link', { name: 'Continue setup' }).click();
  // The last step before the finish is connecting an agent: the plugin commands, and the key copied separately.
  await soloPage.locator('#connect').waitFor();
  assert.equal(await soloPage.locator('#step-connect').getAttribute('aria-current'), 'step');
  assert.match(await soloPage.locator('#plugin-commands').textContent(), /\/plugin install teleport-router@teleport-router/);
  const soloKey = await soloPage.evaluate(() => localStorage.getItem('router_key'));
  assert.equal((await soloPage.locator('body').innerText()).includes(soloKey), false, 'The Router key is not printed on the page');
  await soloContext.grantPermissions(['clipboard-read', 'clipboard-write']);
  await soloPage.locator('#copy-key').click();
  await soloPage.locator('#copy-state').filter({ hasText: 'Router key copied' }).waitFor();
  assert.equal(await soloPage.evaluate(() => navigator.clipboard.readText()), soloKey);
  await soloPage.locator('#connect-later').click();
  await soloPage.locator('#ready').waitFor();
  await soloPage.locator('#back').click();
  await soloPage.locator('#connect').waitFor();
  await soloPage.locator('#connect-next').click();
  await soloPage.locator('#ready').waitFor();
  assert.equal(await soloPage.locator('#read-group').getAttribute('href'), '/?view=channel&id=open-club');
  assert.equal(await soloPage.locator('#read-group').textContent(), 'Continue where you were');
  assert.match(await soloPage.locator('#ready-state').textContent(), /Your recovery file is saved/);
  assert.equal(await soloPage.locator('#step-discord').isVisible(), false);
  // Someone already signed in who is sent to /join?next= goes straight on; an unsafe path is ignored.
  await soloPage.goto(base + '/join?next=' + encodeURIComponent('/posting-rules'));
  await soloPage.waitForURL('**/posting-rules');
  await soloPage.goto(base + '/join?next=' + encodeURIComponent('//evil.example'));
  await soloPage.locator('#storage-unlock').waitFor();
  assert.equal(new URL(soloPage.url()).origin, base);
  // An old invitation link, with the token under an older name, opens the same guided setup.
  const oldLink = await newContext();
  const oldPage = await oldLink.newPage();
  oldPage.on('pageerror', error => errors.push(error.message));
  await oldPage.goto(base + '/join?code=' + encodeURIComponent(token));
  await oldPage.locator('#group-name').filter({ hasText: 'Reading club' }).waitFor();
  assert.equal(await oldPage.locator('#create-account').isVisible(), true);
  await oldLink.close();
  // Coming back signed in goes on from the storage step, not to a dead end.
  await soloPage.goto(base + '/group-setup');
  await soloPage.locator('#storage-unlock').waitFor();
  await soloContext.close();
  assert.deepEqual(errors, []);
  console.log('PASS: setup without an invitation; fresh join; encrypted browser backup/reload; fresh-browser recovery; deferred storage; no owner-key transmission; unsaved draft; exact wording; stricter mode; returning member; mobile layout; removed-member recovery; public-group review; failed-join retry. Storage availability and Discord are local fixtures; real storage is a separate check. No page errors.');
} finally {
  await browser?.close();
  child.kill();
}
