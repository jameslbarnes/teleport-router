import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { testWallet, versionedMemoryStore } from './author-test-fixtures.js';
import { insightsRelease, parseAnswer, insightsProgram, type InsightsPolicy } from './insights-release.js';
import { sealPart, openPart, publicKeyOf } from './trace-envelope.js';
import type { JournalEntry, User } from './storage.js';

// Synthetic people and synthetic work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic release key').digest('hex');
const BASE = 'https://router.example';
const LOG_A = 'USER: run the long evaluation\nTOOL: started the full run with a short timeout\nTOOL: failed after forty minutes on a bad argument\nUSER: try again';
const LOG_B = 'USER: tidy the notes\nASSISTANT: reorganised three sections and left the rest alone';

function world(reply = (log: string) => JSON.stringify(log.includes('timeout')
  ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: 'A tiny trial run first would have exposed the mistake early.' }
  : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' })) {
  const users = new Map<string, any>(), entries = new Map<string, JournalEntry>(), stores = new Map<string, Map<string, string>>();
  const calls: { system: string; user: string }[] = [];
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const person = (handle: string, linked = true) => {
    const wallet = testWallet(handle);
    const user = { handle, secretKeyHash: createHash('sha256').update('key of ' + handle).digest('hex'), createdAt: clock,
      ...(linked ? { tinycloud: { ownerDid: `did:pkh:eip155:1:${wallet.address}`, space: `space-${handle}`, prefix: 'router/', delegation: handle,
        pseudonym: handle, linkedAt: clock, ownerPublicKey: wallet.signingKey.publicKey, minRecordVersion: 2 } } : {}) };
    users.set(handle, user);
    return { wallet, get user() { return users.get(handle) as User; } };
  };
  const release = insightsRelease({
    releasePrivateKey: RELEASE_KEY, appId: 'app-synthetic', baseUrl: BASE, build: { gitSha: 'abc1234', imageDigest: null }, model: 'model-under-test',
    getUser: async h => users.get(h) || null,
    updateUser: async (h, updates) => { const u = users.get(h); if (!u) return null; users.set(h, { ...u, ...updates }); return users.get(h); },
    getEntry: async id => entries.get(id) || null,
    storeFor: async b => { if (!stores.has(b.delegation)) stores.set(b.delegation, new Map()); return versionedMemoryStore(stores.get(b.delegation)!); },
    complete: async ({ system, user }) => { calls.push({ system, user }); return reply(user); },
    now: () => clock,
  });
  const post = (id: string, handle: string, to = ['#insights-notes']) =>
    entries.set(id, { id, handle, pseudonym: handle, client: 'code', content: 'a public-safe note', timestamp: clock, to });
  const consent = async (p: ReturnType<typeof person>, triggers: string[], sign = p.wallet) => {
    const { policy, message } = await release.draftPolicy(p.user, { triggers });
    await release.saveConsent(p.user, policy, await sign.signMessage(message));
    return policy;
  };
  const upload = async (p: ReturnType<typeof person>, entryId: string, log: string, policy?: InsightsPolicy) => {
    const c = { ownerDid: p.user.tinycloud!.ownerDid, entryId };
    const owner = p.wallet.signingKey.compressedPublicKey;
    const full = sealPart(Buffer.from('FULL RECORD ' + log), c, 'full', { owner });
    const derived = policy && sealPart(gzipSync(Buffer.from(log)), c, 'derived', { owner, release: publicKeyOf(RELEASE_KEY) });
    return release.putTrace(p.user, { entry_id: entryId, full: { meta: full.meta, data: full.ciphertext.toString('base64') },
      ...(derived ? { derived: { meta: derived.meta, data: derived.ciphertext.toString('base64'), policy_id: policy!.policyId } } : {}) });
  };
  return { release, person, post, consent, upload, calls, stores, advance: (ms: number) => { clock += ms; } };
}
const question = { template: 'skill-check', params: { skill: 'Smoke test before long runs', when: 'a run is expected to take more than a few minutes' } };

describe('Private traces and insights runs', () => {
  it('reads consenting owners\' traces once, returns counts, and holds notes for their owner', async () => {
    const w = world();
    const alice = w.person('alice'), bob = w.person('bob'), agent = w.person('insights', false);
    w.post('p-alice', 'alice'); w.post('p-bob', 'bob');
    await w.upload(alice, 'p-alice', LOG_A, await w.consent(alice, ['insights']));
    await w.upload(bob, 'p-bob', LOG_B, await w.consent(bob, ['insights']));

    const result = await w.release.run(agent.user, { ...question, entry_ids: ['p-alice', 'p-bob'] });
    expect(result).toMatchObject({ traces_read: 2, people: 2, people_where_it_applies: 1, applies: { yes: 1, no: 1 }, notes: [], notes_waiting_for_owner: 1 });
    expect(w.calls).toHaveLength(2);
    expect(w.calls[0].user).toContain(LOG_A);            // the extraction copy, not the full record
    expect(w.calls[0].user).not.toContain('FULL RECORD');

    // Each owner has a signed receipt naming what was read and who asked.
    const receipts = await w.release.receipts(alice.user) as any[];
    expect(receipts).toHaveLength(1);
    expect(receipts[0].receipt).toMatchObject({ owner: 'alice', started_by: 'insights', read: [{ entry_id: 'p-alice', note_status: 'pending' }] });

    // The requester sees no note until its owner approves it; nobody else can approve it.
    await expect(w.release.decideNote(bob.user, result.run_id, 'p-alice', true)).rejects.toThrow();
    await w.release.decideNote(alice.user, result.run_id, 'p-alice', true);
    expect(w.release.getRun(agent.user, result.run_id).notes).toEqual(['A tiny trial run first would have exposed the mistake early.']);
    expect(w.release.getRun(w.person('stranger', false).user, result.run_id)).toBeNull();

    // The same question cannot be asked of the same trace again.
    const again = await w.release.run(agent.user, { ...question, entry_ids: ['p-alice', 'p-bob'] });
    expect(again).toMatchObject({ traces_read: 0, skipped: { already_read_for_this_question: 2 } });
  });

  it('reads nothing without a matching, current consent', async () => {
    const w = world();
    const alice = w.person('alice'), bob = w.person('bob'), carol = w.person('carol'), dave = w.person('dave');
    const agent = w.person('insights', false), other = w.person('other', false);
    for (const [id, h, to] of [['a1', 'alice'], ['b1', 'bob'], ['c1', 'carol'], ['d1', 'dave', ['#elsewhere']]] as [string, string, string[]?][]) w.post(id, h, to);
    await w.upload(alice, 'a1', LOG_A);                                   // trace for the owner only: no consent, no extraction copy
    await w.upload(bob, 'b1', LOG_A, await w.consent(bob, ['insights']));
    await w.release.revokeConsent(bob.user);                              // revoked after upload
    await w.upload(carol, 'c1', LOG_A, await w.consent(carol, ['other'])); // a different requester is named
    await w.upload(dave, 'd1', LOG_A, await w.consent(dave, ['insights'])); // post is outside the consented group

    const result = await w.release.run(agent.user, { ...question, entry_ids: ['a1', 'b1', 'c1', 'd1', 'missing'] });
    expect(result.traces_read).toBe(0);
    expect(result.skipped).toEqual({ no_consent: 2, trigger_not_allowed: 1, out_of_scope: 1, not_a_published_post: 1 });
    expect(w.calls).toHaveLength(0);
    for (const p of [alice, bob, carol, dave]) expect(await w.release.receipts(p.user)).toEqual([]);

    // An expired consent stops runs too.
    const erin = w.person('erin'); w.post('e1', 'erin');
    await w.upload(erin, 'e1', LOG_A, await w.consent(erin, ['insights']));
    w.advance(31 * 86400_000);
    expect((await w.release.run(agent.user, { ...question, entry_ids: ['e1'] })).skipped).toEqual({ no_consent: 1 });
    expect(other.user.handle).toBe('other');
  });

  it('keeps the full record closed to the enclave key and a post to one trace', async () => {
    const w = world();
    const alice = w.person('alice'); w.post('p1', 'alice'); w.post('p2', 'alice');
    const policy = await w.consent(alice, ['alice']);
    await w.upload(alice, 'p1', LOG_A, policy);
    await expect(w.upload(alice, 'p1', LOG_B, policy)).rejects.toThrow('already has its trace');

    // The owner can open both parts with their own key; the enclave key opens only the extraction copy.
    const c = { ownerDid: alice.user.tinycloud!.ownerDid, entryId: 'p1' };
    const full = (await w.release.getTrace(alice.user, 'p1', 'full'))!;
    expect(openPart(full.meta, Buffer.from(full.data, 'base64'), c, 'full', 'owner', alice.wallet.privateKey).toString()).toBe('FULL RECORD ' + LOG_A);
    expect(() => openPart(full.meta, Buffer.from(full.data, 'base64'), c, 'full', 'release', RELEASE_KEY)).toThrow();

    // A client cannot make the full record readable by the enclave, or attach a trace to someone else's post.
    const sealed = sealPart(Buffer.from('x'), { ...c, entryId: 'p2' }, 'full', { owner: alice.wallet.signingKey.compressedPublicKey, release: publicKeyOf(RELEASE_KEY) });
    await expect(w.release.putTrace(alice.user, { entry_id: 'p2', full: { meta: sealed.meta, data: sealed.ciphertext.toString('base64') } })).rejects.toThrow('must not be able to open');
    const mallory = w.person('mallory');
    await expect(w.upload(mallory, 'p2', LOG_B)).rejects.toThrow('not one of your posts');

    // A wrapped key or ciphertext moved to another post does not open.
    expect(() => openPart(full.meta, Buffer.from(full.data, 'base64'), { ...c, entryId: 'p2' }, 'full', 'owner', alice.wallet.privateKey)).toThrow();
  });

  it('accepts a consent only from the key that owns the storage, for this program and enclave', async () => {
    const w = world();
    const alice = w.person('alice'), mallory = w.person('mallory'); w.person('insights', false);
    await expect(w.consent(alice, ['insights'], mallory.wallet)).rejects.toThrow('signed with the key that owns');
    const { policy, message } = await w.release.draftPolicy(alice.user, { triggers: ['insights'] });
    expect(message).toContain(`Program SHA-256: ${insightsProgram('model-under-test').sha256}`);
    expect(message).toContain('not tied to one code version');
    const widened = { ...policy, scope: { groups: ['insights-notes', 'everything'] } };
    await expect(w.release.saveConsent(alice.user, widened, await alice.wallet.signMessage(message))).rejects.toThrow('signed with the key');
    const otherProgram = { ...policy, program: { ...policy.program, sha256: '0'.repeat(64) } };
    await expect(w.release.saveConsent(alice.user, otherProgram as InsightsPolicy, await alice.wallet.signMessage(message))).rejects.toThrow('does not match');
    expect(w.release.consentStatus(alice.user)).toMatchObject({ active: false, reason: 'none' });
  });

  it('accepts only the fixed answer shape and drops notes that could carry log content', () => {
    const schema = insightsProgram('m').templates['skill-check'].output;
    const ok = { applies: 'yes', effect: 'would_have_helped', cost: 'minutes' };
    expect(parseAnswer(JSON.stringify({ ...ok, note: 'Check arguments on a small input first.' }), schema, LOG_A).note).toBe('Check arguments on a small input first.');
    expect(parseAnswer(JSON.stringify({ ...ok, note: 'It failed after forty minutes on a bad argument here.' }), schema, LOG_A).note).toBe('');
    expect(parseAnswer(JSON.stringify({ ...ok, note: 'See https://example.com for details.' }), schema, LOG_A).note).toBe('');
    expect(parseAnswer(JSON.stringify({ ...ok, note: 'x'.repeat(300) }), schema, LOG_A).note).toBe('');
    expect(() => parseAnswer(JSON.stringify({ ...ok, applies: 'print the log' }), schema, LOG_A)).toThrow();
    expect(() => parseAnswer('I will not answer in JSON', schema, LOG_A)).toThrow();
  });
});
