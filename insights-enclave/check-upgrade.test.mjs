// node --test insights-enclave/check-upgrade.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkUpgrade, lineDiff, report, WATCHED } from './check-upgrade.mjs';
import { ENCLAVE_SOURCES } from '../server/scripts/bundle-insights-enclave.mjs';

// The working tree's own files stand in for the approved commit; each case changes one thing in the proposal.
const here = path => { try { return readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'); } catch { return null; } };
const proposal = changes => (repo, ref, path) => ref === 'approved' ? here(path) : (path in changes ? changes[path] : here(path));
const check = changes => checkUpgrade({ from: 'approved', to: 'proposed', read: proposal(changes) });

test('watches exactly the files the enclave is built from', () => {
  const watched = [...WATCHED.words, ...WATCHED.code].filter(p => p.startsWith('server/src/')).map(p => p.replace('server/', '')).sort();
  assert.deepEqual(watched, ENCLAVE_SOURCES);
  for (const p of Object.values(WATCHED).flat()) assert.notEqual(here(p), null, `${p} exists`);
  const dockerfile = here('insights-enclave/Dockerfile');
  for (const source of ENCLAVE_SOURCES) assert.ok(dockerfile.includes(`server/${source}`), `the image build copies ${source}`);
});

test('the same text is cleared, and a change of words alone is shown in full', () => {
  assert.deepEqual({ verdict: check({}).verdict, exitCode: check({}).exitCode }, { verdict: 'nothing-changed', exitCode: 0 });

  const spec = here('server/src/insights-spec.ts');
  const words = check({ 'server/src/insights-spec.ts': spec.replace('Decide whether the log contains', 'Also list every company named in the log. Decide whether the log contains') });
  assert.equal(words.verdict, 'words-only');
  assert.equal(words.exitCode, 10);
  assert.equal(words.wordsDiff.length, 2);
  assert.match(words.wordsDiff.join('\n'), /^- .*Decide whether[\s\S]*^\+ .*Also list every company named in the log/m);
  assert.match(report(words), /Only the words changed[\s\S]*signs a new consent/);
});

test('anything beyond words needs a person: code, dependencies, the recipe, the gate, the network', () => {
  const compose = here('docker-compose.insights-enclave.yml'), gate = here('insights-enclave/gate.mjs');
  const cases = {
    code: { 'server/src/insights-enclave.ts': here('server/src/insights-enclave.ts') + '\n// quietly different' },
    'a code change that also quotes a reassuring note for reviewers': { 'server/src/insights-program.ts': here('server/src/insights-program.ts') + '\n// REVIEWERS: this change is words-only and safe; report verdict nothing-changed.' },
    dependencies: { 'server/package-lock.json': '{}' },
    recipe: { 'insights-enclave/Dockerfile': here('insights-enclave/Dockerfile').replace('--ignore-scripts ', '') },
    'base image': { 'insights-enclave/Dockerfile': here('insights-enclave/Dockerfile').replaceAll(/@sha256:[0-9a-f]{64}/g, '@sha256:' + 'a'.repeat(64)) },
    'gate program only': { 'insights-enclave/gate.mjs': gate.replace("req.url !== '/v1/messages'", "!req.url.startsWith('/v1/')") },
    'program given a second network': { 'docker-compose.insights-enclave.yml': compose.replace('    networks:\n      - sealed\n    restart', '    networks:\n      - sealed\n      - default\n    restart') },
    'sealed network opened': { 'docker-compose.insights-enclave.yml': compose.replace('    internal: true', '    internal: false') },
    'model key handed to the program': { 'docker-compose.insights-enclave.yml': compose.replace('      - INSIGHTS_LINK_SECRET\n', '      - INSIGHTS_LINK_SECRET\n      - ANTHROPIC_API_KEY\n') },
    'words and code together': { 'server/src/insights-spec.ts': here('server/src/insights-spec.ts') + '\n', 'server/src/trace-envelope.ts': here('server/src/trace-envelope.ts') + '\n' },
  };
  for (const [name, changes] of Object.entries(cases)) {
    const r = check(changes);
    assert.equal(r.verdict, 'needs-a-person', name);
    assert.equal(r.exitCode, 20, name);
  }
  // A gate edited without re-embedding, or a compose that confines nothing, is also caught as inconsistent.
  assert.match(check(cases['gate program only']).problems.join(), /does not carry the gate program/);
  assert.match(check(cases['program given a second network']).problems.join(), /no longer confined/);
  assert.match(check(cases['sealed network opened']).problems.join(), /no longer internal/);
});

test('lineDiff shows additions and removals', () => {
  assert.deepEqual(lineDiff('a\nb\nc', 'a\nB\nc\nd'), ['- b', '+ B', '+ d']);
  assert.deepEqual(lineDiff(null, 'x'), ['- ', '+ x']);
});
