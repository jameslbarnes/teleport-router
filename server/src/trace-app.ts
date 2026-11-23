/** Apps that read one private trace with its owner's approval.
 *
 * A requester's agent writes a JavaScript function, analyze(trace, info, replies), that returns a
 * short string. Router stores the code with the request and shows it to the owner. The trace runner
 * in Router's enclave runs exactly that code in QuickJS compiled to WebAssembly. There the app has no
 * network, files, processes, timers or keys: only its arguments and its return value.
 * See docs/attested-trace-apps.md.
 *
 * An app that declared a model may instead return {ask: prompt}. It never calls out itself: the
 * runner sends the prompt and runs the function again from the start, with the model's reply added
 * to `replies` (docs/trace-app-model-calls.md).
 *
 * Router itself only checks and hashes apps. The QuickJS engine loads on first use, in the runner.
 */
import { createHash } from 'node:crypto';
import { MODEL_LIMITS } from './trace-model.js';

export const APP_RUNTIME = 'quickjs-wasm/v1';
export interface AppLimits {
  codeBytes: number; purposeChars: number; answerBytes: number; traceBytes: number;
  /** QuickJS's own heap. Concatenated strings share storage, so a long string can cost little; arrays and objects count in full. */
  memoryBytes: number; stackBytes: number; timeMs: number;
}
export const APP_LIMITS: Readonly<AppLimits> = Object.freeze({
  codeBytes: 32 * 1024,
  purposeChars: 280,
  answerBytes: 8 * 1024,
  traceBytes: 16 * 1024 * 1024,
  memoryBytes: 256 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  timeMs: 10_000,
});

export interface TraceApp { runtime: typeof APP_RUNTIME; code: string; purpose: string }
export interface AppInfo { entry_id: string; bytes: number }
/** `error` may quote the trace (an app can throw anything), so it is shown to the owner only, like an answer. */
export type AppResult = { ok: true; answer: string } | { ok: false; error: string };
/** One run of the function: its answer, its error, or one prompt for the model. Measured and checked inside the sandbox. */
export type AppStepResult = AppResult | { ask: string };

export class TraceAppError extends Error {}

const utf8Bytes = (text: string) => Buffer.byteLength(text, 'utf8');
const CONTROL = /[\u0000-\u001f\u007f]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const wellFormed = (text: string) => !LONE_SURROGATE.test(text);

/** Checks an app sent with a request. Unknown fields are refused, so a field cannot mean something to only one side. */
export function checkApp(input: unknown): TraceApp {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TraceAppError('Attach an app: {code, purpose}. The code defines function analyze(trace, info) and returns a string.');
  for (const key of Object.keys(input)) if (!['code', 'purpose', 'runtime'].includes(key)) throw new TraceAppError(`The app has an unknown field: ${key.slice(0, 40)}.`);
  const { code, purpose, runtime = APP_RUNTIME } = input as Record<string, unknown>;
  if (runtime !== APP_RUNTIME) throw new TraceAppError(`The app runtime must be ${APP_RUNTIME}.`);
  if (typeof code !== 'string' || !code.trim()) throw new TraceAppError('The app needs code that defines function analyze(trace, info).');
  if (utf8Bytes(code) > APP_LIMITS.codeBytes) throw new TraceAppError(`The app's code must be at most ${APP_LIMITS.codeBytes / 1024} KB.`);
  // A lone surrogate would hash differently in the owner's browser and in the runner.
  if (code.includes('\u0000') || !wellFormed(code)) throw new TraceAppError('The app code must be plain UTF-8 text.');
  const what = typeof purpose === 'string' ? purpose.trim() : '';
  if (!what || what.length > APP_LIMITS.purposeChars || CONTROL.test(what) || !wellFormed(what))
    throw new TraceAppError(`Say in one line of at most ${APP_LIMITS.purposeChars} characters what the app is for.`);
  return { runtime: APP_RUNTIME, code, purpose: what };
}

/** The code half of checkApp, for the runner, which is handed code without a purpose. */
export function checkAppCode(code: unknown): string {
  return checkApp({ code, purpose: 'run' }).code;
}

/** Refuses code that does not even parse, before it is stored. V8 compiles it here and runs nothing.
 *  QuickJS parses the same language, so code that passes this can still fail at run time, but rarely for syntax. */
export async function checkAppParses(code: string): Promise<void> {
  const { Script } = await import('node:vm');
  try { new Script(code, { filename: 'app.js' }); }
  catch (err) { throw new TraceAppError(`The app's code does not parse: ${String((err as Error)?.message || err).slice(0, 200)}`); }
}

/** SHA-256 of {"code":…,"runtime":…} as canonical JSON (keys sorted, no spaces). The purpose is not hashed: it describes, it does not run.
 *  The runner computes this from the code it was handed, the attestation commits to it, and the owner's browser recomputes it from the code it showed. */
export function appHash(app: Pick<TraceApp, 'code' | 'runtime'>): string {
  return createHash('sha256').update(`{"code":${JSON.stringify(app.code)},"runtime":${JSON.stringify(app.runtime)}}`, 'utf8').digest('hex');
}

type Engine = import('quickjs-emscripten-core').QuickJSWASMModule;
let engine: Promise<Engine> | undefined;
function quickjs(): Promise<Engine> {
  engine ??= (async () => {
    const [{ newQuickJSWASMModuleFromVariant }, variant] = await Promise.all([
      import('quickjs-emscripten-core'), import('@jitl/quickjs-wasmfile-release-sync')]);
    return newQuickJSWASMModuleFromVariant(variant.default);
  })();
  return engine;
}

/** Runs an app on a trace inside QuickJS. Never throws for anything the app does; every failure is an AppResult.
 *  The runner adds a hard stop around this call (a worker it terminates), in case the engine's own time check is ever missed.
 *  An app that asks for a model here, where none was declared, fails. */
export async function runApp(app: TraceApp, trace: string, info: AppInfo, limits: AppLimits = APP_LIMITS): Promise<AppResult> {
  const step = await runAppStep(app, trace, info, limits, []);
  return 'ask' in step ? { ok: false, error: NO_MODEL } : step;
}
export const NO_MODEL = 'The app asked for a model but declared none.';

/** One run of analyze(trace, info, replies), from the start. `replies` are the model's replies so far, oldest first.
 *  Returns the answer, the app's error, or {ask} with a prompt that was measured inside the sandbox before it was copied out. */
export async function runAppStep(app: TraceApp, trace: string, info: AppInfo, limits: AppLimits = APP_LIMITS, replies: readonly string[] = []): Promise<AppStepResult> {
  if (utf8Bytes(trace) > limits.traceBytes) return { ok: false, error: `The trace is larger than ${limits.traceBytes / (1024 * 1024)} MB, the most the runner accepts.` };
  if (!Array.isArray(replies) || replies.length > MODEL_LIMITS.calls || replies.some(r => typeof r !== 'string' || utf8Bytes(r) > MODEL_LIMITS.replyBytes))
    return { ok: false, error: 'The runner gave the app malformed replies.' };
  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.stackBytes);
  const deadline = Date.now() + limits.timeMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const vm = runtime.newContext();
  // Every handle is released before the runtime is freed, whatever path a run takes; a live handle makes freeing abort.
  const handles: import('quickjs-emscripten-core').QuickJSHandle[] = [];
  const hold = <T extends import('quickjs-emscripten-core').QuickJSHandle>(h: T) => { handles.push(h); return h; };
  const failure = (handle: import('quickjs-emscripten-core').QuickJSHandle) => {
    hold(handle);
    let text = 'unknown error';
    try {
      if (vm.typeof(handle) === 'object') {
        // Read name and message as properties: a dumped Error loses them. A getter here is app code, still under the deadline.
        const nameHandle = hold(vm.getProp(handle, 'name'));
        const name = vm.typeof(nameHandle) === 'string' ? vm.getString(nameHandle) : 'Error';
        const messageHandle = hold(vm.getProp(handle, 'message'));
        const message = vm.typeof(messageHandle) === 'string' ? vm.getString(messageHandle) : '';
        text = `${name}: ${message}`;
      } else text = String(vm.dump(handle));
    } catch { /* the error itself could not be read, for example after running out of memory */ }
    if (Date.now() > deadline || /interrupted/i.test(text)) return `The app ran out of time (${limits.timeMs / 1000} seconds).`;
    if (/out of memory/i.test(text)) return `The app ran out of memory (${limits.memoryBytes / (1024 * 1024)} MB).`;
    if (/stack overflow/i.test(text)) return 'The app overflowed its stack.';
    return `The app failed: ${text.slice(0, 500)}`;
  };
  /** A string the app produced, measured inside the sandbox first so an enormous one is never copied out. UTF-8 has at least one byte per code unit. */
  const bounded = (handle: import('quickjs-emscripten-core').QuickJSHandle, most: number): { text: string; units: number } | null => {
    const length = hold(vm.getProp(handle, 'length'));
    if (vm.typeof(length) !== 'number' || vm.getNumber(length) > most) return null;
    const units = vm.getNumber(length), text = vm.getString(handle);
    return utf8Bytes(text) > most ? null : { text, units };
  };
  try {
    const loaded = vm.evalCode(app.code, 'app.js', { type: 'global' });
    if (loaded.error) return { ok: false, error: failure(loaded.error) };
    hold(loaded.value);
    const analyze = hold(vm.getProp(vm.global, 'analyze'));
    if (vm.typeof(analyze) !== 'function') return { ok: false, error: 'The app must define function analyze(trace, info).' };
    const traceArg = hold(vm.newString(trace));
    const infoArg = hold(vm.newObject());
    vm.setProp(infoArg, 'entry_id', hold(vm.newString(info.entry_id)));
    vm.setProp(infoArg, 'bytes', hold(vm.newNumber(info.bytes)));
    const repliesArg = hold(vm.newArray());
    replies.forEach((reply, i) => vm.setProp(repliesArg, i, hold(vm.newString(reply))));
    const called = vm.callFunction(analyze, vm.undefined, traceArg, infoArg, repliesArg);
    if (called.error) return { ok: false, error: failure(called.error) };
    hold(called.value);
    if (vm.typeof(called.value) === 'string') {
      const answer = bounded(called.value, limits.answerBytes);
      return answer === null ? { ok: false, error: `The answer must be at most ${limits.answerBytes / 1024} KB.` } : { ok: true, answer: answer.text };
    }
    // {ask: prompt}. Reading `ask` may run a getter, which is app code under the same deadline; one that throws reads as no prompt.
    if (vm.typeof(called.value) === 'object' && !vm.sameValue(called.value, vm.null)) {
      const ask = hold(vm.getProp(called.value, 'ask'));
      if (vm.typeof(ask) === 'string') {
        const prompt = bounded(ask, MODEL_LIMITS.promptBytes);
        if (prompt === null) return { ok: false, error: `A prompt must be at most ${MODEL_LIMITS.promptBytes / 1024} KB.` };
        // A lone surrogate cannot leave the sandbox unchanged: the copy turns each into three replacement characters,
        // so its length differs from the length inside. Such a prompt is refused rather than sent altered.
        if (!prompt.units || prompt.text.length !== prompt.units || !wellFormed(prompt.text)) return { ok: false, error: 'A prompt must be non-empty plain text.' };
        return { ask: prompt.text };
      }
    }
    if (Date.now() > deadline) return { ok: false, error: `The app ran out of time (${limits.timeMs / 1000} seconds).` };
    return { ok: false, error: 'analyze must return a string.' };
  } catch {
    // The engine itself failed (it can abort when memory runs out mid-allocation). Say so without echoing anything.
    engine = undefined;
    return { ok: false, error: Date.now() > deadline ? `The app ran out of time (${limits.timeMs / 1000} seconds).` : 'The app stopped the sandbox; it may have run out of memory.' };
  } finally {
    for (const h of handles.reverse()) try { if (h.alive) h.dispose(); } catch { /* already gone with an aborted engine */ }
    // A runtime that cannot be freed cleanly leaves the engine unusable: drop it, and load a fresh one next time.
    try { vm.dispose(); runtime.dispose(); } catch { engine = undefined; }
  }
}
