import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gatewayReleases, plan, readListed, report, wantedReleases, writeListed } from './redpill-releases.mjs';

const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64), D = 'd'.repeat(64);
const rel = (tag_name, prerelease = false, extra = {}) => ({ tag_name, prerelease, assets: [], ...extra });
const published = [
  rel('desktop-v0.10.0-beta.1', true), rel('gateway-prod-2026-11-05'), rel('gateway-prod-2026-11-23'),
  rel('gateway-prod-2026-11-21'), rel('gateway-prod-2026-11-05-2'), rel('clients-v0.11.1'),
];

test('orders gateway releases by the date and suffix in the tag, and ignores everything else', () => {
  assert.deepEqual(gatewayReleases([...published, rel('gateway-prod-2026-12-01', false, { draft: true }), rel('gateway-prod-2026-13-01; rm -rf'), rel('gateway-staging-2026-12-01'), null]).map(r => r.tag),
    ['gateway-prod-2026-11-23', 'gateway-prod-2026-11-21', 'gateway-prod-2026-11-05-2', 'gateway-prod-2026-11-05']);
});

test('wants the announced releases, the current one and the one before it', () => {
  assert.deepEqual(wantedReleases(published).map(r => [r.tag, r.role]), [['gateway-prod-2026-11-23', 'current'], ['gateway-prod-2026-11-21', 'previous']]);
  assert.deepEqual(wantedReleases([...published, rel('gateway-prod-2026-11-28', true)]).map(r => [r.tag, r.role]),
    [['gateway-prod-2026-11-28', 'scheduled'], ['gateway-prod-2026-11-23', 'current'], ['gateway-prod-2026-11-21', 'previous']]);
  assert.deepEqual(wantedReleases([rel('gateway-prod-2026-11-23')]).map(r => r.role), ['current']);
  assert.throws(() => wantedReleases([rel('gateway-prod-2026-11-28', true)]), /No current gateway release/);
});

test('the release before the current one is a full release, never an unpromoted prerelease', () => {
  const mixed = [rel('gateway-prod-2026-11-23'), rel('gateway-prod-2026-11-22', true), rel('gateway-prod-2026-11-21')];
  assert.deepEqual(wantedReleases(mixed).map(r => [r.tag, r.role]), [['gateway-prod-2026-11-23', 'current'], ['gateway-prod-2026-11-21', 'previous']]);
});

const scheduled = (onChain, hash = C) => ({ tag: 't3', role: 'scheduled', hash, onChain });
const current = { tag: 't2', role: 'current', hash: B, onChain: true }, previous = { tag: 't1', role: 'previous', hash: A, onChain: true };

test('plans one change per release: add the announced one, drop the oldest', () => {
  assert.deepEqual(plan([B, A], [scheduled(true), current, previous]), { next: [C, B, A], add: [C], drop: [], problems: [], waiting: [], change: true });
  assert.equal(plan([C, B, A], [scheduled(true), current, previous]).change, false);
  assert.deepEqual(plan([B, A, D], [current, previous]), { next: [B, A], add: [], drop: [D], problems: [], waiting: [], change: true });
});

test('adds a hash only when the app contract allows it', () => {
  // Announced but not allowed yet: it waits, and nothing changes.
  assert.deepEqual(plan([B, A], [scheduled(false), current, previous]), { next: [B, A], add: [], drop: [], problems: [], waiting: ['t3'], change: false });
  // The chain did not answer: say so, and change nothing.
  const unknown = plan([B, A], [scheduled(null), current, previous]);
  assert.equal(unknown.change, false);
  assert.match(unknown.problems[0], /t3: the app contract could not be asked/);
  // A hash already in the list stays while the chain cannot be asked.
  assert.deepEqual(plan([B, A], [{ ...current, onChain: null }, { ...previous, onChain: null }]), { next: [B, A], add: [], drop: [], problems: [], waiting: [], change: false });
  // A rolled-out release the contract does not allow is a problem, listed or not.
  assert.match(plan([A], [{ ...current, onChain: false }, previous]).problems[0], /does not allow its hash, though/);
  assert.match(plan([B, A], [{ ...current, onChain: false }, previous]).problems[0], /no longer allows its hash/);
});

test('leaves the list alone when a release does not check out', () => {
  const noHash = plan([B, A], [{ tag: 't3', role: 'scheduled', problem: 'no app_compose.json' }, current, previous]);
  assert.equal(noHash.change, false);
  assert.match(noHash.problems[0], /t3: no usable hash \(no app_compose.json\)/);
});

test('removes nothing unless the release before the current one was found', () => {
  assert.deepEqual(plan([B, A, D], [current]), { next: [B, A, D], add: [], drop: [], problems: [], waiting: [], change: false });
  assert.deepEqual(plan([A, D], [current]).next, [B, A, D]);
});

test('refuses a list the runner spec has no room for', () => {
  const many = Array.from({ length: 63 }, (_, i) => i.toString(16).padStart(64, 'e'));
  const full = plan(many, [current]);
  assert.equal(full.change, false);
  assert.match(full.problems[0], /would hold 64 hashes/);
});

test('rewrites only the value in the runner spec', () => {
  const text = `{\r\n  "env": {\r\n    "NODE_ENV": "production",\r\n    "REDPILL_RELEASES": "${A}"\r\n  },\r\n  "user": "node"\r\n}\r\n`;
  const out = writeListed(text, [B, A]);
  assert.deepEqual(readListed(out), [B, A]);
  assert.equal(out, text.replace(A, `${B},${A}`));
  assert.throws(() => writeListed('{"env":{}}', [A]), /Could not rewrite/);
});

test('the report carries tags and hashes only', () => {
  const wanted = [{ tag: 'gateway-prod-2026-11-23', role: 'current', hash: B, onChain: true }, { tag: 'gateway-prod-2026-11-21', role: 'previous', hash: A, onChain: null }];
  const text = report([A], wanted, plan([A], wanted));
  assert.match(text, /\| \[gateway-prod-2026-11-23\]\(https:\/\/github\.com\/Dstack-TEE\/private-ai-gateway\/releases\/tag\/gateway-prod-2026-11-23\) \| current \| `b{64}` \| allowed \| no \|/);
  assert.match(text, /could not be checked \| yes \|/);
  assert.match(text, /Adds 1, removes 0\./);
  const held = [{ tag: 'gateway-prod-2026-11-28', role: 'scheduled', hash: C, onChain: false }, ...wanted];
  assert.match(report([B, A], held, plan([B, A], held)), /gateway-prod-2026-11-28 is announced, but the app contract does not allow its hash yet/);
});
