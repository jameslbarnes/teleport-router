/** A hostile account's writing must never run in a reader's browser. Real pages, isolated in-memory server. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const reservation = createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise(r => reservation.close(r));
const base = `http://127.0.0.1:${port}`;
const cwd = fileURLToPath(new URL('..', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], { cwd, env: {
  ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', MODERATOR_HANDLES: 'moderator_x',
  TINYCLOUD_GROUPS: '', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '', ANTHROPIC_API_KEY: '',
}, stdio: ['ignore', 'ignore', 'pipe'] });
let serverError = ''; child.stderr.on('data', d => { serverError = (serverError + d).slice(-2000); });
const call = async (path, body, key) => {
  const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, headers: response.headers, body: await response.json().catch(() => null) };
};
const ok = async (...args) => { const r = await call(...args); assert.ok(r.status < 300, `${args[0]}: ${r.status} ${JSON.stringify(r.body)}`); return r.body; };

// Every payload sets window.__xss if it runs.
const run = "window.__xss=(window.__xss||0)+1";
const html = `<img src=x onerror="${run}"><script>${run}</script><svg onload="${run}"></svg><iframe srcdoc="<script>parent.${run}</script>"></iframe>` +
  `<a href="javascript:${run}" id="js-link">raw link</a> [markdown link](javascript:${run}) <form action="https://evil.example"><input name=router_key></form><style>body{display:none}</style>`;
const longNote = `**Marker heading** for a long note.\n\n${html}\n\n` + 'Filler sentence to make this a long note. '.repeat(15);
const attribute = `x" onmouseover="${run}" style="position:fixed;inset:0" a="`;

let browser;
try {
  let ready = false;
  for (let i = 0; i < 300; i++) { try { await ok('/health'); ready = true; break; } catch {} await new Promise(r => setTimeout(r, 300)); } // up to 90 s on a busy machine
  if (!ready) throw Error('Local fixture failed: ' + serverError);
  const attacker = randomBytes(32).toString('base64url'), victim = randomBytes(32).toString('base64url');
  await ok('/api/identity/register', { secret_key: attacker, handle: 'mallory' });
  await ok('/api/identity/register', { secret_key: victim, handle: 'reader_one' });

  // Hostile profile: links are refused outright; name and bio are stored but must be shown as text.
  for (const links of [[`javascript:${run}`], [attribute], ['https://ok.example/"onmouseover="x'], 'https://ok.example', Array(11).fill('https://ok.example')]) {
    assert.equal((await call('/api/identity/update', { secret_key: attacker, links })).status, 400, 'hostile or malformed profile links are refused');
  }
  await ok('/api/identity/update', { secret_key: attacker, links: ['https://ok.example/page'], displayName: `<img src=x onerror="${run}">`, bio: `</textarea><img src=x onerror="${run}">` });
  await ok('/api/follow', { secret_key: victim, handle: 'mallory' });

  // Hostile long note (rendered as markdown) and short note (dashboard preview), both public.
  const posted = await ok('/api/entries', { secret_key: attacker, content: longNote });
  const short = await ok('/api/entries', { secret_key: attacker, content: `<img src=x onerror="${run}">` });
  const idOf = entry => entry.id || entry.entry?.id || entry.entry_id || entry.receipt?.entry_id || entry.sharing_receipt?.entry_id;
  const publish = async entry => {
    const receipt = [entry, entry.receipt, entry.sharing_receipt, entry.sharing].find(r => r?.notice_id);
    const id = idOf(entry) || receipt?.entry_id; assert.ok(id, 'entry id returned: ' + JSON.stringify(entry).slice(0, 300));
    // The author's own agent reports its notice, as an attacker's would, then publishes at once.
    if (receipt) await ok(`/api/entries/${id}/notice`, { notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256, conversation_ref: 'local-test:message', evidence_kind: 'agent_reported' }, attacker);
    await ok(`/api/entries/${id}/publish`, {}, attacker);
    return id;
  };
  const postedId = await publish(posted); await publish(short);
  await publish(await ok('/api/entries', { secret_key: attacker, content: longNote, inReplyTo: postedId }));

  // Digest triggers send email and spend model calls: no anonymous or ordinary-member use.
  assert.equal((await call('/api/trigger-digest', {})).status, 403);
  assert.equal((await call('/api/trigger-digest', {}, victim)).status, 403);
  assert.equal((await call('/api/test-digest?handle=mallory&preview=true', {})).status, 403);
  assert.equal((await call('/api/test-digest?handle=mallory&preview=true', {}, victim)).status, 403);
  assert.equal((await call('/health')).headers.get('x-content-type-options'), 'nosniff');

  browser = await chromium.launch({ headless: true, args: ['--disable-gpu'], ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ viewport: { width: 1160, height: 1000 } });
  const outside = [];
  // No page may need anything from another origin to render notes safely.
  await context.route('**/*', route => { const u = new URL(route.request().url());
    if (u.origin === base) return route.continue();
    if (route.request().resourceType() === 'script') outside.push(u.href);
    return route.abort(); });
  await context.addInitScript(key => { if (!localStorage.getItem('router_key')) localStorage.setItem('router_key', key); }, victim);
  const page = await context.newPage();
  const dialogs = []; page.on('dialog', d => { dialogs.push(d.message()); d.dismiss(); });

  const inspect = async label => {
    await page.waitForTimeout(700);
    const state = await page.evaluate(() => ({ ran: window.__xss || 0,
      handlers: [...document.querySelectorAll('.entry-content *, .reply-content *, .profile-links *, #following-list *, .user-preview *, .conversation *')]
        // The pages' own buttons carry handlers; only an attribute holding the hostile payload counts.
        .filter(el => [...el.attributes].some(a => a.value.includes('__xss') || /^\s*javascript:/i.test(a.value))).map(el => el.outerHTML.slice(0, 120)),
      forbidden: document.querySelectorAll('.entry-content script, .entry-content iframe, .entry-content form, .entry-content style, .entry-content svg[onload], .profile-links a:not([href^="http"])').length,
      key: localStorage.getItem('router_key') }));
    assert.equal(state.ran, 0, `${label}: hostile content executed`);
    assert.deepEqual(state.handlers, [], `${label}: event handlers or javascript: links survived`);
    assert.equal(state.forbidden, 0, `${label}: forbidden elements survived`);
    assert.equal(state.key, victim, `${label}: the reader's account key changed`);
  };

  await page.goto(base + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => [...document.querySelectorAll('.entry-content')].some(el => el.textContent.includes('Marker heading')), null, { timeout: 20000 });
  // Markdown still renders, through the sanitizer.
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('.entry-content.reflection strong')].some(el => el.textContent === 'Marker heading')), 'long notes still render markdown');
  assert.equal(await page.evaluate(() => typeof window.DOMPurify?.sanitize), 'function', 'the sanitizer is loaded from this site');
  await inspect('home feed');
  // Without the sanitizer the page shows plain text, never unsanitized HTML.
  assert.equal(await page.evaluate(() => { const saved = window.DOMPurify; window.DOMPurify = undefined;
    try { return window.routerMarkdown('<img src=x onerror=alert(1)>'); } finally { window.DOMPurify = saved; } }), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(await page.evaluate(() => window.routerMarkdown('[a](javascript:alert(1)) <b onclick="x()">b</b> **kept**').trim()), '<p><a>a</a> <b>b</b> <strong>kept</strong></p>');

  await page.goto(base + '/u/mallory', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('Marker heading'), null, { timeout: 20000 });
  assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.profile-links a')].map(a => a.getAttribute('href'))), ['https://ok.example/page']);
  await page.mouse.move(300, 300); await page.mouse.move(600, 500);
  await inspect('profile page');

  await page.goto(base + '/settings', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('@mallory'), null, { timeout: 20000 });
  assert.ok(await page.evaluate(() => document.body.innerText.includes('<img src=x')), 'a hostile display name is shown as text');
  await inspect('settings following list');

  await page.goto(base + '/dashboard', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('mallory'), null, { timeout: 20000 });
  await inspect('dashboard');

  // Older pages of one person's notes ("Show older") render through the same safe paths. The oldest note is hostile.
  const pager = randomBytes(32).toString('base64url');
  await ok('/api/identity/register', { secret_key: pager, handle: 'pager_x' });
  const publishAs = async (key, content, to) => {
    const entry = await ok('/api/entries', { secret_key: key, content, ...(to ? { to, posting_intent: 'user-requested' } : {}) });
    const receipt = [entry, entry.receipt, entry.sharing_receipt, entry.sharing].find(r => r?.notice_id);
    const id = idOf(entry) || receipt?.entry_id;
    if (receipt) await ok(`/api/entries/${id}/notice`, { notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256, conversation_ref: 'local-test:message', evidence_kind: 'agent_reported' }, key);
    await ok(`/api/entries/${id}/publish`, {}, key);
  };
  await publishAs(pager, `Oldest pager note <img src=x onerror="${run}">`);
  // Two private-group notes on the older pages, which the reader may see while a member.
  await ok('/api/channels', { secret_key: pager, id: 'pager-club', name: 'Pager club', visibility: 'private', join_rule: 'invite' });
  const pagerInvite = await ok('/api/channels/pager-club/invite', { secret_key: pager, max_uses: 1 });
  await ok('/api/channels/pager-club/join', { secret_key: victim, invite_token: pagerInvite.token });
  for (const n of [1, 2]) await publishAs(pager, `Private club note ${n}`, ['#pager-club']);
  for (let i = 1; i <= 104; i++) await publishAs(pager, `Pager note ${i}`);
  const olderVisible = () => page.evaluate(() => { const b = document.getElementById('show-older-btn');
    return !!b && !b.closest('[hidden]') && b.offsetParent !== null; });
  const hasOldest = () => page.evaluate(() => document.body.innerText.includes('Oldest pager note'));

  await page.goto(base + '/u/pager_x', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('Pager note 104'), null, { timeout: 20000 });
  assert.equal(await page.locator('.entry').count(), 100, 'the profile shows its first page of 100 notes');
  assert.equal(await olderVisible(), true, 'the profile offers older notes');
  assert.equal(await hasOldest(), false);
  await page.click('#show-older-btn');
  await page.waitForFunction(() => document.body.innerText.includes('Oldest pager note'), null, { timeout: 20000 });
  assert.equal(await page.locator('.entry').count(), 105, 'Show older adds the remaining notes once each');
  assert.equal(await olderVisible(), false, 'no Show older after the last page');
  await inspect('profile page, older notes');

  // The one-person feed reads as the reader only when the link carries their key (the same key, so no prompt).
  const hasPrivate = () => page.evaluate(() => document.body.innerText.includes('Private club note'));
  await page.goto(base + '/?pseudonym=pager_x&key=' + victim, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.body.innerText.includes('Pager note 104'), null, { timeout: 20000 });
  assert.equal(await page.locator('#feed .entry').count(), 50, 'the one-person feed shows its first page of 50 notes');
  for (const expected of [100, 107]) {
    assert.equal(await olderVisible(), true, 'the one-person feed offers older notes');
    await page.click('#show-older-btn');
    await page.waitForFunction(n => document.querySelectorAll('#feed .entry').length === n, expected, { timeout: 20000 });
  }
  assert.equal(await hasOldest(), true);
  assert.equal(await hasPrivate(), true, 'a member sees the group notes on older pages');
  assert.equal(await olderVisible(), false, 'no Show older after the last page');
  await inspect('one-person feed, older notes');
  // Removed from the group, the reader's next refresh starts again from the newest page: no private notes stay.
  await ok('/api/channels/pager-club/remove-member', { handle: 'reader_one' }, pager);
  await page.evaluate(() => loadFeed(true));
  await page.waitForFunction(() => document.querySelectorAll('#feed .entry').length === 50, null, { timeout: 20000 });
  assert.equal(await hasPrivate(), false, 'private notes are gone after a refresh');
  assert.equal(await hasOldest(), false, 'older pages are dropped on refresh');
  for (const expected of [100, 105]) {
    await page.click('#show-older-btn');
    await page.waitForFunction(n => document.querySelectorAll('#feed .entry').length === n, expected, { timeout: 20000 });
  }
  assert.equal(await hasPrivate(), false, 'older pages no longer hold the private notes');

  // A link carrying someone else's key must not silently replace the signed-in account.
  await page.goto(base + '/?key=' + attacker, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  assert.equal(dialogs.length, 1, 'the reader is asked before another account replaces theirs');
  assert.equal(await page.evaluate(() => localStorage.getItem('router_key')), victim, 'declining keeps the current account');
  assert.equal(new URL(page.url()).searchParams.has('key'), false, 'the key is removed from the address bar');

  // Leaving signup can only go to a path on this site. A signed-out visitor stays on the page, so read its own check.
  const visitor = await (await browser.newContext()).newPage();
  const nextPath = async next => {
    await visitor.goto(base + '/join?next=' + encodeURIComponent(next), { waitUntil: 'domcontentloaded' });
    return visitor.evaluate(() => getSafeNextPath());
  };
  for (const next of ['/.//evil.example', '//evil.example', '/' + String.fromCharCode(92) + 'evil.example', 'https://evil.example/', 'javascript:alert(1)']) {
    assert.equal(await nextPath(next), null, 'unsafe next path refused: ' + next);
  }
  assert.equal(await nextPath('/?view=channel&id=reading-club'), '/?view=channel&id=reading-club');

  assert.deepEqual(outside, [], 'pages requested scripts from another origin');
  console.log('PASS: hostile notes, profile fields and links do not execute on the feed, profile, settings or dashboard pages; markdown still renders; no third-party scripts; account-key replacement asks first; digest triggers need sign-in.');
} finally {
  await browser?.close();
  child.kill();
}
