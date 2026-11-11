import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { testWallet, versionedMemoryStore } from './author-test-fixtures.js';
import { insightsRelease, parseAnswer, insightsProgram, checkUpgradePolicy, MIN_PEOPLE, type InsightsPolicy, type UpgradePolicy } from './insights-release.js';
import { sealPart, openPart, publicKeyOf } from './trace-envelope.js';
import type { JournalEntry, User } from './storage.js';

// Synthetic people and synthetic work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic release key').digest('hex');
const BASE = 'https://router.example';
const LOG_A = 'USER: run the long evaluation\nTOOL: started the full run with a short timeout\nTOOL: failed after forty minutes on a bad argument\nUSER: try again';
const LOG_B = 'USER: tidy the notes\nASSISTANT: reorganised three sections and left the rest alone';

function world(reply = (log: string) => JSON.stringify(log.includes('timeout')
  ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: 'A tiny trial run first would have exposed the mistake early.' }
  : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' }), opts: { upgrades?: UpgradePolicy } = {}) {
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
    upgrades: opts.upgrades,
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
  return { release, person, post, consent, upload, calls, stores, users, advance: (ms: number) => { clock += ms; } };
}
const question = { template: 'skill-check', params: { skill: 'Smoke test before long runs', when: 'a run is expected to take more than a few minutes' } };

describe('Private traces and insights runs', () => {
  it('reads consenting owners\' traces once, returns counts, and holds notes for their owner', async () => {
    const w = world();
    const alice = w.person('alice'), bob = w.person('bob'), carol = w.person('carol'), agent = w.person('insights', false);
    w.post('p-alice', 'alice'); w.post('p-bob', 'bob'); w.post('p-carol', 'carol');
    await w.upload(alice, 'p-alice', LOG_A, await w.consent(alice, ['insights']));
    await w.upload(bob, 'p-bob', LOG_B, await w.consent(bob, ['insights']));
    await w.upload(carol, 'p-carol', LOG_B, await w.consent(carol, ['insights']));

    const result = await w.release.run(agent.user, { ...question, entry_ids: ['p-alice', 'p-bob', 'p-carol'] });
    expect(result).toMatchObject({ released: true, traces_read: 3, people: 3, people_where_it_applies: 1, applies: { yes: 1, no: 2 }, notes: [], notes_waiting_for_owner: 1 });
    expect(w.calls).toHaveLength(3);
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
    const again = await w.release.run(agent.user, { ...question, entry_ids: ['p-alice', 'p-bob', 'p-carol'] });
    expect(again).toMatchObject({ released: false, skipped: { already_read_for_this_question: 3 } });
  });

  it(`releases nothing about the answers when fewer than ${MIN_PEOPLE} people's traces were read`, async () => {
    const w = world();
    const alice = w.person('alice'), bob = w.person('bob'), agent = w.person('insights', false);
    w.post('p-alice', 'alice'); w.post('p-bob', 'bob');
    await w.upload(alice, 'p-alice', LOG_A, await w.consent(alice, ['insights']));
    await w.upload(bob, 'p-bob', LOG_B, await w.consent(bob, ['insights']));

    const result = await w.release.run(agent.user, { ...question, entry_ids: ['p-alice', 'p-bob'] }) as any;
    expect(result).toMatchObject({ released: false, withheld: `fewer than ${MIN_PEOPLE} people's traces were read` });
    for (const field of ['traces_read', 'people', 'applies', 'effect', 'cost', 'notes']) expect(result[field]).toBeUndefined();

    // Owners still see their own answers, and an approved note still stays in.
    await w.release.decideNote(alice.user, result.run_id, 'p-alice', true);
    expect(w.release.getRun(alice.user, result.run_id).your_traces).toMatchObject([{ entry_id: 'p-alice', note_status: 'approved' }]);
    expect(w.release.getRun(agent.user, result.run_id).notes).toBeUndefined();
    expect(await w.release.receipts(bob.user)).toHaveLength(1);
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
    expect(result.released).toBe(false);
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

  it('checks the stored consent\'s signature on every use, so an edited account record grants nothing', async () => {
    const w = world();
    const agent = w.person('insights', false);
    const people = ['alice', 'bob', 'carol'].map(h => w.person(h));
    for (const p of people) { w.post(`p-${p.user.handle}`, p.user.handle); await w.upload(p, `p-${p.user.handle}`, LOG_A, await w.consent(p, ['insights'])); }
    expect(w.release.consentStatus(people[0].user)).toMatchObject({ active: true });

    // Someone with write access to the account records widens Alice's scope and names another requester.
    const alice = w.users.get('alice');
    w.users.set('alice', { ...alice, insightsConsent: { ...alice.insightsConsent, policy: { ...alice.insightsConsent.policy,
      scope: { groups: ['insights-notes', 'everything'] } } } });
    expect(w.release.consentStatus(people[0].user)).toMatchObject({ active: false, reason: 'bad_signature' });
    const result = await w.release.run(agent.user, { ...question, entry_ids: people.map(p => `p-${p.user.handle}`) });
    expect(result).toMatchObject({ released: false, skipped: { no_consent: 1 } });
    expect(w.calls).toHaveLength(2);
  });

  it('names the declared upgrade policy in the consent, and a consent signed under another policy does not count', async () => {
    const timelock = checkUpgradePolicy({ by: 'timelock', chain: 'base', appContract: '0x' + 'aB'.repeat(20), timelock: '0x' + 'cd'.repeat(20), delayHours: 48 });
    expect(timelock).toMatchObject({ appContract: '0x' + 'ab'.repeat(20) });
    for (const bad of [{ by: 'timelock', chain: 'base', appContract: '0x12', timelock: '0x' + 'cd'.repeat(20), delayHours: 48 },
      { ...timelock, delayHours: 1 }, { by: 'operator', extra: true }, { by: 'someone' }])
      expect(() => checkUpgradePolicy(bad)).toThrow();

    const w = world(undefined, { upgrades: timelock });
    const alice = w.person('alice'); w.person('insights', false);
    const { message } = await w.release.draftPolicy(alice.user, { triggers: ['insights'] });
    expect(message).toContain(`only through a public 48-hour timelock on base (app contract 0x${'ab'.repeat(20)}, timelock 0x${'cd'.repeat(20)})`);
    expect(message).not.toContain('approved by the operator');
    expect(w.release.info()).toMatchObject({ upgrades: timelock, min_people: MIN_PEOPLE });

    // A policy drafted under the operator, signed and then presented here, is refused.
    const opWorld = world();
    const bobOp = opWorld.person('bob'); opWorld.person('insights', false);
    const drafted = await opWorld.release.draftPolicy(bobOp.user, { triggers: ['insights'] });
    expect(drafted.message).toContain('approved by the operator');
    const bob = w.person('bob');
    const forged = { ...drafted.policy, server: BASE, owner: { handle: 'bob', did: bob.user.tinycloud!.ownerDid } };
    await expect(w.release.saveConsent(bob.user, forged, await bob.wallet.signMessage(drafted.message))).rejects.toThrow('does not match');
  });

  describe('run requests', () => {
    const setup = async (names: string[], opts: { consent?: string[] } = {}) => {
      const w = world();
      const agent = w.person('insights', false);
      const people: Record<string, ReturnType<typeof w.person>> = {};
      const posts: string[] = [];   // neutral IDs, so a test can check that no name appears in public
      for (const [i, name] of names.entries()) {
        const p = people[name] = w.person(name);
        const postId = `post-${i + 1}`;
        posts.push(postId);
        w.post(postId, name);
        if (!opts.consent || opts.consent.includes(name)) await w.upload(p, postId, name === 'alice' ? LOG_A : LOG_B, await w.consent(p, ['insights']));
      }
      return { w, agent, people, posts };
    };

    it('is registered in public, and its run starts once everyone has answered', async () => {
      const { w, agent, people, posts } = await setup(['alice', 'bob', 'carol', 'dave']);
      await expect(w.release.createRequest(agent.user, { ...question, entry_ids: posts.slice(0, 2) })).rejects.toThrow(`at least ${MIN_PEOPLE} people`);
      const created = await w.release.createRequest(agent.user, { ...question, entry_ids: [...posts, 'missing'] });
      expect(created).toMatchObject({ status: 'open', people_asked: 4, answered: 0, agreed: 0, min_people: MIN_PEOPLE, posts, posts_not_published: 1 });
      const id = created.request_id;

      // Only people whose posts were chosen can answer, and the public register shows counts, not names.
      await expect(w.release.answerRequest(w.person('erin').user, id, 'yes')).rejects.toThrow('No such request');
      await expect(w.release.answerRequest(people.alice.user, id, 'maybe')).rejects.toThrow('yes');
      await w.release.answerRequest(people.alice.user, id, 'yes');
      await w.release.answerRequest(people.bob.user, id, 'no');
      await w.release.answerRequest(people.carol.user, id, 'yes');
      const listed = w.release.listRequests()[0];
      expect(listed).toMatchObject({ request_id: id, status: 'open', answered: 3, agreed: 2 });
      expect(JSON.stringify(listed)).not.toMatch(/alice|bob|carol|dave/);
      expect(w.release.myRequests(people.bob.user)[0]).toMatchObject({ your_posts: ['post-2'], your_answer: 'no' });
      expect(w.calls).toHaveLength(0);

      // The last answer starts the run over the posts of those who said yes.
      const last = await w.release.answerRequest(people.dave.user, id, 'yes');
      expect(last).toMatchObject({ status: 'started', answered: 4, agreed: 3 });
      expect(last.run_id).toBeTruthy();
      expect(w.calls).toHaveLength(3);
      expect(w.release.getRun(agent.user, last.run_id!)).toMatchObject({ request_id: id, released: true, people: 3, traces_read: 3 });
      await expect(w.release.answerRequest(people.bob.user, id, 'yes')).rejects.toThrow('no longer open');
    });

    it('closes without a run when too few agree, and a yes needs a current consent naming the requester', async () => {
      const { w, agent, people, posts } = await setup(['alice', 'bob', 'carol'], { consent: ['alice', 'bob'] });
      const { request_id: id } = await w.release.createRequest(agent.user, { ...question, entry_ids: posts });
      await expect(w.release.answerRequest(people.carol.user, id, 'yes')).rejects.toThrow('no current insights consent');
      await w.release.answerRequest(people.alice.user, id, 'yes');
      await w.release.answerRequest(people.bob.user, id, 'yes');
      const closed = await w.release.answerRequest(people.carol.user, id, 'no');
      expect(closed).toMatchObject({ status: 'not_enough_people', run_id: null });
      expect(w.calls).toHaveLength(0);
    });

    it('at the deadline, runs with those who agreed if enough did, and otherwise expires', async () => {
      const { w, agent, people, posts } = await setup(['alice', 'bob', 'carol', 'dave']);
      const first = await w.release.createRequest(agent.user, { ...question, entry_ids: posts, deadline_hours: 24 });
      const second = await w.release.createRequest(agent.user, { template: 'skill-check', params: { skill: 'Ask before narrowing scope', when: 'an input is about to be swapped' }, entry_ids: posts, deadline_hours: 24 });
      for (const p of [people.alice, people.bob, people.carol]) await w.release.answerRequest(p.user, first.request_id, 'yes');
      await w.release.answerRequest(people.alice.user, second.request_id, 'yes');

      await w.release.checkRequests();
      expect(w.release.listRequests().map(r => r.status)).toEqual(['open', 'open']);
      w.advance(24 * 3600_000);
      await w.release.checkRequests();
      const byId = new Map(w.release.listRequests().map(r => [r.request_id, r]));
      expect(byId.get(first.request_id)).toMatchObject({ status: 'started', agreed: 3 });
      expect(byId.get(second.request_id)).toMatchObject({ status: 'expired', run_id: null });
      expect(w.calls).toHaveLength(3);
      await expect(w.release.createRequest(agent.user, { ...question, entry_ids: posts, deadline_hours: 500 })).rejects.toThrow('deadline_hours');
    });
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
