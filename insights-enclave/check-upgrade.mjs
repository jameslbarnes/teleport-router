// The mechanical check on a proposed update to the insights enclave. It compares two commits and says,
// by comparing text and nothing else, what kind of change the update is. No model reads anything, so
// nothing written in the code under review can talk this check round.
//
//   node insights-enclave/check-upgrade.mjs --from <approved commit> --to <proposed commit> [--json]
//
// Verdicts, and the exit code:
//   0   nothing-changed   the enclave is built from the same text as before
//   10  words-only        only the program's words changed (server/src/insights-spec.ts): the questions, the
//                         instructions to the model or the allowed answers. The change is printed in full.
//                         The program's hash changes, so every owner signs a new consent before it is used.
//   20  needs-a-person    code, dependencies, the image recipe, the gate or the network layout changed.
//                         Someone has to read it; an agent holding a cancel key should cancel the update
//                         unless its owner has said this one is fine.
//
// This says what changed between two commits. It does not prove that the image on offer was built from the
// proposed commit: for that, build it again (insights-enclave/Dockerfile) and compare digests.
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const WATCHED = {
  words: ['server/src/insights-spec.ts'],
  code: ['server/src/author-records.ts', 'server/src/insights-enclave-server.ts', 'server/src/insights-enclave.ts', 'server/src/insights-program.ts',
    'server/src/trace-envelope.ts', 'server/scripts/bundle-insights-enclave.mjs'],
  dependencies: ['server/package.json', 'server/package-lock.json'],
  image: ['insights-enclave/Dockerfile'],
  gate: ['insights-enclave/gate.mjs', 'insights-enclave/embed.mjs'],
  compose: ['docker-compose.insights-enclave.yml'],
};
const lf = text => text.replace(/\r\n/g, '\n');

function gitShow(repo, ref, path) {
  try { return lf(execFileSync('git', ['-C', repo, 'show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { return null; }   // the file does not exist at that commit
}
const embeddedGate = compose => { const m = /import\('data:text\/javascript;base64,([A-Za-z0-9+/=]+)'\)/.exec(compose || ''); return m ? Buffer.from(m[1], 'base64').toString('utf8') : null; };
const pins = text => (text || '').match(/@sha256:[0-9a-f]{64}/g) || [];

/** A plain line diff, enough to show a short file's change in full. */
export function lineDiff(before, after) {
  const a = (before ?? '').split('\n'), b = (after ?? '').split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; }
    else if (i < a.length && (j === b.length || lcs[i + 1][j] >= lcs[i][j + 1])) out.push('- ' + a[i++]);
    else out.push('+ ' + b[j++]);
  }
  return out;
}

export function checkUpgrade({ repo = '.', from, to, read = gitShow }) {
  const at = (ref, path) => read(repo, ref, path);
  const changed = {};
  for (const [kind, paths] of Object.entries(WATCHED)) changed[kind] = paths.filter(p => at(from, p) !== at(to, p));
  const compose = at(to, WATCHED.compose[0]), gate = at(to, 'insights-enclave/gate.mjs');
  const problems = [];
  // Whatever else is true, the proposed commit must be consistent with itself.
  if (compose === null || gate === null) problems.push('the proposed commit has no enclave compose file or no gate');
  else {
    if (embeddedGate(compose) !== gate) problems.push('the compose file does not carry the gate program that is in the repository');
    const program = compose.slice(compose.indexOf('  insights-enclave:'), compose.indexOf('  # BEGIN gate'));
    if (!/networks:\n      - sealed\n/.test(program) || /- default|ports:|ANTHROPIC_API_KEY|network_mode|extra_hosts|privileged|cap_add|docker\.sock/.test(program))
      problems.push('the enclave program is no longer confined to the sealed network');
    if (!/\n  sealed:\n    internal: true\n/.test(compose)) problems.push('the sealed network is no longer internal');
  }
  const checks = [
    { name: 'The gate (the only way out) is unchanged', ok: !changed.gate.length },
    { name: 'The network layout and settings in the compose file are unchanged', ok: !changed.compose.length },
    { name: 'The base images are pinned to the same digests', ok: JSON.stringify(pins(at(from, WATCHED.image[0]))) === JSON.stringify(pins(at(to, WATCHED.image[0]))) && pins(at(to, WATCHED.image[0])).length >= 2 },
    { name: 'The image recipe is unchanged', ok: !changed.image.length },
    { name: 'The program\'s code is unchanged', ok: !changed.code.length },
    { name: 'The locked dependencies are unchanged', ok: !changed.dependencies.length },
    { name: 'The proposed commit is consistent with itself', ok: !problems.length },
    { name: 'The program\'s words (questions, instructions, answers) are unchanged', ok: !changed.words.length },
  ];
  const beyondWords = checks.slice(0, 7).some(c => !c.ok);
  const verdict = beyondWords ? 'needs-a-person' : changed.words.length ? 'words-only' : 'nothing-changed';
  return { from, to, verdict, exitCode: { 'nothing-changed': 0, 'words-only': 10, 'needs-a-person': 20 }[verdict], checks, changed, problems,
    wordsDiff: changed.words.length ? lineDiff(at(from, WATCHED.words[0]), at(to, WATCHED.words[0])) : [] };
}

export function report(r) {
  const lines = [`Insights enclave update check: ${r.from} → ${r.to}`, '', `Verdict: ${r.verdict}`, ''];
  for (const c of r.checks) lines.push(`${c.ok ? '  same   ' : '  CHANGED'}  ${c.name}`);
  const files = Object.values(r.changed).flat();
  if (files.length) lines.push('', 'Files that differ:', ...files.map(f => `  ${f}`));
  if (r.problems.length) lines.push('', 'Problems:', ...r.problems.map(p => `  ${p}`));
  if (r.wordsDiff.length) lines.push('', 'The change to the program\'s words, in full:', ...r.wordsDiff.map(l => `  ${l}`));
  lines.push('', {
    'nothing-changed': 'The enclave would be built from the same text as the approved version.',
    'words-only': 'Only the words changed. Read them above. The program hash changes, so each owner signs a new consent before these words are used on their traces.',
    'needs-a-person': 'This is more than a change of words, so comparing text cannot clear it. A person has to read the difference before the wait ends; without that, cancel.',
  }[r.verdict]);
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
  const from = arg('--from'), to = arg('--to');
  if (!from || !to) { console.error('usage: node insights-enclave/check-upgrade.mjs --from <approved commit> --to <proposed commit> [--repo <path>] [--json]'); process.exit(2); }
  const r = checkUpgrade({ repo: arg('--repo') || '.', from, to });
  console.log(process.argv.includes('--json') ? JSON.stringify(r, null, 2) : report(r));
  process.exit(r.exitCode);
}
