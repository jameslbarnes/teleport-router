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

test('plans one change per release: add the announced one, drop the oldest', () => {
  const wanted = [{ tag: 't3', role: 'scheduled', hash: C, onChain: false }, { tag: 't2', role: 'current', hash: B, onChain: true }, { tag: 't1', role: 'previous', hash: A, onChain: true }];
  assert.deepEqual(plan([B, A], wanted), { next: [C, B, A], add: [C], drop: [], problems: [], change: true });
  assert.deepEqual(plan([C, B, A], wanted).change, false);
  assert.deepEqual(plan([B, A, D], wanted.slice(1)), { next: [B, A], add: [], drop: [D], problems: [], change: true });
});

test('leaves the list alone when a release does not check out', () => {
  const current = { tag: 't2', role: 'current', hash: B, onChain: true };
  const noHash = plan([B], [{ tag: 't3', role: 'scheduled', problem: 'no app_compose.json' }, current]);
  assert.equal(noHash.change, false);
  assert.match(noHash.problems[0], /t3: no usable hash \(no app_compose.json\)/);
  const offChain = plan([A], [{ ...current, onChain: false }]);
  assert.equal(offChain.change, false);
  assert.match(offChain.problems[0], /does not allow its hash/);
  // The chain not answering is reported, not treated as a refusal.
  assert.equal(plan([A], [{ ...current, onChain: null }]).change, true);
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
});
