import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_LIMITS, appHash, APP_RUNTIME, runApp, runAppStep } from './trace-app.js';
import { MODEL_LIMITS, modelDeclarationHash, type ModelConnector, type ModelDeclaration } from './trace-model.js';
import { RunError, checkRunDescription, runBindingPreimage, runnerService, sandboxExecutor, sandboxJobHandler, subhostRunnerClient, traceRunner } from './trace-run.js';
import { createHash } from 'node:crypto';
// @ts-expect-error The sub-container host is plain JavaScript outside this package.
import { runBindingPreimage as hostRunBinding, bindingPreimage as hostProbeBinding } from '../../subhost/host.mjs';

const socketPath = (name: string) => process.platform === 'win32'
  ? `\\\\.\\pipe\\${name}-${randomBytes(6).toString('hex')}` : join(tmpdir(), `${name}-${randomBytes(6).toString('hex')}.sock`);
const servers: http.Server[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(s => new Promise(r => { s.closeAllConnections?.(); s.close(() => r(null)); }))); });
function serve(path: string, handler: (url: string, body: any, method: string) => Promise<[number, unknown] | [number, string]> | [number, unknown]) {
  const server = http.createServer((req, res) => {
    let text = '';
    req.on('data', c => { text += c; });
    req.on('end', async () => {
      const [status, value] = await handler(req.url || '', text ? JSON.parse(text) : undefined, req.method || '');
      const out = typeof value === 'string' ? value : JSON.stringify(value);
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(out);
    });
  });
  servers.push(server);
  return new Promise<void>(resolve => server.listen(path, () => resolve()));
}
const app = { code: 'function analyze(t, i) { return i.entry_id + ":" + t.length }' };
const info = { entry_id: 'a-note', bytes: 5 };

describe('trace runs inside the enclave', () => {
  it('binds a run with the same text in the host and in Router, and never as a probe binding', () => {
    const b = { appId: 'ab'.repeat(20), name: 'trace-runner', codeHash: 'cd'.repeat(32), runHash: 'ef'.repeat(32), publicKey: '0x04' + '12'.repeat(64), nonce: '34'.repeat(32) };
    expect(hostRunBinding(b)).toBe(runBindingPreimage(b));
    expect(runBindingPreimage(b)).toContain('"domain":"teleport-router/trace-run/v1"');
    expect(hostProbeBinding(b)).not.toBe(runBindingPreimage(b));
    expect(() => runBindingPreimage({ ...b, runHash: 'nope' })).toThrow();
  });

  it('answers the host with fixed sentences only', async () => {
    const runner = traceRunner({ execute: runApp, fetchTrace: async () => { throw new Error('secret trace text in an error'); } });
    const service = runnerService(runner);
    expect(await service('/elsewhere', {})).toEqual({ status: 404, value: { error: 'not found' } });
    expect(await service('/prepare', { description: { v: 2 }, code: app.code })).toEqual({ status: 400, value: { error: 'The run description has the wrong fields.' } });
    const broken = runnerService({ prepare() { throw new TypeError('secret trace text'); }, run: async () => { throw new Error('secret trace text'); } } as any);
    expect(await broken('/prepare', {})).toEqual({ status: 500, value: { error: 'The run failed.' } });
    expect(await broken('/run', {})).toEqual({ status: 500, value: { error: 'The run failed.' } });
    expect(JSON.stringify(await service('/run', { run_id: 'x' }))).not.toContain('secret');
  });

  it('gives the sandbox only well-formed jobs, within the default limits', async () => {
    const seen: any[] = [];
    const handle = sandboxJobHandler(async (a, t, i, l) => { seen.push(l); return runApp(a, t, i, l); });
    for (const bad of [null, {}, { app, trace: 1, info }, { app, trace: 'x', info: { entry_id: 1, bytes: 1 } }, { app: { code: '' }, trace: 'x', info }])
      expect(await handle(bad)).toEqual({ ok: false, error: 'The sandbox was given a malformed job.' });
    expect(await handle({ app, trace: 'hello', info, limits: { answerBytes: 10_000_000, timeMs: 10 ** 9 } })).toEqual({ ok: true, answer: 'a-note:5' });
    expect(seen.at(-1)).toEqual({ ...APP_LIMITS });
    await handle({ app, trace: 'hello', info, limits: { answerBytes: 100 } });
    expect(seen.at(-1).answerBytes).toBe(100);
  });

  it('runs each app in a sandbox it asks the host for, and always asks for its removal', async () => {
    const asked: string[] = [];
    const pipes = new Map<string, string>();
    let reply: (body: any) => [number, unknown] = body => [200, { ok: true, answer: `ran ${body.app.code.length} chars on ${body.trace}` }];
    const executor = sandboxExecutor({
      askHost: async (method, id) => {
        asked.push(`${method} ${id}`);
        if (method === 'POST') { const p = socketPath('sandbox'); pipes.set(id, p); await serve(p, (_u, body) => reply(body)); }
      },
      socketFor: id => pipes.get(id)!, ready: () => true,
    });
    const run = () => executor({ runtime: APP_RUNTIME, code: app.code, purpose: '' }, 'hello', info, APP_LIMITS);
    expect(await run()).toEqual({ ok: true, answer: `ran ${app.code.length} chars on hello` });
    expect(asked).toHaveLength(2);
    expect(asked[0].replace('POST', 'DELETE')).toBe(asked[1]);
    reply = () => [200, { ok: true, answer: 'x'.repeat(APP_LIMITS.answerBytes + 1) }];
    expect(await run()).toMatchObject({ ok: false });
    reply = () => [200, { ok: false, error: 'The app failed: Error: boom' }];
    expect(await run()).toEqual({ ok: false, error: 'The app failed: Error: boom' });
    reply = () => [500, 'not json'];
    expect(await run()).toEqual({ ok: false, error: 'The sandbox returned nothing usable.' });
    expect(asked.filter(a => a.startsWith('DELETE'))).toHaveLength(4);
    const refused = sandboxExecutor({ askHost: async m => { if (m === 'POST') throw new Error('no'); }, socketFor: () => 'x', ready: () => true });
    expect(await refused({ runtime: APP_RUNTIME, code: app.code, purpose: '' }, 'hello', info, APP_LIMITS)).toEqual({ ok: false, error: 'The sandbox could not start.' });
    const never = sandboxExecutor({ askHost: async () => {}, socketFor: () => 'x', ready: () => false, waitMs: 200 });
    expect(await never({ runtime: APP_RUNTIME, code: app.code, purpose: '' }, 'hello', info, APP_LIMITS)).toEqual({ ok: false, error: 'The sandbox could not start.' });
    // A sandbox that never answers is cut off a little after the app's time limit.
    const silent = socketPath('silent');
    const hang = http.createServer(() => { /* never answers */ }); servers.push(hang);
    await new Promise<void>(r => hang.listen(silent, () => r()));
    const slow = sandboxExecutor({ askHost: async () => {}, socketFor: () => silent, ready: () => true });
    expect(await slow({ runtime: APP_RUNTIME, code: app.code, purpose: '' }, 'hello', info, { ...APP_LIMITS, timeMs: 100 }))
      .toEqual({ ok: false, error: 'The app ran out of time (0.1 seconds), and the runner stopped it.' });
  }, 20_000);

  it('lets Router reach the host\'s runner, passing on only the runner\'s own sentences', async () => {
    const path = socketPath('runs');
    let mode: 'ok' | 'refuse' | 'garbled' = 'ok';
    await serve(path, (url, body) => {
      if (mode === 'refuse') return [400, { error: 'The code does not match the run description.' }];
      if (mode === 'garbled') return [200, '<html>'];
      return url === '/prepare'
        ? [200, { run_id: body.description.run_id, public_key: '0x04' + '1'.repeat(128), bundle: { version: 1, simulated: false }, runner: { name: 'trace-runner' } }]
        : [200, { run_id: body.run_id, sealed: { meta: {}, data: '' }, signature: '0xsig' }];
    });
    const client = subhostRunnerClient(path);
    const description: any = { run_id: 'r1' };
    expect(await client.prepare({ description, code: 'x', nonce: '00'.repeat(32) })).toMatchObject({ run_id: 'r1', runner: { name: 'trace-runner' } });
    expect(await client.run({ run_id: 'r1', delegation: 'd', wrap: {} as any, host: 'h' })).toEqual({ run_id: 'r1', sealed: { meta: {}, data: '' }, signature: '0xsig' });
    // A real bundle is large: the measured compose file alone is over 60 KB.
    const big = socketPath('big');
    await serve(big, (_url, body) => [200, { run_id: body.description.run_id, public_key: '0x04' + '1'.repeat(128), bundle: { app_compose: 'x'.repeat(900_000) }, runner: {} }]);
    expect((await subhostRunnerClient(big).prepare({ description, code: 'x', nonce: '00'.repeat(32) })).bundle.app_compose).toHaveLength(900_000);
    mode = 'refuse';
    await expect(client.prepare({ description, code: 'x', nonce: '00'.repeat(32) })).rejects.toThrow(RunError);
    await expect(client.prepare({ description, code: 'x', nonce: '00'.repeat(32) })).rejects.toThrow('does not match');
    mode = 'garbled';
    await expect(client.run({ run_id: 'r1', delegation: 'd', wrap: {} as any, host: 'h' })).rejects.toThrow('unreadable');
    await expect(subhostRunnerClient(socketPath('nobody')).run({ run_id: 'r1', delegation: 'd', wrap: {} as any, host: 'h' })).rejects.toThrow('did not answer');
    expect(appHash({ code: 'x', runtime: APP_RUNTIME })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('runs whose app may call a model', () => {
  const DECL: ModelDeclaration = { provider: 'redpill', model: 'z-ai/glm-5.3', calls: 2, prompt_bytes: 2000, reply_tokens: 100 };
  const CODE = 'function analyze(t, i, r) { return r.length ? "got " + r[0] : { ask: "hi" } }';
  const KEY = 'sk-test-0123456789abcdef';
  const point = '0x02' + '11'.repeat(32);
  const describeRun = (over: Record<string, unknown> = {}): any => ({
    v: 1, request_id: 'ab'.repeat(32), revision: 'rev-1', requester: '@reader', owner_did: 'did:pkh:eip155:1:0x' + '12'.repeat(20), entry_id: 'a-note', part: 'full',
    ciphertext_sha256: 'cd'.repeat(32), app_hash: appHash({ code: CODE, runtime: APP_RUNTIME }), run_id: 'run-' + randomBytes(4).toString('hex'), expires_at: Date.now() + 60_000,
    answer_bytes: APP_LIMITS.answerBytes, owner_public_key: point, answer_key: point, ...over });
  const v2 = (over: Record<string, unknown> = {}) => describeRun({ v: 2, model_hash: modelDeclarationHash(DECL), ...over });
  const connect: ModelConnector = async () => { throw new Error('not reached in these tests'); };

  it('accepts exactly two shapes of run description: version 1 as before, and version 2 with the model hash', () => {
    expect(Object.keys(checkRunDescription(describeRun()))).toHaveLength(14);
    expect(checkRunDescription(v2()).v).toBe(2);
    const nullHash = createHash('sha256').update('null').digest('hex');
    for (const bad of [describeRun({ model_hash: modelDeclarationHash(DECL) }), describeRun({ v: 2 }), v2({ model_hash: nullHash }), v2({ model_hash: 'nope' }),
      describeRun({ v: 3 }), v2({ model: DECL }), v2({ v: '2' })])
      expect(() => checkRunDescription(bad), JSON.stringify(bad).slice(0, 80)).toThrow(RunError);
  });

  it('prepares a model run only with the declaration it hashes, and only when the runner can reach the provider', () => {
    const runner = traceRunner({ execute: runAppStep, fetchTrace: async () => { throw new Error('no'); }, connectorFor: p => p === 'redpill' ? connect : null, maxActive: 10 });
    expect(runner.prepare({ description: v2(), code: CODE, model: DECL }).run_id).toMatch(/^run-/);
    expect(() => runner.prepare({ description: v2(), code: CODE, model: { ...DECL, calls: 3 } })).toThrow('does not match the run description');
    expect(() => runner.prepare({ description: v2(), code: CODE })).toThrow('does not match the run description');
    expect(() => runner.prepare({ description: v2(), code: CODE, model: { ...DECL, endpoint: 'https://elsewhere.example' } })).toThrow('The model declaration is malformed.');
    const tinfoil = { ...DECL, provider: 'tinfoil' as const };
    expect(() => runner.prepare({ description: v2({ model_hash: modelDeclarationHash(tinfoil) }), code: CODE, model: tinfoil }))
      .toThrow('This runner cannot reach the declared model provider, so the run was not prepared.');
    expect(() => runner.prepare({ description: describeRun(), code: CODE, model: DECL })).toThrow('This run description allows no model.');
    expect(runner.prepare({ description: describeRun(), code: CODE, model: null }).run_id).toMatch(/^run-/);
    const plain = traceRunner({ execute: runAppStep, fetchTrace: async () => { throw new Error('no'); } });
    expect(() => plain.prepare({ description: v2(), code: CODE, model: DECL })).toThrow('cannot reach the declared model provider');
  });

  it("needs the requester's key for a model run, checked before the run is spent, and takes none for a run without", async () => {
    const runner = traceRunner({ execute: runAppStep, fetchTrace: async () => { throw new Error(`refused ${KEY}`); }, connectorFor: () => connect, maxActive: 10 });
    const d = v2();
    runner.prepare({ description: d, code: CODE, model: DECL });
    const run = (model_key?: string) => runner.run({ run_id: d.run_id, delegation: 'd', wrap: {} as any, host: 'h', model_key });
    for (const key of [undefined, 'short', 'has a space in it', 'x'.repeat(401)]) {
      const error = await run(key).catch(e => e);
      expect(error).toBeInstanceOf(RunError);
      expect(error.message).toBe("This run needs the requester's key for the model provider.");
    }
    // The refusals above did not spend the run: with a key it goes on to read the trace.
    const error = await run(KEY).catch(e => e);
    expect(error.message).toBe('The runner could not read the trace with this grant.');
    expect(error.message).not.toContain(KEY);
    await expect(run(KEY)).rejects.toThrow('already run');
    const d1 = describeRun();
    runner.prepare({ description: d1, code: CODE });
    await expect(runner.run({ run_id: d1.run_id, delegation: 'd', wrap: {} as any, host: 'h', model_key: KEY })).rejects.toThrow('This run declared no model, so it takes no key.');
  });

  it('passes the model declaration and key from the host to the runner, and the replies to the sandbox', async () => {
    const seen: any[] = [];
    const service = runnerService({ prepare: (input: any) => { seen.push(input); return { ok: true }; }, run: async (input: any) => { seen.push(input); return { ok: true }; } } as any);
    await service('/prepare', { description: { v: 2 }, code: 'c', model: DECL, extra: 'dropped' });
    await service('/run', { run_id: 'r', delegation: 'd', wrap: {}, host: 'h', model_key: KEY });
    expect(seen).toEqual([{ description: { v: 2 }, code: 'c', model: DECL }, { run_id: 'r', delegation: 'd', wrap: {}, host: 'h', model_key: KEY }]);
    const steps: any[] = [];
    const handle = sandboxJobHandler(async (a, t, i, l, r) => { steps.push(r); return runAppStep(a, t, i, l, r); });
    const job = { app: { code: CODE }, trace: 'hello', info };
    expect(await handle(job)).toEqual({ ask: 'hi' });
    expect(await handle({ ...job, replies: ['there'] })).toEqual({ ok: true, answer: 'got there' });
    expect(steps).toEqual([[], ['there']]);
    for (const replies of ['x', [1], Array(MODEL_LIMITS.calls + 1).fill('x'), ['x'.repeat(MODEL_LIMITS.replyBytes + 1)]])
      expect(await handle({ ...job, replies })).toEqual({ ok: false, error: 'The sandbox was given a malformed job.' });
  });

  it("takes a prompt back from the sandbox only within the largest a prompt may be", async () => {
    const pipes = new Map<string, string>();
    let reply: (body: any) => [number, unknown] = body => [200, { ask: `prompt after ${body.replies.length}` }];
    const executor = sandboxExecutor({
      askHost: async (method, id) => { if (method === 'POST') { const p = socketPath('sandbox'); pipes.set(id, p); await serve(p, (_u, body) => reply(body)); } },
      socketFor: id => pipes.get(id)!, ready: () => true,
    });
    const run = (replies?: string[]) => executor({ runtime: APP_RUNTIME, code: CODE, purpose: '' }, 'hello', info, APP_LIMITS, replies);
    expect(await run(['a', 'b'])).toEqual({ ask: 'prompt after 2' });
    expect(await run()).toEqual({ ask: 'prompt after 0' });
    reply = () => [200, { ask: 'x'.repeat(MODEL_LIMITS.promptBytes + 1) }];
    expect(await run()).toEqual({ ok: false, error: 'The sandbox returned nothing usable.' });
    reply = () => [200, { ok: true, ask: 'both' }];
    expect(await run()).toEqual({ ok: false, error: 'The sandbox returned nothing usable.' });
  }, 20_000);
});
