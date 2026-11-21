// Checks the runner's hard stop around the app sandbox with hostile apps, timing each one.
// Run after `npm run build`:  node scripts/trace-app-sandbox-check.mjs
// Each line says whether the engine's own limit caught the app or the worker had to be killed.
import { APP_LIMITS } from '../dist/trace-app.js';
import { workerExecutor } from '../dist/trace-run.js';

const execute = workerExecutor(new URL('../dist/trace-app.js', import.meta.url).href);
const limits = { ...APP_LIMITS, timeMs: 1000 };
const cases = [
  ['endless loop', 'function analyze() { for (;;) {} }'],
  ['catastrophic regular expression', 'function analyze() { return String(/^(a+)+$/.test("a".repeat(40) + "b")) }'],
  ['memory bomb', 'function analyze() { const a = []; for (;;) a.push(new Array(1e6).fill(1)) }'],
  ['huge string', 'function analyze() { let s = "x"; for (;;) s += s; }'],
  ['deep recursion', 'function analyze() { return analyze() }'],
  ['sort with a hostile comparator', 'function analyze() { const a = Array.from({length: 1e6}, (_, i) => i); a.sort(() => { for (;;) {} }); return "" }'],
  ['well-behaved', 'function analyze(t) { return "lines: " + t.split("\\n").length }'],
];
let failed = false;
for (const [name, code] of cases) {
  const started = Date.now();
  const r = await execute({ runtime: 'quickjs-wasm/v1', code, purpose: '' }, 'a\nb', { entry_id: 'check', bytes: 3 }, limits);
  const ms = Date.now() - started;
  const ok = name === 'well-behaved' ? r.ok === true : r.ok === false && ms < limits.timeMs + 4000;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(32)} ${String(ms).padStart(5)} ms  ${r.ok ? 'answer: ' + r.answer : r.error}`);
}
process.exitCode = failed ? 1 : 0;
