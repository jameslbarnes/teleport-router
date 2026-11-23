import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_LIMITS, APP_RUNTIME, appHash, checkApp, checkAppParses, runApp, runAppStep } from './trace-app.js';
import { MODEL_LIMITS } from './trace-model.js';
import { canonicalJson } from './trace-run.js';

const app = (code: string) => ({ runtime: APP_RUNTIME, code, purpose: 'test' } as const);
const info = { entry_id: 'a-note', bytes: 10 };
const quick = { ...APP_LIMITS, timeMs: 300, memoryBytes: 16 * 1024 * 1024 };

describe('trace apps: what a request may carry', () => {
  it('accepts code with a one-line purpose and refuses anything else', () => {
    expect(checkApp({ code: 'function analyze(t){return t}', purpose: '  Count tool calls  ' })).toEqual({ runtime: APP_RUNTIME, code: 'function analyze(t){return t}', purpose: 'Count tool calls' });
    for (const bad of [undefined, null, 'code', [], {}, { code: 'x' }, { purpose: 'p' }, { code: '', purpose: 'p' }, { code: 'x', purpose: '' },
      { code: 'x', purpose: 'p', extra: 1 }, { code: 'x', purpose: 'p', runtime: 'node' }, { code: 'x', purpose: 'two\nlines' },
      { code: 'x', purpose: 'p'.repeat(APP_LIMITS.purposeChars + 1) }, { code: 'x'.repeat(APP_LIMITS.codeBytes + 1), purpose: 'p' },
      { code: 'a\u0000b', purpose: 'p' }, { code: 'lone \ud800 surrogate', purpose: 'p' }])
      expect(() => checkApp(bad)).toThrow();
  });
  it('hashes the code and runtime as canonical JSON, and not the purpose', () => {
    const code = 'function analyze(t) { return "é\\n" + t.length }';
    const expected = createHash('sha256').update(canonicalJson({ runtime: APP_RUNTIME, code })).digest('hex');
    expect(appHash({ code, runtime: APP_RUNTIME })).toBe(expected);
    expect(appHash(checkApp({ code, purpose: 'one' }))).toBe(appHash(checkApp({ code, purpose: 'another' })));
    expect(appHash({ code: code + ' ', runtime: APP_RUNTIME })).not.toBe(expected);
  });
  it('refuses code that does not parse, without running code that does', async () => {
    await expect(checkAppParses('function analyze( {')).rejects.toThrow('does not parse');
    await checkAppParses('globalThis.__traceAppRan = true; function analyze(t) { return t }');
    expect((globalThis as any).__traceAppRan).toBeUndefined();
  });
});

describe('trace apps: the sandbox', () => {
  it('passes the trace and its details and returns the answer', async () => {
    const r = await runApp(app('function analyze(trace, info) { return info.entry_id + ":" + info.bytes + ":" + trace.split("\\n").length }'), 'a\nb\nc', info);
    expect(r).toEqual({ ok: true, answer: 'a-note:10:3' });
  });
  it('gives the app nothing to reach outside with', async () => {
    const probe = `function analyze() {
      const names = ['require', 'process', 'fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval', 'std', 'os', 'Deno', 'Bun', 'module', '__dirname'];
      const seen = {};
      for (const n of names) seen[n] = typeof globalThis[n];
      seen.viaFunction = typeof (new Function('return this'))().process;
      seen.constructorEscape = ({}).constructor.constructor('return typeof process')();
      return JSON.stringify(seen);
    }`;
    const r = await runApp(app(probe), '', info);
    expect(r.ok).toBe(true);
    const seen = JSON.parse((r as any).answer);
    expect(Object.keys(seen)).toHaveLength(15);
    for (const [k, v] of Object.entries(seen)) expect([k, v]).toEqual([k, 'undefined']);
    expect(await runApp(app('function analyze() { return (new Function("return typeof process"))() }'), '', info)).toEqual({ ok: true, answer: 'undefined' });
    const imported = await runApp(app('function analyze() { import("node:fs"); return "no" }'), '', info);
    expect(imported.ok === false || (imported as any).answer === 'no').toBe(true);
  });
  it('stops an app that runs too long, uses too much memory, recurses forever or returns too much', async () => {
    expect(await runApp(app('function analyze() { for (;;) {} }'), '', info, quick)).toEqual({ ok: false, error: 'The app ran out of time (0.3 seconds).' });
    // Arrays, not repeated strings: QuickJS shares the storage of concatenated strings, so those cost almost nothing.
    expect(await runApp(app('function analyze() { const a = []; for (;;) a.push(new Array(1e5).fill(1)) }'), '', info, { ...quick, timeMs: 8000 }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/out of memory|stopped the sandbox/) });
    expect(await runApp(app('function analyze() { return analyze() }'), '', info, quick)).toMatchObject({ ok: false });
    expect(await runApp(app('function analyze() { return "x".repeat(8193) }'), '', info)).toEqual({ ok: false, error: 'The answer must be at most 8 KB.' });
    expect(await runApp(app('function analyze(t) { return t }'), 'x'.repeat(1024), info, { ...APP_LIMITS, traceBytes: 1000 })).toMatchObject({ ok: false, error: expect.stringContaining('larger than') });
    // The engine is still usable after all that.
    expect(await runApp(app('function analyze() { return "ok" }'), '', info)).toEqual({ ok: true, answer: 'ok' });
    // Filling arrays until memory runs out takes a few seconds, more on a busy machine.
  }, 30_000);
  it('reports what the app got wrong, which only the owner will see', async () => {
    expect(await runApp(app('const x = 1'), '', info)).toEqual({ ok: false, error: 'The app must define function analyze(trace, info).' });
    expect(await runApp(app('function analyze() { return 42 }'), '', info)).toEqual({ ok: false, error: 'analyze must return a string.' });
    expect(await runApp(app('function analyze() { return Promise.resolve("x") }'), '', info)).toEqual({ ok: false, error: 'analyze must return a string.' });
    expect(await runApp(app('function analyze(t) { throw new Error("saw " + t) }'), 'secret', info)).toEqual({ ok: false, error: 'The app failed: Error: saw secret' });
  });
});

describe('trace apps: asking a model, one step at a time', () => {
  const asking = app(`function analyze(trace, info, replies) {
    if (replies.length < 2) return { ask: 'step ' + replies.length + ' of ' + trace.length + ' chars' + (replies.length ? ', after ' + replies[0] : '') };
    return 'done: ' + replies.join(' | ');
  }`);
  it('passes the replies so far and returns either a prompt or the answer', async () => {
    expect(await runAppStep(asking, 'abc', info, APP_LIMITS, [])).toEqual({ ask: 'step 0 of 3 chars' });
    expect(await runAppStep(asking, 'abc', info, APP_LIMITS, ['one'])).toEqual({ ask: 'step 1 of 3 chars, after one' });
    expect(await runAppStep(asking, 'abc', info, APP_LIMITS, ['one', 'two'])).toEqual({ ok: true, answer: 'done: one | two' });
    // An app written before model calls ignores the third argument and runs as before.
    expect(await runAppStep(app('function analyze(t, i) { return i.entry_id + t }'), 'x', info)).toEqual({ ok: true, answer: 'a-notex' });
  });
  it('fails an app that asks where no model was declared', async () => {
    expect(await runApp(asking, 'abc', info)).toEqual({ ok: false, error: 'The app asked for a model but declared none.' });
  });
  it('measures a prompt inside the sandbox and refuses one too large, empty or not plain text', async () => {
    const big = MODEL_LIMITS.promptBytes;
    expect(await runAppStep(app(`function analyze() { return { ask: 'x'.repeat(${big}) } }`), '', info)).toEqual({ ask: 'x'.repeat(big) });
    expect(await runAppStep(app(`function analyze() { return { ask: 'x'.repeat(${big + 1}) } }`), '', info)).toEqual({ ok: false, error: 'A prompt must be at most 256 KB.' });
    expect(await runAppStep(app(`function analyze() { return { ask: 'é'.repeat(${big / 2 + 1}) } }`), '', info)).toEqual({ ok: false, error: 'A prompt must be at most 256 KB.' });
    expect(await runAppStep(app('function analyze() { return { ask: "" } }'), '', info)).toEqual({ ok: false, error: 'A prompt must be non-empty plain text.' });
    expect(await runAppStep(app('function analyze() { return { ask: "lone \\ud800" } }'), '', info)).toEqual({ ok: false, error: 'A prompt must be non-empty plain text.' });
  });
  it('treats anything else as a wrong return, including a getter that throws', async () => {
    for (const code of ['function analyze() { return null }', 'function analyze() { return { ask: 42 } }', 'function analyze() { return { answer: "x" } }',
      'function analyze() { return { get ask() { throw new Error("secret") } } }', 'function analyze() { return ["x"] }'])
      expect(await runAppStep(app(code), '', info), code).toEqual({ ok: false, error: 'analyze must return a string.' });
    // A getter that never returns is stopped by the deadline like any other app code.
    expect(await runAppStep(app('function analyze() { return { get ask() { for (;;) {} } } }'), '', info, quick)).toEqual({ ok: false, error: 'The app ran out of time (0.3 seconds).' });
    // The engine is still usable after all that.
    expect(await runAppStep(app('function analyze() { return { ask: "ok" } }'), '', info)).toEqual({ ask: 'ok' });
  });
  it('refuses replies it was not meant to be given', async () => {
    for (const replies of [[1], Array(MODEL_LIMITS.calls + 1).fill('x'), ['x'.repeat(MODEL_LIMITS.replyBytes + 1)]] as any[])
      expect(await runAppStep(asking, '', info, APP_LIMITS, replies)).toEqual({ ok: false, error: 'The runner gave the app malformed replies.' });
  });
});
