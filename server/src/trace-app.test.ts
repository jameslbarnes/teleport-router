import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { APP_LIMITS, APP_RUNTIME, appHash, checkApp, checkAppParses, runApp } from './trace-app.js';
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
