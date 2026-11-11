import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { testWallet, versionedMemoryStore } from './author-test-fixtures.js';
import { insightsRelease, parseAnswer, insightsProgram, checkUpgradePolicy, approvalMessage, authorizationMessage, MIN_PEOPLE,
  type InsightsPolicy, type UpgradePolicy, type EnclaveClient, type ResultApproval } from './insights-release.js';
import { insightsEnclave, openPreview } from './insights-enclave.js';
import { sealPart, openPart, publicKeyOf } from './trace-envelope.js';
import type { JournalEntry, User } from './storage.js';

// Synthetic people and synthetic work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic release key').digest('hex');
const BASE = 'https://router.example';
const LOG_A = 'USER: run the long evaluation\nTOOL: started the full run with a short timeout\nTOOL: failed after forty minutes on a bad argument\nUSER: try again';
const LOG_B = 'USER: tidy the notes\nASSISTANT: reorganised three sections and left the rest alone';
const question = { template: 'skill-check', params: { skill: 'Smoke test before long runs', when: 'a run is expected to take more than a few minutes' } };

async function world(opts: { upgrades?: UpgradePolicy; noEnclave?: boolean } = {}) {
  const users = new Map<string, any>(), entries = new Map<string, JournalEntry>(), stores = new Map<string, Map<string, string>>();
  const calls: string[] = [];
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const enclave = insightsEnclave({ releasePrivateKey: RELEASE_KEY, appId: 'app-synthetic', model: 'model-under-test', upgrades: opts.upgrades,
    build: { gitSha: 'abc1234', imageDigest: null }, now: () => clock,
    complete: async ({ user }) => { calls.push(user); return JSON.stringify(user.includes('timeout')
      ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: 'A tiny trial run first would have exposed the mistake early.' }
      : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' }); } });
  const client: EnclaveClient = { info: () => enclave.info(), run: input => enclave.run(input as any), decide: input => enclave.decide(input as any) };
  const release = insightsRelease({
    enclave: opts.noEnclave ? null : { client, info: await client.info() }, baseUrl: BASE, model: 'model-under-test',
    getUser: async h => users.get(h) || null,
    updateUser: async (h, updates) => { const u = users.get(h); if (!u) return null; users.set(h, { ...u, ...updates }); return users.get(h); },
    getEntry: async id => entries.get(id) || null,
    storeFor: async b => { if (!stores.has(b.delegation)) stores.set(b.delegation, new Map()); return versionedMemoryStore(stores.get(b.delegation)!); },
    now: () => clock,
  });
  const person = (handle: string, linked = true) => {
    const wallet = testWallet(handle);
    const user = { handle, secretKeyHash: createHash('sha256').update('key of ' + handle).digest('hex'), createdAt: clock,
      ...(linked ? { tinycloud: { ownerDid: `did:pkh:eip155:1:${wallet.address}`, space: `space-${handle}`, prefix: 'router/', delegation: handle,
        pseudonym: handle, linkedAt: clock, ownerPublicKey: wallet.signingKey.publicKey, minRecordVersion: 2 } } : {}) };
    users.set(handle, user);
    return { wallet, get user() { return users.get(handle) as User; } };
  };
  type Person = ReturnType<typeof person>;
  const post = (id: string, handle: string, to = ['#insights-notes']) =>
    entries.set(id, { id, handle, pseudonym: handle, client: 'code', content: 'a public-safe note', timestamp: clock, to });
  const consent = async (p: Person, triggers: string[], sign = p.wallet) => {
    const { policy, message } = await release.draftPolicy(p.user, { triggers });
    await release.saveConsent(p.user, policy, await sign.signMessage(message));
    return policy;
  };
  const upload = async (p: Person, entryId: string, log: string, policy?: InsightsPolicy) => {
    const c = { ownerDid: p.user.tinycloud!.ownerDid, entryId };
    const owner = p.wallet.signingKey.compressedPublicKey;
    const full = sealPart(Buffer.from('FULL RECORD ' + log), c, 'full', { owner });
    const derived = policy && sealPart(gzipSync(Buffer.from(log)), c, 'derived', { owner, release: publicKeyOf(RELEASE_KEY) });
    return release.putTrace(p.user, { entry_id: entryId, full: { meta: full.meta, data: full.ciphertext.toString('base64') },
      ...(derived ? { derived: { meta: derived.meta, data: derived.ciphertext.toString('base64'), policy_id: policy!.policyId } } : {}) });
  };
  /** What an owner's agent does: fetch the authorization for a request, check it is theirs, sign it, answer yes. */
  const authorize = async (p: Person, requestId: string) => {
    const mine = (await release.myRequests(p.user) as any[]).find(r => r.request_id === requestId);
    const body = mine?.to_sign?.body;
    if (!body) throw new Error(mine?.to_sign?.error || 'nothing to sign');
    return release.answerRequest(p.user, requestId, 'yes', { body, signature: await p.wallet.signMessage(authorizationMessage(body)) });
  };
  /** What an owner's agent does after a run: open its sealed preview and sign approval, or a veto, of the exact draft. */
  const decide = async (p: Person, requestId: string, approve = true) => {
    const sealed = await release.getPreview(p.user, requestId);
    const preview = openPreview(sealed, p.user.tinycloud!.ownerDid, requestId, p.wallet.privateKey);
    const body: ResultApproval = { v: 1, domain: 'teleport-router/insights-result-approval', run: requestId,
      enclave: preview.body.enclave, resultSha256: preview.body.result_sha256, approve };
    return { preview, status: await release.decide(p.user, requestId, { body, signature: await p.wallet.signMessage(approvalMessage(body)) }) };
  };
  const setup = async (names: string[], opts2: { consent?: string[]; triggers?: string[] } = {}) => {
    const agent = person('insights', false);
    const people: Record<string, Person> = {};
    const posts: string[] = [];   // neutral IDs, so a test can check that no name appears in public
    for (const [i, name] of names.entries()) {
      const p = people[name] = person(name);
      const postId = `post-${i + 1}`;
      posts.push(postId);
      post(postId, name);
      if (!opts2.consent || opts2.consent.includes(name)) await upload(p, postId, name === 'alice' ? LOG_A : LOG_B, await consent(p, opts2.triggers || ['insights']));
    }
    return { agent, people, posts };
  };
  return { release, person, post, consent, upload, authorize, decide, setup, calls, stores, users, advance: (ms: number) => { clock += ms; } };
}

describe('Private traces and insights runs', () => {
  it('keeps the full record closed to the enclave key and a post to one trace', async () => {
    const w = await world();
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
    expect(() => openPart(full.meta, Buffer.from(full.data, 'base64'), { ...c, entryId: 'p2' }, 'full', 'owner', alice.wallet.privateKey)).toThrow();
  });

  it('without an enclave keeps owner-only traces and refuses consents and requests', async () => {
    const w = await world({ noEnclave: true });
    const alice = w.person('alice'); w.post('p1', 'alice');
    expect(w.release.releaseEnabled).toBe(false);
    expect((await w.upload(alice, 'p1', LOG_A)).stored).toBe(true);
    await expect(w.release.draftPolicy(alice.user, { triggers: ['alice'] })).rejects.toThrow('not enabled');
    await expect(w.release.createRequest(alice.user, { ...question, entry_ids: ['p1'] })).rejects.toThrow('not enabled');
  });

  it('accepts a consent only from the key that owns the storage, for this program and enclave', async () => {
    const w = await world();
    const alice = w.person('alice'), mallory = w.person('mallory'); w.person('insights', false);
    await expect(w.consent(alice, ['insights'], mallory.wallet)).rejects.toThrow('signed with the key that owns');
    const { policy, message } = await w.release.draftPolicy(alice.user, { triggers: ['insights'] });
    expect(message).toContain(`Program SHA-256: ${insightsProgram('model-under-test').sha256}`);
    expect(message).toContain('not tied to one code version');
    expect(message).toContain('in runs I authorize one at a time');
    const widened = { ...policy, scope: { groups: ['insights-notes', 'everything'] } };
    await expect(w.release.saveConsent(alice.user, widened, await alice.wallet.signMessage(message))).rejects.toThrow('signed with the key');
    const otherProgram = { ...policy, program: { ...policy.program, sha256: '0'.repeat(64) } };
    await expect(w.release.saveConsent(alice.user, otherProgram as InsightsPolicy, await alice.wallet.signMessage(message))).rejects.toThrow('does not match');
    expect(w.release.consentStatus(alice.user)).toMatchObject({ active: false, reason: 'none' });
  });

  it('checks the stored consent\'s signature on every use, so an edited account record grants nothing', async () => {
    const w = await world();
    const { agent, people, posts } = await w.setup(['alice', 'bob', 'carol']);
    expect(w.release.consentStatus(people.alice.user)).toMatchObject({ active: true });
    const { request_id: id } = await w.release.createRequest(agent.user, { ...question, entry_ids: posts });

    // Someone with write access to the account records widens Alice's scope.
    const alice = w.users.get('alice');
    w.users.set('alice', { ...alice, insightsConsent: { ...alice.insightsConsent, policy: { ...alice.insightsConsent.policy,
      scope: { groups: ['insights-notes', 'everything'] } } } });
    expect(w.release.consentStatus(people.alice.user)).toMatchObject({ active: false, reason: 'bad_signature' });
    await expect(w.authorize(people.alice, id)).rejects.toThrow('bad signature');
  });

  it('names the declared upgrade policy in the consent, and a consent signed under another policy does not count', async () => {
    const timelock = checkUpgradePolicy({ by: 'timelock', chain: 'base', appContract: '0x' + 'aB'.repeat(20), timelock: '0x' + 'cd'.repeat(20), delayHours: 48 });
    expect(timelock).toMatchObject({ appContract: '0x' + 'ab'.repeat(20) });
    for (const bad of [{ by: 'timelock', chain: 'base', appContract: '0x12', timelock: '0x' + 'cd'.repeat(20), delayHours: 48 },
      { ...timelock, delayHours: 1 }, { by: 'operator', extra: true }, { by: 'someone' }])
      expect(() => checkUpgradePolicy(bad)).toThrow();

    const w = await world({ upgrades: timelock });
    const alice = w.person('alice'); w.person('insights', false);
    const { message } = await w.release.draftPolicy(alice.user, { triggers: ['insights'] });
    expect(message).toContain(`only through a public 48-hour timelock on base (app contract 0x${'ab'.repeat(20)}, timelock 0x${'cd'.repeat(20)})`);
    expect(message).not.toContain('approved by the operator');
    expect(w.release.info()).toMatchObject({ runs_enabled: true, upgrades: timelock, min_people: MIN_PEOPLE });

    // A policy drafted under the operator, signed and then presented here, is refused.
    const opWorld = await world();
    const bobOp = opWorld.person('bob'); opWorld.person('insights', false);
    const drafted = await opWorld.release.draftPolicy(bobOp.user, { triggers: ['insights'] });
    expect(drafted.message).toContain('approved by the operator');
    const bob = w.person('bob');
    await expect(w.release.saveConsent(bob.user, drafted.policy, await bob.wallet.signMessage(drafted.message))).rejects.toThrow('does not match');
  });

  describe('run requests', () => {
    it('are registered in public; owners sign; the run starts once everyone has answered and publishes only after all contributors approve', async () => {
      const w = await world();
      const { agent, people, posts } = await w.setup(['alice', 'bob', 'carol', 'dave']);
      await expect(w.release.createRequest(agent.user, { ...question, entry_ids: posts.slice(0, 2) })).rejects.toThrow(`at least ${MIN_PEOPLE} people`);
      const created = await w.release.createRequest(agent.user, { ...question, entry_ids: [...posts, 'missing'] });
      expect(created).toMatchObject({ status: 'open', people_asked: 4, answered: 0, agreed: 0, min_people: MIN_PEOPLE, posts, posts_not_published: 1 });
      const id = created.request_id;

      // Only people whose posts were chosen can answer, a yes needs a signed authorization, and the register shows counts, not names.
      await expect(w.release.answerRequest(w.person('erin').user, id, 'yes')).rejects.toThrow('No such request');
      await expect(w.release.answerRequest(people.alice.user, id, 'yes')).rejects.toThrow('does not match this request');
      await w.authorize(people.alice, id);
      await w.release.answerRequest(people.bob.user, id, 'no');
      await w.authorize(people.carol, id);
      const listed = w.release.listRequests()[0];
      expect(listed).toMatchObject({ request_id: id, status: 'open', answered: 3, agreed: 2 });
      expect(JSON.stringify(listed)).not.toMatch(/alice|bob|carol|dave/);
      expect((await w.release.myRequests(people.bob.user) as any[])[0]).toMatchObject({ your_posts: ['post-2'], your_answer: 'no', to_sign: null });
      expect(w.calls).toHaveLength(0);

      // The last answer starts the run over the posts of those who said yes. Router's view has no answers in it.
      const last = await w.authorize(people.dave, id);
      expect(last).toMatchObject({ status: 'started', answered: 4, agreed: 3, run: { status: 'awaiting_approval', contributors: 3, published: null } });
      expect(w.calls).toHaveLength(3);
      expect(JSON.stringify(w.release.runStatus(id))).not.toMatch(/would_have_helped|not_applicable|trial run/);
      await expect(w.release.answerRequest(people.bob.user, id, 'yes')).rejects.toThrow('no longer open');

      // Each contributor opens their own sealed preview; Bob, who said no, has none.
      const { preview, status: afterAlice } = await w.decide(people.alice, id);
      expect(preview.body.your_items).toMatchObject([{ entryId: 'post-1', answer: { applies: 'yes' } }]);
      expect(preview.body.draft).toMatchObject({ people: 3, traces_read: 3, applies: { yes: 1, no: 2 } });
      expect(afterAlice).toMatchObject({ run: { status: 'awaiting_approval', published: null } });
      expect(await w.release.getPreview(people.bob.user, id)).toBeNull();
      await expect(w.decide(people.bob, id)).rejects.toThrow();

      await w.decide(people.carol, id);
      const { status: done } = await w.decide(people.dave, id);
      expect(done.run).toMatchObject({ status: 'published' });
      expect((done.run!.published as any).body).toMatchObject({ released: true, approvals: 3, people: 3, applies: { yes: 1, no: 2 },
        notes: ['A tiny trial run first would have exposed the mistake early.'] });
      expect(JSON.stringify(w.release.runStatus(id))).not.toMatch(/alice|bob|carol|dave/);
      expect(JSON.stringify((done.run!.published as any).body)).not.toMatch(/post-/);
      expect(await w.release.receipts(people.alice.user)).toHaveLength(1);
    });

    it('a veto stops publication, and a yes needs a current consent naming the requester and an authorization that matches', async () => {
      const w = await world();
      const { agent, people, posts } = await w.setup(['alice', 'bob', 'carol', 'dave'], { consent: ['alice', 'bob', 'carol'] });
      const { request_id: id } = await w.release.createRequest(agent.user, { ...question, entry_ids: posts });
      await expect(w.authorize(people.dave, id)).rejects.toThrow('no current consent');

      // An authorization that lists someone else's post, or is signed by another key, is refused.
      const mine = (await w.release.myRequests(people.alice.user) as any[])[0].to_sign.body;
      const widened = { ...mine, entries: [...mine.entries, { entryId: 'post-2', derivedSha256: mine.entries[0].derivedSha256 }] };
      await expect(w.release.answerRequest(people.alice.user, id, 'yes', { body: widened, signature: await people.alice.wallet.signMessage(authorizationMessage(widened)) }))
        .rejects.toThrow('not yours');
      await expect(w.release.answerRequest(people.alice.user, id, 'yes', { body: mine, signature: await people.bob.wallet.signMessage(authorizationMessage(mine)) }))
        .rejects.toThrow('signed with the key');

      for (const p of [people.alice, people.bob, people.carol]) await w.authorize(p, id);
      expect(w.release.runStatus(id)).toMatchObject({ status: 'open' });   // Dave has not answered
      await w.release.answerRequest(people.dave.user, id, 'no');
      expect(w.release.runStatus(id)).toMatchObject({ status: 'started', run: { status: 'awaiting_approval', contributors: 3 } });
      await w.decide(people.alice, id);
      const { status } = await w.decide(people.bob, id, false);
      expect(status.run).toMatchObject({ status: 'vetoed', published: null });
      await expect(w.decide(people.carol, id)).rejects.toThrow('vetoed');

      // A consent that names a different requester does not allow a yes.
      const other = await world();
      other.person('someone', false);
      const o = await other.setup(['alice', 'bob', 'carol'], { triggers: ['someone'] });
      const { request_id: otherId } = await other.release.createRequest(o.agent.user, { ...question, entry_ids: o.posts });
      await expect(other.authorize(o.people.alice, otherId)).rejects.toThrow('does not allow runs requested by @insights');
    });

    it('at the deadline, runs with those who agreed if enough did, and otherwise expires', async () => {
      const w = await world();
      const { agent, people, posts } = await w.setup(['alice', 'bob', 'carol', 'dave']);
      const first = await w.release.createRequest(agent.user, { ...question, entry_ids: posts, deadline_hours: 24 });
      const second = await w.release.createRequest(agent.user, { template: 'skill-check', params: { skill: 'Ask before narrowing scope', when: 'an input is about to be swapped' }, entry_ids: posts, deadline_hours: 24 });
      for (const p of [people.alice, people.bob, people.carol]) await w.authorize(p, first.request_id);
      await w.authorize(people.alice, second.request_id);

      await w.release.checkRequests();
      expect(w.release.listRequests().map(r => r.status)).toEqual(['open', 'open']);
      w.advance(24 * 3600_000);
      await w.release.checkRequests();
      expect(w.release.runStatus(first.request_id)).toMatchObject({ status: 'started', agreed: 3, run: { status: 'awaiting_approval', contributors: 3 } });
      expect(w.release.runStatus(second.request_id)).toMatchObject({ status: 'expired', run: null });
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
