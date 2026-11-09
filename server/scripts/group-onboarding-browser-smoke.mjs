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
  await page.locator('#invite-channel-name').filter({ hasText: 'Reading club' }).waitFor();
  assert.equal(await page.locator('#join-form').isVisible(), true);
  await page.locator('#handle').fill('local_reader');
  await page.locator('#submit-btn:enabled').waitFor();
  await page.locator('#submit-btn').click();
  await page.locator('#success-state h2').filter({ hasText: "You're in #reading-club" }).waitFor();
  await page.locator('#step-connect-next-btn').click();
  assert.match(await page.locator('#posting-rules-link').getAttribute('href'), /group=reading-club/);
  await page.locator('#posting-rules-link').click();
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
  await page.waitForURL('**/posting-rules?group=reading-club');
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
  await publicContext.close();

  // Retry a failed join without creating another account or falling into public setup.
  const second = await newContext({ viewport: { width: 390, height: 844 } });
  const failure = await second.newPage();
  await failure.goto(inviteUrl);
  await failure.locator('#invite-channel-name').waitFor();
  await failure.route('**/api/channels/reading-club/join', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic unavailable"}' }));
  await failure.locator('#handle').fill('local_retry');
  await failure.locator('#submit-btn:enabled').waitFor();
  await failure.locator('#submit-btn').click();
  await failure.locator('#join-error').waitFor();
  assert.equal(await failure.locator('#join-form').isVisible(), false);
  assert.equal(await failure.locator('#retry-join').isVisible(), true);
  assert.equal(await failure.evaluate(() => !!localStorage.getItem('router_key')), true);
  await failure.unroute('**/api/channels/reading-club/join');
  await failure.locator('#retry-join').click();
  await failure.waitForURL('**/posting-rules?group=reading-club');
  await failure.locator('#group-start').waitFor();
  await second.close();
  assert.deepEqual(errors, []);
  console.log('PASS: fresh join; unsaved draft; exact wording; stricter mode; returning member; mobile layout; removed-member recovery; public-group review; failed-join retry. No page errors.');
} finally {
  await browser?.close();
  child.kill();
}
