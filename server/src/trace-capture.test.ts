import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { testWallet, versionedMemoryStore } from './author-test-fixtures.js';
import { insightsRelease } from './insights-release.js';
import { sealPart, openPart, checkPartMeta } from './trace-envelope.js';
import type { JournalEntry, User } from './storage.js';
import type { GroupStore } from './group-store.js';
// The capture client ships with the plugin as plain JavaScript.
// @ts-ignore
import { findPosts, buildTrace, sourceOf, cleanRecords, scrubText, sealFull, openFull, readTrace } from '../../plugins/teleport-router/scripts/trace-lib.mjs';

// Synthetic session logs only, in the shape Claude Code writes them.
const SESSION = 'synthetic-session';
let n = 0;
const rec = (type: string, message?: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, uuid: `u${++n}`, sessionId: SESSION, timestamp: `2026-11-10T12:00:${String(n % 60).padStart(2, '0')}Z`, cwd: '/work/project', ...(message ? { message } : {}), ...extra });
const user = (text: string) => rec('user', { role: 'user', content: text });
const say = (text: string) => rec('assistant', { role: 'assistant', content: [{ type: 'thinking', thinking: 'a readable summary', signature: 'PROVIDERCIPHERTEXT'.repeat(40) }, { type: 'text', text }] });
const use = (id: string, name: string, input: unknown = {}) => rec('assistant', { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] });
const result = (id: string, content: unknown, extra: Record<string, unknown> = {}) =>
  rec('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] }, { toolUseResult: content, mcpMeta: { server: 'router' } });
const WRITE = 'mcp__plugin_teleport-router_router__router_write_entry';
const receipt = (id: string) => JSON.stringify({ receipt: { version: 1, entry_id: id, state: 'pending', audience: 'Only: #group' } });
const KEY = 'k'.repeat(43);
const NEVER = { neverUpload: ['mcp__diary__'] };

const twoPosts = () => [
  rec('session-owner', undefined, { accountUuid: 'account-1' }),
  user('find out why the nightly job is slow'),
  use('t1', 'Bash', { command: `curl https://router.example/api/x?key=${KEY}` }),
  result('t1', 'the polling loop runs every second; token=abcdefgh12345678 password: hunter2hunter2'),
  rec('api-request-blob', undefined, { blob: 'x'.repeat(500) }),
  say('The polling loop is the cause.'),
  use('w1', WRITE, { entry: 'Polling every second caused the load.' }),
  result('w1', receipt('entry-one')),
  user('good, now fix it'),
  say('Fixed: it polls every thirty seconds.'),
  use('w2', WRITE, { entry: 'not sent' }),
  result('w2', 'Your rules require a draft. Nothing was posted.', { is_error: true }),
  use('w3', WRITE, { entry: 'Polling now runs every thirty seconds.' }),
  result('w3', receipt('entry-two')),
  user('thanks'),
];

describe('Finding the trace behind each post', () => {
  it('gives each post the records since the previous post, with no record in two traces', () => {
    const lines = twoPosts();
    const found = findPosts(lines);
    expect(found.posts.map((p: any) => [p.entryId, p.firstLine, p.lastLine, p.previousEntryId])).toEqual([['entry-one', 0, 7, null], ['entry-two', 8, 13, 'entry-one']]);
    expect(found).toMatchObject({ failedWrites: 1, unrecognizedResults: 0, unanswered: 0 });
    expect(found.posts[0].sessionId).toBe(SESSION);
  });

  it('finds nothing in a session that never posted, and ignores a write that is still running', () => {
    expect(findPosts([user('hello'), say('hi')]).posts).toEqual([]);
    expect(findPosts([user('post this'), use('w9', WRITE, { entry: 'x' })])).toMatchObject({ posts: [], unanswered: 1 });
  });

  it('withholds a trace from the first call to a never-upload tool onward', () => {
    const lines = [
      user('note this'), use('w1', WRITE, { entry: 'a' }), result('w1', receipt('before')),
      user('read me my diary'), use('i1', 'mcp__diary__diary_read', {}), result('i1', 'DIARY TEXT private page'),
      say('The diary says: DIARY TEXT private page'), use('w2', WRITE, { entry: 'b' }), result('w2', receipt('during')),
      user('and another note'), say('You said earlier: DIARY TEXT'), use('w3', WRITE, { entry: 'c' }), result('w3', receipt('after')),
    ];
    const { posts } = findPosts(lines, NEVER);
    expect(posts.map((p: any) => !!p.withheld)).toEqual([false, true, true]);
    for (const post of posts.slice(1)) {
      const built = buildTrace({ post, lines });
      const trace = readTrace(built.plaintext);
      expect(trace.records).toEqual([]); expect(trace.withheld).toContain('never uploaded');
      expect(JSON.stringify(trace)).not.toContain('DIARY');
    }
    expect(JSON.stringify(readTrace(buildTrace({ post: posts[0], lines }).plaintext))).toContain('note this');
  });
});

describe('Withholding across related sessions', () => {
  const reading = [user('read me my diary'), use('i1', 'mcp__diary__diary_read', {}), result('i1', 'DIARY TEXT')];

  it('reports the session that called a never-upload tool, so the caller can remember it', () => {
    expect(findPosts(reading, NEVER)).toMatchObject({ sessionId: SESSION, calledNeverUpload: true, posts: [] });
    // The list is each owner's own: with no rule, nothing is withheld.
    expect(findPosts(reading)).toMatchObject({ calledNeverUpload: false });
    expect(findPosts(twoPosts())).toMatchObject({ sessionId: SESSION, calledNeverUpload: false, parentSessionId: null, startsFromSummary: false });
  });

  it('withholds every post of a session started by an excluded session', () => {
    // A Claude Code subagent's log carries its parent's session ID under its own file name.
    const lines = [user('summarise what the diary said'), say('It said: DIARY TEXT'), use('w1', WRITE, { entry: 'x' }), result('w1', receipt('child-post'))];
    const asChild = { fileName: 'agent-abc123.jsonl', excludedSessions: new Set([SESSION]) };
    expect(findPosts(lines, asChild)).toMatchObject({ parentSessionId: SESSION });
    expect(findPosts(lines, asChild).posts[0].withheld).toContain('descends from');
    expect(JSON.stringify(readTrace(buildTrace({ post: findPosts(lines, asChild).posts[0], lines }).plaintext))).not.toContain('DIARY');
    // The same log is not withheld when its parent is not excluded, or when it is the parent's own log.
    expect(findPosts(lines, { fileName: 'agent-abc123.jsonl' }).posts[0].withheld).toBeNull();
    expect(findPosts(lines, { fileName: `${SESSION}.jsonl`, excludedSessions: new Set([SESSION]) }).posts[0].withheld).toBeNull();
  });

  it('withholds a log that opens with a summary of an earlier session', () => {
    const carried = rec('user', { role: 'user', content: 'This session continues an earlier one. Summary: the diary said DIARY TEXT.' }, { isCompactSummary: true });
    const lines = [carried, user('post a note about it'), use('w1', WRITE, { entry: 'x' }), result('w1', receipt('carried-post'))];
    const found = findPosts(lines);
    expect(found.startsFromSummary).toBe(true);
    expect(found.posts[0].withheld).toContain('summary of an earlier session');
    expect(JSON.stringify(readTrace(buildTrace({ post: found.posts[0], lines }).plaintext))).not.toContain('DIARY');
    // A summary written later in the same log is ordinary compaction: the history before it was checked.
    expect(findPosts([user('hello'), carried, use('w1', WRITE, { entry: 'x' }), result('w1', receipt('later'))]).posts[0].withheld).toBeNull();
  });
});

describe('Codex session logs', () => {
  const THREAD = 'synthetic-thread';
  const line = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-11-10T12:00:00Z', ordinal: ++n, type, payload });
  const item = (payload: Record<string, unknown>) => line('response_item', payload);
  const mcp = (server: string, tool: string, text: string, extra: Record<string, unknown> = {}) => line('event_msg', { type: 'item_completed', thread_id: THREAD, turn_id: 't',
    item: { type: 'McpToolCall', id: `exec-${++n}`, server, tool, arguments: { entry: 'a note' }, status: 'completed', result: { content: [{ type: 'text', text }] }, ...extra } });
  const log = () => [
    line('session_meta', { session_id: THREAD, creator_account_id: 'codex-account', cwd: 'C:/work/project', cli_version: '9.9.9', base_instructions: 'BASE INSTRUCTIONS' }),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'why is the nightly job slow' }] }),
    item({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'a readable summary' }], encrypted_content: 'OPAQUE'.repeat(100) }),
    item({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:"type job.log"}))' }),
    line('event_msg', { type: 'item_completed', thread_id: THREAD, item: { type: 'CommandExecution', id: 'exec-x', aggregated_output: 'DUPLICATE OUTPUT' } }),
    item({ type: 'custom_tool_call_output', call_id: 'c1', output: 'the polling loop runs every second' }),
    line('event_msg', { type: 'token_count', info: { total: 123 } }),
    mcp('hermes', 'router_write_entry', receipt('codex-one')),
    item({ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] }),
    mcp('hermes', 'router_write_entry', 'Your rules require a draft. Nothing was posted.', { result: { content: [{ type: 'text', text: 'Nothing was posted.' }], isError: true } }),
    mcp('router', 'router_write_entry', receipt('codex-two')),
  ];

  it('finds each post from the single record that holds the call and its receipt', () => {
    const found = findPosts(log());
    expect(found.posts.map((p: any) => [p.entryId, p.agent, p.firstLine, p.lastLine, p.previousEntryId, p.sessionId])).toEqual([
      ['codex-one', 'codex', 0, 7, null, THREAD], ['codex-two', 'codex', 8, 10, 'codex-one', THREAD]]);
    expect(found.failedWrites).toBe(1);
    expect(sourceOf(log(), found.posts[1])).toEqual({ cwd: 'C:/work/project', git_branch: null, agent_version: '9.9.9' });
  });

  it('reads the entry ID from a written notice or from structured content', () => {
    const notice = 'After every write, show the person the sharing receipt.\n\n[Review or delete](https://router.example/e/noticed-1#manage)\nEntry ID: noticed-1\nStatus: pending';
    const structured = { result: { content: [{ type: 'text', text: 'Saved.' }], structuredContent: { receipt: { version: 1, entry_id: 'structured-1' } } } };
    const lines = [mcp('hermes', 'router_write_entry', notice), mcp('hermes', 'router_write_entry', 'ignored', structured),
      mcp('hermes', 'router_write_entry', 'Saved. [Review or delete](https://router.example/e/linked-1#manage)'), mcp('hermes', 'router_write_entry', 'Saved, with no identifier.')];
    const found = findPosts(lines);
    expect(found.posts.map((p: any) => p.entryId)).toEqual(['noticed-1', 'structured-1', 'linked-1']);
    expect(found.unrecognizedResults).toBe(1);
    // Claude Code can receive the same written notice.
    expect(findPosts([use('w1', WRITE, { entry: 'x' }), result('w1', notice)]).posts[0].entryId).toBe('noticed-1');
  });

  it('keeps model input, output and MCP calls; drops ciphertext, duplicates and account details', () => {
    const lines = log();
    const trace = readTrace(buildTrace({ post: findPosts(lines).posts[0], lines }).plaintext);
    const text = JSON.stringify(trace);
    expect(trace.agent).toBe('codex');
    for (const kept of ['why is the nightly job slow', 'a readable summary', 'the polling loop runs every second', 'codex-one']) expect(text).toContain(kept);
    for (const gone of ['OPAQUE', 'DUPLICATE OUTPUT', 'codex-account', 'BASE INSTRUCTIONS']) expect(text).not.toContain(gone);
    expect(trace.cleaning).toMatchObject({ records_kept: 5, provider_ciphertext_bytes: 600,
      left_out_by_type: { 'session_meta': 1, 'event_msg/item_completed': 1, 'event_msg/token_count': 1 } });
  });

  it('drops provider ciphertext nested inside compacted history, and withholds subagents of an excluded thread', () => {
    const compacted = line('compacted', { message: 'summary of the work so far', replacement_history: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: 'kept summary' }], encrypted_content: 'NESTEDOPAQUE'.repeat(50) }] });
    const lines = [...log().slice(0, 2), compacted, mcp('hermes', 'router_write_entry', receipt('codex-compacted'))];
    const trace = readTrace(buildTrace({ post: findPosts(lines).posts[0], lines }).plaintext);
    expect(JSON.stringify(trace)).toContain('kept summary'); expect(JSON.stringify(trace)).not.toContain('NESTEDOPAQUE');
    expect(trace.cleaning.provider_ciphertext_bytes).toBe(600);

    const child = [line('session_meta', { id: 'child-thread', session_id: 'child-thread', parent_thread_id: THREAD, cwd: 'C:/work' }), ...log().slice(1, 2), mcp('hermes', 'router_write_entry', receipt('codex-child'))];
    expect(findPosts(child)).toMatchObject({ sessionId: 'child-thread', parentSessionId: THREAD });
    expect(findPosts(child).posts[0].withheld).toBeNull();
    expect(findPosts(child, { excludedSessions: new Set([THREAD]) }).posts[0].withheld).toContain('descends from');
    // A log whose first model record is carried-over history cannot be checked.
    const resumed = [line('session_meta', { id: 'resumed', session_id: 'resumed' }), compacted, mcp('hermes', 'router_write_entry', receipt('codex-resumed'))];
    expect(findPosts(resumed).posts[0].withheld).toContain('summary of an earlier session');
  });

  it('withholds from the first call to a never-upload server onward', () => {
    const lines = [...log(), mcp('diary', 'diary_read', 'DIARY TEXT'), mcp('hermes', 'router_write_entry', receipt('codex-three'))];
    const { posts } = findPosts(lines, NEVER);
    expect(posts.map((p: any) => !!p.withheld)).toEqual([false, false, true]);
    expect(JSON.stringify(readTrace(buildTrace({ post: posts[2], lines }).plaintext))).not.toContain('DIARY');
  });
});

describe('Cleaning a trace', () => {
  it('keeps the conversation and drops ciphertext, duplicates, bookkeeping and credentials', () => {
    const lines = twoPosts();
    const [post] = findPosts(lines).posts;
    const built = buildTrace({ post, lines, extraSecrets: [KEY], source: { log: 'synthetic.jsonl' } });
    const trace = readTrace(built.plaintext);
    const text = JSON.stringify(trace);
    expect(trace).toMatchObject({ v: 1, kind: 'router-post-trace', entry_id: 'entry-one', session_id: SESSION, previous_entry_id: null, log: 'synthetic.jsonl' });
    expect(trace.records.map((r: any) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant', 'user']);
    expect(text).toContain('find out why the nightly job is slow');
    expect(text).toContain('a readable summary');           // the thinking summary stays
    expect(text).toContain('the polling loop runs every second');
    for (const gone of ['PROVIDERCIPHERTEXT', 'toolUseResult', 'mcpMeta', 'account-1', KEY, 'abcdefgh12345678', 'hunter2hunter2']) expect(text).not.toContain(gone);
    expect(trace.cleaning).toMatchObject({ rules: 1, records_in: 8, records_kept: 6, left_out_by_type: { 'session-owner': 1, 'api-request-blob': 1 } });
    expect(trace.cleaning.secrets_removed).toBeGreaterThanOrEqual(3);
    expect(trace.cleaning.provider_ciphertext_bytes).toBe('PROVIDERCIPHERTEXT'.length * 40);
  });

  it('removes common credential shapes and leaves ordinary text alone', () => {
    const secrets = ['sk-ant-api03-' + 'a'.repeat(40), 'ghp_' + 'b'.repeat(36), 'AKIA' + 'C'.repeat(16), '0x' + 'd'.repeat(64),
      'eyJ' + 'e'.repeat(20) + '.' + 'f'.repeat(20) + '.' + 'g'.repeat(20), '-----BEGIN EC PRIVATE KEY-----\nabc\n-----END EC PRIVATE KEY-----'];
    for (const secret of secrets) expect(scrubText(`before ${secret} after`).text).toBe('before [secret removed] after');
    expect(scrubText('Authorization: Bearer ' + 'h'.repeat(30)).text).toBe('Authorization: Bearer [secret removed]');
    expect(scrubText('"secret_key":"' + 'i'.repeat(43) + '"').text).toBe('"secret_key":"[secret removed]"');
    const plain = 'The key idea: poll less often. See commit 30bc86d and https://example.com/page?id=42.';
    expect(scrubText(plain)).toEqual({ text: plain, count: 0 });
  });

  it('replaces inline images and does not change its input', () => {
    const image = { type: 'image', source: { type: 'base64', data: 'A'.repeat(5000) } };
    const records = [{ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [image, { type: 'text', text: 'a screenshot' }] }] } }];
    const before = JSON.stringify(records);
    const cleaned = cleanRecords(records);
    expect(JSON.stringify(cleaned.records)).not.toContain('AAAA');
    expect(cleaned.stats.images_removed).toBe(1);
    expect(JSON.stringify(records)).toBe(before);
  });

  it('shortens long strings, longest first, only when the trace would not fit', () => {
    const noise = (len: number) => { let s = '', i = 0; while (s.length < len) s += createHash('sha256').update(String(i++)).digest('hex'); return s.slice(0, len); };
    const lines = [user('run it'), use('t1', 'Bash', {}), result('t1', noise(600_000)), use('w1', WRITE, { entry: 'x' }), result('w1', receipt('big'))];
    const [post] = findPosts(lines).posts;
    const roomy = buildTrace({ post, lines });
    expect(roomy.summary.shortened_to).toBeNull();
    const tight = buildTrace({ post, lines, maxBytes: 60_000 });
    expect(tight.plaintext.length).toBeLessThanOrEqual(60_000);
    const trace = readTrace(tight.plaintext);
    expect(trace.cleaning.strings_shortened_to).toBe(50_000);
    expect(JSON.stringify(trace)).toContain('characters left out to fit the size limit');
    expect(JSON.stringify(trace)).toContain('run it');
  });
});

describe('Owner-only traces on a server with no release key', () => {
  const world = (wrap: (store: GroupStore) => GroupStore = s => s) => {
    const users = new Map<string, any>(), entries = new Map<string, JournalEntry>(), stores = new Map<string, Map<string, string>>();
    const person = (handle: string) => {
      const wallet = testWallet(handle);
      users.set(handle, { handle, secretKeyHash: createHash('sha256').update('key of ' + handle).digest('hex'), createdAt: 1,
        tinycloud: { ownerDid: `did:pkh:eip155:1:${wallet.address}`, space: `space-${handle}`, prefix: 'router/', delegation: handle,
          pseudonym: handle, linkedAt: 1, ownerPublicKey: wallet.signingKey.publicKey, minRecordVersion: 2 } });
      return { wallet, user: users.get(handle) as User };
    };
    const release = insightsRelease({
      releasePrivateKey: null, appId: 'production', baseUrl: 'https://router.example', build: { gitSha: null, imageDigest: null }, model: 'unused',
      getUser: async h => users.get(h) || null, updateUser: async () => null, getEntry: async id => entries.get(id) || null,
      storeFor: async b => { if (!stores.has(b.delegation)) stores.set(b.delegation, new Map()); return wrap(versionedMemoryStore(stores.get(b.delegation)!)); },
      complete: null,
    });
    const post = (id: string, handle: string) => entries.set(id, { id, handle, pseudonym: handle, client: 'code', content: 'note', timestamp: 1, to: ['#group'] });
    return { release, person, post, stores };
  };

  it('stores a captured trace once, returns it to its owner, and holds only ciphertext', async () => {
    const w = world(); const alice = w.person('alice'), mallory = w.person('mallory'); w.post('entry-one', 'alice');
    const owner = w.release.ownerKey(alice.user);
    expect(owner).toMatchObject({ handle: 'alice', owner_did: alice.user.tinycloud!.ownerDid, owner_public_key: alice.wallet.signingKey.compressedPublicKey });

    const lines = twoPosts();
    const [post] = findPosts(lines).posts;
    const { plaintext } = buildTrace({ post, lines });
    const context = { ownerDid: owner.owner_did, entryId: post.entryId };
    const sealed = sealFull(plaintext, context, owner.owner_public_key);
    const body = { entry_id: post.entryId, full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } };
    expect(await w.release.putTrace(alice.user, body)).toMatchObject({ stored: true, full_sha256: sealed.meta.sha256, derived_sha256: null });
    await expect(w.release.putTrace(alice.user, body)).rejects.toThrow('already has its trace');
    await expect(w.release.putTrace(mallory.user, body)).rejects.toThrow('not one of your posts');

    const stored = [...w.stores.get('alice')!.values()].join('\n');
    expect(stored).not.toContain('nightly job'); expect(stored).not.toContain('polling');

    const got = (await w.release.getTrace(alice.user, 'entry-one', 'full'))!;
    const opened = readTrace(openFull(got.meta, Buffer.from(got.data, 'base64'), context, alice.wallet.privateKey));
    expect(opened.entry_id).toBe('entry-one'); expect(JSON.stringify(opened)).toContain('find out why the nightly job is slow');
    expect(() => openFull(got.meta, Buffer.from(got.data, 'base64'), context, mallory.wallet.privateKey)).toThrow();
    expect(() => openFull(got.meta, Buffer.from(got.data, 'base64'), { ...context, entryId: 'entry-two' }, alice.wallet.privateKey)).toThrow();
    expect(await w.release.getTrace(mallory.user, 'entry-one', 'full')).toBeNull();
    expect(await w.release.listTraces(alice.user)).toEqual(['entry-one']);
  });

  it('keeps one readable trace when two uploads for the same post race', async () => {
    const w = world(); const alice = w.person('alice'); w.post('raced', 'alice');
    const owner = w.release.ownerKey(alice.user), context = { ownerDid: owner.owner_did, entryId: 'raced' };
    const upload = (text: string) => { const sealed = sealFull(Buffer.from(text.repeat(40_000)), context, owner.owner_public_key);
      return { sealed, done: w.release.putTrace(alice.user, { entry_id: 'raced', full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } }) }; };
    // Both are large enough for several chunks, and both start before either has written its record.
    const a = upload('first upload '), b = upload('second upload ');
    const results = await Promise.allSettled([a.done, b.done]);
    expect(results.map(r => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const winner = results[0].status === 'fulfilled' ? a : b;
    const got = (await w.release.getTrace(alice.user, 'raced', 'full'))!;
    expect(got.meta.sha256).toBe(winner.sealed.meta.sha256);
    expect(openFull(got.meta, Buffer.from(got.data, 'base64'), context, alice.wallet.privateKey).toString().slice(0, 13)).toBe(winner === a ? 'first upload ' : 'second upload');
    // The losing upload left nothing behind, and the post still lists as one trace.
    const record = JSON.parse(w.stores.get('alice')!.get('traces/raced/meta')!);
    expect([...w.stores.get('alice')!.keys()].filter(k => k !== 'traces/raced/meta').every(k => k.startsWith(`traces/raced/${record.upload}/`))).toBe(true);
    expect(await w.release.listTraces(alice.user)).toEqual(['raced']);
  });

  it('keeps a trace whose record was saved although the write reported a failure', async () => {
    // Storage saves the record and then the reply is lost, as with a timeout.
    let lost = false;
    const w = world(s => ({ ...s, put: async (k, v, c) => { await s.put(k, v, c); if (k.endsWith('/meta') && !lost) { lost = true; throw new Error('reply lost'); } } }));
    const alice = w.person('alice'); w.post('p1', 'alice');
    const owner = w.release.ownerKey(alice.user), context = { ownerDid: owner.owner_did, entryId: 'p1' };
    const sealed = sealFull(Buffer.from('kept although the reply was lost'), context, owner.owner_public_key);
    const body = { entry_id: 'p1', full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } };
    expect(await w.release.putTrace(alice.user, body)).toMatchObject({ stored: true, full_sha256: sealed.meta.sha256 });
    const got = (await w.release.getTrace(alice.user, 'p1', 'full'))!;
    expect(openFull(got.meta, Buffer.from(got.data, 'base64'), context, alice.wallet.privateKey).toString()).toBe('kept although the reply was lost');
    await expect(w.release.putTrace(alice.user, body)).rejects.toThrow('already has its trace');
  });

  it('keeps its chunks when a write fails without a clear answer, so a record that lands late still opens', async () => {
    // The record write reports a failure, reading back finds nothing, and storage saves the record afterwards.
    const late: { save?: () => Promise<void> } = {};
    const w = world(s => ({ ...s, put: async (k, v, c) => { if (k.endsWith('/meta') && !late.save) { late.save = () => s.put(k, v, c); throw new Error('reply lost'); } await s.put(k, v, c); } }));
    const alice = w.person('alice'); w.post('p1', 'alice');
    const owner = w.release.ownerKey(alice.user), context = { ownerDid: owner.owner_did, entryId: 'p1' };
    const sealed = sealFull(Buffer.from('landed late'), context, owner.owner_public_key);
    const body = { entry_id: 'p1', full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } };
    await expect(w.release.putTrace(alice.user, body)).rejects.toThrow('reply lost');
    expect([...w.stores.get('alice')!.keys()].length).toBeGreaterThan(0);   // chunks kept, no record yet
    expect(await w.release.getTrace(alice.user, 'p1', 'full')).toBeNull();
    await late.save!();
    const got = (await w.release.getTrace(alice.user, 'p1', 'full'))!;
    expect(openFull(got.meta, Buffer.from(got.data, 'base64'), context, alice.wallet.privateKey).toString()).toBe('landed late');
  });

  it('allows a retry after a write that never landed, and removes its chunks only when another upload owns the post', async () => {
    let failed = false;
    const w = world(s => ({ ...s, put: async (k, v, c) => { if (k.endsWith('/meta') && !failed) { failed = true; throw new Error('storage unavailable'); } await s.put(k, v, c); } }));
    const alice = w.person('alice'); w.post('p1', 'alice');
    const owner = w.release.ownerKey(alice.user), context = { ownerDid: owner.owner_did, entryId: 'p1' };
    const sealed = sealFull(Buffer.from('second attempt'), context, owner.owner_public_key);
    const body = { entry_id: 'p1', full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } };
    await expect(w.release.putTrace(alice.user, body)).rejects.toThrow('storage unavailable');
    const orphans = [...w.stores.get('alice')!.keys()];
    expect(orphans.length).toBeGreaterThan(0);
    expect(await w.release.putTrace(alice.user, body)).toMatchObject({ stored: true });
    const got = (await w.release.getTrace(alice.user, 'p1', 'full'))!;
    expect(openFull(got.meta, Buffer.from(got.data, 'base64'), context, alice.wallet.privateKey).toString()).toBe('second attempt');
    // A third upload finds the post taken and leaves nothing of its own behind.
    const before = w.stores.get('alice')!.size;
    await expect(w.release.putTrace(alice.user, body)).rejects.toThrow('already has its trace');
    expect(w.stores.get('alice')!.size).toBe(before);
    expect(await w.release.listTraces(alice.user)).toEqual(['p1']);
  });

  it('refuses everything that would need a release key', async () => {
    const w = world(); const alice = w.person('alice'); w.post('p1', 'alice');
    expect(w.release.releaseEnabled).toBe(false); expect(w.release.releaseKey).toBeNull();
    const c = { ownerDid: alice.user.tinycloud!.ownerDid, entryId: 'p1' };
    const full = sealFull(Buffer.from('x'), c, alice.wallet.signingKey.compressedPublicKey);
    const derived = sealPart(Buffer.from('y'), c, 'derived', { owner: alice.wallet.signingKey.compressedPublicKey, release: testWallet('someone').signingKey.compressedPublicKey });
    await expect(w.release.putTrace(alice.user, { entry_id: 'p1', full: { meta: full.meta, data: full.ciphertext.toString('base64') },
      derived: { meta: derived.meta, data: derived.ciphertext.toString('base64'), policy_id: 'any' } })).rejects.toThrow('runs_not_enabled');
    await expect(w.release.draftPolicy(alice.user, { triggers: ['alice'] })).rejects.toThrow('not enabled');
    await expect(w.release.run(alice.user, { template: 'skill-check', params: {}, entry_ids: ['p1'] })).rejects.toThrow('not enabled');
    expect(w.release.consentStatus(alice.user)).toMatchObject({ active: false, reason: 'runs_not_enabled', release_key: null });
  });
});

describe('The client and server envelopes are the same format', () => {
  const wallet = testWallet('format-check');
  const c = { ownerDid: `did:pkh:eip155:1:${wallet.address}`, entryId: 'entry-format' };
  it('opens each other\'s records', () => {
    const fromClient = sealFull(Buffer.from('sealed by the capture client'), c, wallet.signingKey.publicKey);
    expect(checkPartMeta(fromClient.meta, ['owner'], ['release'])).toEqual(fromClient.meta);
    expect(openPart(fromClient.meta, fromClient.ciphertext, c, 'full', 'owner', wallet.privateKey).toString()).toBe('sealed by the capture client');
    const fromServer = sealPart(Buffer.from('sealed by the server code'), c, 'full', { owner: wallet.signingKey.compressedPublicKey });
    expect(openFull(fromServer.meta, fromServer.ciphertext, c, wallet.privateKey).toString()).toBe('sealed by the server code');
  });
});
