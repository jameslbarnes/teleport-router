import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import { testWallet, versionedMemoryStore, syntheticTrace } from './author-test-fixtures.js';
import { canonical } from './author-records.js';
import { insightsRelease, type InsightsPolicy, type EnclaveClient, type WeekView } from './insights-release.js';
import { insightsEnclave } from './insights-enclave.js';
import { insightsWeekly, openWeeklyPreview } from './insights-weekly.js';
import { insightsWeeklyRelease, insightsModelStub } from './insights-weekly-release.js';
import { cleanText, isoWeek, vetoMessage, MIN_PEOPLE, type SignedPlan, type WeeklyVeto } from './insights-program.js';
import { INSIGHTS_SPEC } from './insights-spec.js';
import { sealPart, publicKeyOf } from './trace-envelope.js';
import type { JournalEntry, User } from './storage.js';

// Synthetic people, posts and work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic weekly release key, Router side').digest('hex');
const BASE = 'https://router.example', APP = 'app-synthetic', MODEL = 'model-under-test';
const HOUR = 3600_000, DAY = 24 * HOUR;
const NAMES = /alice|bob|carol|dave|erin|frank|gina/;
const LOG_LONG = syntheticTrace([['person', 'run the long evaluation'], ['call', 'python evaluate.py --all --timeout 60'], ['failed', 'failed after forty minutes on a bad argument']]);

async function world() {
  const users = new Map<string, any>(), entries = new Map<string, JournalEntry>(), stores = new Map<string, Map<string, string>>();
  const groups = new Map<string, { joinRule: 'open' | 'invite' }>([['insights-notes', { joinRule: 'open' }], ['private-club', { joinRule: 'invite' }]]);
  const modelCalls: string[] = [], messages: { to: string; text: string }[] = [];
  const handed = { plans: [] as any[], runs: [] as any[] };
  let alter: ((view: WeekView) => WeekView) | null = null;
  let clock = Date.parse('2026-11-12T12:00:00Z');   // a Thursday in week 46
  const complete = async ({ user }: { user: string }) => { modelCalls.push(user); return insightsModelStub(user); };
  const enclave = insightsEnclave({ releasePrivateKey: RELEASE_KEY, appId: APP, model: MODEL, build: { gitSha: null, imageDigest: null }, now: () => clock, complete });
  const weeklyEnclave = insightsWeekly({ releasePrivateKey: RELEASE_KEY, appId: APP, model: MODEL, now: () => clock, complete });
  const client: EnclaveClient = { info: () => enclave.info(), run: input => enclave.run(input as any), decide: input => enclave.decide(input as any),
    weeklyPlan: async input => { handed.plans.push(input); const view = await weeklyEnclave.plan(input); return alter ? alter(view) : view; },
    weeklyRun: async input => { handed.runs.push(input); return weeklyEnclave.run(input); },
    weeklyVeto: async input => weeklyEnclave.veto(input as any), weeklyPreviews: async run => weeklyEnclave.previews(run),
    weeklyStatus: async run => weeklyEnclave.status(run) };
  const info = await client.info();
  const storeFor = async (b: { delegation: string }) => { if (!stores.has(b.delegation)) stores.set(b.delegation, new Map()); return versionedMemoryStore(stores.get(b.delegation)!); };
  const shared = {
    getUser: async (h: string) => users.get(h) || null,
    updateUser: async (h: string, updates: Record<string, unknown>) => { const u = users.get(h); if (!u) return null; users.set(h, { ...u, ...updates }); return users.get(h); },
    getEntry: async (id: string) => entries.get(id) || null,
    storeFor, now: () => clock,
  };
  const release = insightsRelease({ enclave: { client, info }, baseUrl: BASE, model: MODEL, ...shared });
  /** Router's weekly job. Building a second one over the same enclave and accounts is what a restart looks like. */
  const startJob = () => insightsWeeklyRelease({ enclave: { client, info }, release, baseUrl: BASE, ...shared,
    listUsers: async () => [...users.values()],
    getGroup: async id => groups.get(id) || null,
    listGroupEntries: async (group, limit) => [...entries.values()].filter(e => (e.to || []).includes('#' + group)).sort((a, b) => b.timestamp - a.timestamp).slice(0, limit),
    sendMessage: async (to, text) => { messages.push({ to, text }); } });
  const weekly = startJob();

  const person = (handle: string) => {
    const wallet = testWallet(handle);
    users.set(handle, { handle, secretKeyHash: createHash('sha256').update('key of ' + handle).digest('hex'), createdAt: clock,
      tinycloud: { ownerDid: `did:pkh:eip155:1:${wallet.address}`, space: `space-${handle}`, prefix: 'router/', delegation: handle,
        pseudonym: handle, linkedAt: clock, ownerPublicKey: wallet.signingKey.publicKey, minRecordVersion: 2 } });
    return { handle, wallet, get user() { return users.get(handle) as User; }, get did() { return users.get(handle).tinycloud.ownerDid as string; } };
  };
  type Person = ReturnType<typeof person>;
  const post = (id: string, handle: string | undefined, extra: Partial<JournalEntry> = {}) =>
    entries.set(id, { id, handle, pseudonym: handle || 'Quiet Feather#79c30b', client: 'code', content: `A note about a long job that failed late (${id}).`, timestamp: clock - HOUR, to: ['#insights-notes'], ...extra });
  const consent = async (p: Person, opts: { weekly?: boolean; groups?: string[]; days?: number } = {}) => {
    const { policy, message } = await release.draftPolicy(p.user, { weekly: opts.weekly ?? true, triggers: opts.weekly === false ? [p.handle] : [], groups: opts.groups, days: opts.days });
    await release.saveConsent(p.user, policy, await p.wallet.signMessage(message));
    return policy;
  };
  const upload = async (p: Person, entryId: string, policy: InsightsPolicy, log = LOG_LONG) => {
    const c = { ownerDid: p.did, entryId }, owner = p.wallet.signingKey.compressedPublicKey;
    const full = sealPart(Buffer.from('FULL RECORD ' + log), c, 'full', { owner });
    const derived = sealPart(gzipSync(Buffer.from(log)), c, 'derived', { owner, release: publicKeyOf(RELEASE_KEY) });
    return release.putTrace(p.user, { entry_id: entryId, full: { meta: full.meta, data: full.ciphertext.toString('base64') },
      derived: { meta: derived.meta, data: derived.ciphertext.toString('base64'), policy_id: policy.policyId } });
  };
  /** Alice, Bob and Carol consent to the weekly pipeline and each have one post (post-1..3) with a trace. Dave has a post (post-4) and no consent. */
  const setup = async () => {
    const people: Record<string, Person> = {};
    for (const [i, name] of ['alice', 'bob', 'carol'].entries()) {
      const p = people[name] = person(name);
      post(`post-${i + 1}`, name);
      await upload(p, `post-${i + 1}`, await consent(p));
    }
    people.dave = person('dave');
    post('post-4', 'dave');
    return people;
  };
  const openPreview = async (p: Person, run: string, job = weekly) => {
    const sealed = await job.getWeeklyPreview(p.user, run);
    return sealed ? openWeeklyPreview(sealed, p.did, run, p.wallet.privateKey) : null;
  };
  const signedVeto = async (p: Person, run: string, signer: Wallet = p.wallet) => {
    const body: WeeklyVeto = { v: 1, domain: 'teleport-router/insights-weekly-veto', run, enclave: { appId: APP, releaseKey: publicKeyOf(RELEASE_KEY) } };
    return { body, signature: await signer.signMessage(vetoMessage(body)) };
  };
  return { release, weekly, startJob, client, info, person, post, consent, upload, setup, openPreview, signedVeto, users, entries, stores, messages, modelCalls, handed,
    alterPlans: (fn: typeof alter) => { alter = fn; }, advance: (ms: number) => { clock += ms; }, now: () => clock };
}

describe('The weekly insights pipeline, Router side', () => {
  it('takes a consent with or without the weekly pipeline, and says which in the text that is signed', async () => {
    const w = await world();
    const alice = w.person('alice'), bob = w.person('bob');
    // With the weekly pipeline, nobody need be named as a requester: it starts itself.
    const yes = await w.release.draftPolicy(alice.user, { weekly: true });
    expect(yes.policy).toMatchObject({ weekly: true, triggers: [] });
    expect(yes.message).toContain('Weekly pipeline: yes.');
    await w.release.saveConsent(alice.user, yes.policy, await alice.wallet.signMessage(yes.message));
    expect(w.release.weeklyConsent(alice.user)).toMatchObject({ weekly: true });

    // Without it, today's rule stands: one to eight named requesters.
    await expect(w.release.draftPolicy(bob.user, {})).rejects.toThrow('triggers must name 1 to 8');
    await expect(w.release.draftPolicy(bob.user, { weekly: 'yes', triggers: ['alice'] })).rejects.toThrow('weekly must be true or false');
    const no = await w.release.draftPolicy(bob.user, { triggers: ['alice'] });
    expect(no.policy.weekly).toBe(false);
    expect(no.message).toContain('Weekly pipeline: no. Every run needs my signature.');
    // The field must be there, and a "no" cannot be turned into a "yes" after signing.
    const { weekly: _left, ...missing } = no.policy;
    await expect(w.release.saveConsent(bob.user, missing as InsightsPolicy, await bob.wallet.signMessage(no.message))).rejects.toThrow('does not match');
    await expect(w.release.saveConsent(bob.user, { ...no.policy, weekly: true }, await bob.wallet.signMessage(no.message))).rejects.toThrow('signed with the key');
    await expect(w.release.saveConsent(bob.user, { ...no.policy, weekly: false, triggers: [] }, await bob.wallet.signMessage(no.message))).rejects.toThrow('does not match');
    await w.release.saveConsent(bob.user, no.policy, await bob.wallet.signMessage(no.message));
    expect(w.release.consentStatus(bob.user)).toMatchObject({ active: true });
    expect(w.release.weeklyConsent(bob.user)).toBeNull();
    await w.release.revokeConsent(alice.user);
    expect(w.release.weeklyConsent(alice.user)).toBeNull();
  });

  it('plans from published posts in open groups only, and checks the plan\'s signature', async () => {
    const w = await world();
    const people = await w.setup();
    // Bob's consent also names an invite-only group; nothing from it may be shown to the enclave.
    await w.consent(people.bob, { groups: ['insights-notes', 'private-club'] });
    w.post('post-private', 'bob', { to: ['#private-club'] });
    w.post('post-both', 'bob', { to: ['#insights-notes', '#private-club'] });
    w.post('post-to-a-person', 'carol', { to: ['#insights-notes', '@dave'] });
    w.post('post-waiting', 'alice', { publishAt: w.now() + HOUR });
    w.post('post-no-handle', undefined);
    w.post('post-old', 'dave', { timestamp: w.now() - 8 * DAY });
    w.post('post-unnamed-group', 'dave', { to: ['#elsewhere'] });

    const planned = await w.weekly.planWeek() as WeekView;
    expect(w.handed.plans).toHaveLength(1);
    expect(w.handed.plans[0].week).toBe('2026-W46');
    expect(w.handed.plans[0].posts.map((p: any) => p.entryId).sort()).toEqual(['post-1', 'post-2', 'post-3', 'post-4']);
    expect(w.handed.plans[0].posts[0]).toMatchObject({ group: 'insights-notes', handle: expect.any(String), text: expect.stringContaining('long job') });
    expect(planned).toMatchObject({ week: '2026-W46', run: 'weekly-2026-W46', status: 'planned', people_invited: 1, people_with_weekly_consent: 3 });
    const plan = planned.plan!;
    expect(verifyMessage(canonical(plan.plan), plan.signature)).toBe(w.info.signer);
    expect(plan.plan.entries.slice().sort()).toEqual(['post-1', 'post-2', 'post-3', 'post-4']);
    expect(Date.parse(plan.plan.runAfter) - w.now()).toBe(INSIGHTS_SPEC.weekly.inviteHours * HOUR);

    // A week gets one plan. Asking again returns it without another model call or another invitation.
    const again = await w.weekly.planWeek() as WeekView;
    expect(again.plan).toEqual(plan);
    expect(w.handed.plans).toHaveLength(1);
    expect(w.messages).toHaveLength(1);
  });

  it('does not ask the enclave when too few people posted, or when nobody has a weekly consent', async () => {
    const w = await world();
    const alice = w.person('alice'), bob = w.person('bob');
    w.person('carol');
    w.post('post-1', 'alice'); w.post('post-2', 'bob'); w.post('post-3', 'carol');
    expect(await w.weekly.planWeek()).toMatchObject({ status: 'not_planned' });      // no consent names any group
    await w.consent(alice, { weekly: false });
    expect(await w.weekly.planWeek()).toMatchObject({ status: 'not_planned' });      // a consent without the weekly pipeline names no group for it
    await w.consent(bob);
    w.entries.delete('post-3');
    expect(await w.weekly.planWeek()).toMatchObject({ status: 'not_planned', reason: expect.stringContaining(`fewer than ${MIN_PEOPLE} people`) });
    expect(w.handed.plans).toHaveLength(0);
    expect(w.modelCalls).toHaveLength(0);
  });

  it('refuses a forged or altered plan: no invitation is sent and no run can start', async () => {
    const resign = (plan: SignedPlan['plan'], key: string): SignedPlan => { const s = new Wallet(key); return { plan, signature: s.signMessageSync(canonical(plan)), signer: s.address }; };
    const cases: [string, (view: WeekView) => WeekView, string][] = [
      ['a question changed after signing', v => ({ ...v, plan: { ...v.plan!, plan: { ...v.plan!.plan, question: 'Which company is each person buying' } } }), 'not signed by'],
      ['an earlier start', v => ({ ...v, plan: { ...v.plan!, plan: { ...v.plan!.plan, runAfter: v.plan!.plan.plannedAt } } }), 'not signed by'],
      ['signed by another key', v => ({ ...v, plan: resign(v.plan!.plan, testWallet('mallory').privateKey) }), 'not signed by'],
      // Even the right key cannot make Router act on a post it never offered, or on words outside the rules.
      ['a post that was not offered', v => ({ ...v, plan: resign({ ...v.plan!.plan, entries: [...v.plan!.plan.entries, 'post-private'] }, RELEASE_KEY) }), 'could have made'],
      ['a question with other characters', v => ({ ...v, plan: resign({ ...v.plan!.plan, question: 'See <b>https://example.test</b>' }, RELEASE_KEY) }), 'could have made'],
      ['another enclave', v => ({ ...v, plan: resign({ ...v.plan!.plan, enclave: { ...v.plan!.plan.enclave, appId: 'app-other' } }, RELEASE_KEY) }), 'could have made'],
    ];
    for (const [, change, error] of cases) {
      const w = await world();
      await w.setup();
      w.alterPlans(change);
      await expect(w.weekly.planWeek()).rejects.toThrow(error);
      expect(w.messages).toHaveLength(0);
      w.advance(49 * HOUR);
      expect(await w.weekly.runWeek()).toEqual([]);
      expect(w.handed.runs).toHaveLength(0);
    }
  });

  it('invites each planned author without a weekly consent once a week, about their own posts only, and never when they turned it off', async () => {
    const w = await world();
    await w.setup();
    w.post('post-5', 'dave');
    const erin = w.person('erin'), frank = w.person('frank');
    w.post('post-6', 'erin'); w.post('post-7', 'frank');
    await w.consent(erin, { weekly: false });                      // a consent, but not to the weekly pipeline: still invited
    expect(await w.weekly.setInvites(frank.user, 'off')).toEqual({ invites: 'off' });
    await expect(w.weekly.setInvites(frank.user, 'never')).rejects.toThrow('"on" or "off"');

    const planned = await w.weekly.planWeek() as WeekView;
    expect(w.messages.map(m => m.to).sort()).toEqual(['dave', 'erin']);
    const toDave = w.messages.find(m => m.to === 'dave')!.text;
    expect(toDave).toContain('these public posts of yours as bearing on it: ');
    expect(toDave).toContain('post-4'); expect(toDave).toContain('post-5');
    expect(toDave).not.toMatch(/post-[12367]|alice|bob|carol|erin|frank/);
    expect(toDave).toContain(`"${planned.plan!.plan.question}"`);
    expect(toDave).toContain('Your trace is read only if you consent.');
    expect(toDave).toContain(`${BASE}/api/insights/release`);
    expect(toDave).toContain('consent --weekly');
    expect(toDave).toContain(`The run starts no earlier than ${planned.plan!.plan.runAfter}.`);
    expect(toDave).toContain(`To stop these invitations: ask your agent to POST {"invites":"off"} to ${BASE}/api/insights/invites`);
    const toErin = w.messages.find(m => m.to === 'erin')!.text;
    expect(toErin).toContain('this public post of yours as bearing on it: post-6.');
    expect(toErin).not.toMatch(/post-[123457]|alice|bob|carol|dave|frank/);
    expect(planned).toMatchObject({ people_invited: 2, people_with_weekly_consent: 3 });

    // Planning again, the timer, and a restart of Router send nothing more this week; the counts survive the restart.
    await w.weekly.planWeek();
    await w.weekly.tick();
    const restarted = w.startJob();
    expect(await restarted.planWeek()).toMatchObject({ already_planned: true, people_invited: 2, people_with_weekly_consent: 3 });
    await restarted.tick();
    expect(w.messages).toHaveLength(2);
    expect(w.handed.plans).toHaveLength(1);
    const listed = await restarted.listWeeks();
    expect(listed).toMatchObject([{ week: '2026-W46', status: 'planned', people_invited: 2, people_with_weekly_consent: 3 }]);
    expect(JSON.stringify(listed)).not.toMatch(NAMES);

    // The next week, with new posts, each may be asked once more. Frank turns invitations back on.
    await w.weekly.setInvites(frank.user, 'on');
    w.advance(7 * DAY);
    for (const [i, name] of ['alice', 'bob', 'carol', 'dave', 'frank'].entries()) w.post(`post-next-${i + 1}`, name);
    expect(await w.weekly.planWeek()).toMatchObject({ week: '2026-W47', status: 'planned' });
    expect(w.messages.slice(2).map(m => m.to).sort()).toEqual(['dave', 'frank']);
    expect(w.messages[2].text).not.toMatch(/post-[1-7]\b/);
  });

  it('cannot start a run before the plan allows, hands over only weekly-consenting people\'s traces, and calls the enclave once', async () => {
    const w = await world();
    const people = await w.setup();
    // Erin consented without the weekly pipeline; Frank revokes before the run; Gina's consent runs out before it.
    const erin = w.person('erin'), frank = w.person('frank'), gina = w.person('gina');
    w.post('post-5', 'erin'); w.post('post-6', 'frank'); w.post('post-7', 'gina');
    await w.upload(erin, 'post-5', await w.consent(erin, { weekly: false }));
    await w.upload(frank, 'post-6', await w.consent(frank));
    await w.upload(gina, 'post-7', await w.consent(gina, { days: 1 }));
    // Dana's trace was uploaded under an earlier consent than the one she holds now, so it is not handed over.
    const dana = w.person('dana');
    w.post('post-8', 'dana');
    await w.upload(dana, 'post-8', await w.consent(dana));
    await w.consent(dana);

    const planned = await w.weekly.planWeek() as WeekView;
    const run = planned.run, runAfter = planned.plan!.plan.runAfter;
    expect(w.messages.map(m => m.to).sort()).toEqual(['dave', 'erin']);
    expect(await w.weekly.runWeek()).toEqual([{ run, outcome: 'not_before', run_after: runAfter }]);
    w.advance(48 * HOUR - 1);
    expect(await w.weekly.runWeek()).toEqual([{ run, outcome: 'not_before', run_after: runAfter }]);
    expect(w.handed.runs).toHaveLength(0);
    // Router is not what holds this line: the enclave itself refuses an early run.
    const early = (await w.release.weeklyOwner(people.alice.user, ['post-1']))!;
    expect(early.traces.map(t => t.entryId)).toEqual(['post-1']);
    await expect(w.client.weeklyRun({ run, owners: [early] })).rejects.toThrow('may not start before');
    w.handed.runs.length = 0;

    await w.release.revokeConsent(frank.user);
    w.advance(1);
    const reads = () => w.modelCalls.filter(c => c.includes('<log>')).length;
    expect(reads()).toBe(0);
    // Two timers at once, then a third: one handover.
    const [first, second] = await Promise.all([w.weekly.runWeek(), w.weekly.runWeek()]);
    expect([first, second].flat()).toMatchObject([{ run, outcome: 'handed_over', status: 'waiting', contributors: 3 }]);
    expect(await w.weekly.runWeek()).toEqual([]);
    await w.weekly.tick();
    expect(w.handed.runs).toHaveLength(1);
    expect(w.handed.runs[0].owners.map((o: any) => o.did).sort()).toEqual([people.alice.did, people.bob.did, people.carol.did].sort());
    expect(w.handed.runs[0].owners.map((o: any) => o.traces.map((t: any) => t.entryId)).flat().sort()).toEqual(['post-1', 'post-2', 'post-3']);
    expect(w.handed.runs[0].owners.every((o: any) => o.consent.policy.weekly === true && !('handle' in o))).toBe(true);
    expect(reads()).toBe(3);
    // A restart of Router does not hand the week over again either.
    const restarted = w.startJob();
    expect(await restarted.runWeek()).toEqual([]);
    expect(w.handed.runs).toHaveLength(1);

    // Each contributor's sealed preview is in their own space; nobody else has one.
    for (const p of [people.alice, people.bob, people.carol]) {
      expect(w.stores.get(p.handle)!.has(`insights/weekly/${run}`)).toBe(true);
      const preview = (await w.openPreview(p, run))!;
      expect(verifyMessage(canonical(preview.body), preview.signature)).toBe(w.info.signer);
      expect(preview.body).toMatchObject({ run, status: 'waiting', contributors: 3, draft: { title: 'Short trial before a long job' } });
      expect(preview.body.your_findings).toHaveLength(1);
      expect(JSON.stringify(preview.body)).not.toMatch(NAMES);
    }
    for (const p of [people.dave, erin, frank, gina, dana]) {
      expect(await w.openPreview(p, run)).toBeNull();
      expect(w.stores.get(p.handle)?.has(`insights/weekly/${run}`) ?? false).toBe(false);
    }
    // A preview sealed to one person does not open with another's key.
    const sealed = await w.weekly.getWeeklyPreview(people.alice.user, run);
    expect(() => openWeeklyPreview(sealed, people.alice.did, run, people.bob.wallet.privateKey)).toThrow();
  });

  it('does not hand a week over when fewer people than a skill needs have a consent and a trace', async () => {
    const w = await world();
    const people = await w.setup();
    const planned = await w.weekly.planWeek() as WeekView;
    await w.release.revokeConsent(people.carol.user);
    w.advance(49 * HOUR);
    expect(await w.weekly.runWeek()).toEqual([{ run: planned.run, outcome: 'too_few_people', people: 2 }]);
    expect(w.handed.runs).toHaveLength(0);
    expect(w.modelCalls.filter(c => c.includes('<log>'))).toHaveLength(0);
    expect(await w.weekly.listWeeks()).toMatchObject([{ status: 'planned', contributors: 0, people_with_weekly_consent: 2, router_note: expect.stringContaining('not run') }]);
  });

  it('a contributor\'s veto cancels the draft and nothing is published', async () => {
    const w = await world();
    const people = await w.setup();
    const { run } = await w.weekly.planWeek() as WeekView;
    w.advance(48 * HOUR);
    await w.weekly.runWeek();
    // Dave contributed nothing, and a veto signed by someone else's key is not Carol's.
    await expect(w.weekly.vetoWeek(people.dave.user, run, await w.signedVeto(people.dave, run))).rejects.toThrow('Only people this draft draws on');
    await expect(w.weekly.vetoWeek(people.carol.user, run, await w.signedVeto(people.carol, run, people.dave.wallet))).rejects.toThrow('not a valid signed cancellation');
    expect(await w.weekly.listWeeks()).toMatchObject([{ status: 'waiting', published: null }]);
    expect(await w.weekly.vetoWeek(people.carol.user, run, await w.signedVeto(people.carol, run))).toMatchObject({ run, status: 'vetoed', published: null });
    w.advance(INSIGHTS_SPEC.weekly.vetoHours * HOUR + HOUR);
    await w.weekly.tick();
    const listed = await w.weekly.listWeeks();
    expect(listed.find(v => v.run === run)).toMatchObject({ status: 'vetoed', reason: 'cancelled by a contributor', published: null });
    expect(JSON.stringify(listed)).not.toMatch(/Short trial|small input/);
  });

  it('without a veto publishes the skill after the wait, and the public register never shows names or a waiting draft', async () => {
    const w = await world();
    await w.setup();
    const { run } = await w.weekly.planWeek() as WeekView;
    w.advance(48 * HOUR);
    await w.weekly.runWeek();
    const waiting = await w.weekly.listWeeks();
    expect(waiting).toMatchObject([{ run, status: 'waiting', contributors: 3, published: null, people_invited: 1, people_with_weekly_consent: 3 }]);
    expect(JSON.stringify(waiting)).not.toMatch(/Short trial|small input|small slice/);
    expect(JSON.stringify(waiting)).not.toMatch(NAMES);
    w.advance(INSIGHTS_SPEC.weekly.vetoHours * HOUR - 1);
    expect(await w.weekly.listWeeks()).toMatchObject([{ status: 'waiting', published: null }]);
    w.advance(1);
    const listed = await w.weekly.listWeeks();
    const done = listed.find(v => v.run === run)!;
    expect(done).toMatchObject({ status: 'published', contributors: 3 });
    const published = done.published as { body: any; signature: string; signer: string };
    expect(verifyMessage(canonical(published.body), published.signature)).toBe(w.info.signer);
    expect(published.body).toMatchObject({ kind: 'router-insights-weekly-skill', people: 3, skill: { title: 'Short trial before a long job' } });
    expect(published.body.skill.steps).toHaveLength(2);
    expect(JSON.stringify(listed)).not.toMatch(NAMES);
    expect(JSON.stringify(listed)).not.toMatch(/did:pkh/);
  });

  it('the timer plans a week once, and tries again only every six hours when it cannot', async () => {
    const w = await world();
    const alice = w.person('alice'), bob = w.person('bob'), carol = w.person('carol');
    for (const p of [alice, bob, carol]) await w.consent(p);
    w.post('post-1', 'alice'); w.post('post-2', 'bob');
    // Two people's posts are not enough; the enclave is not asked, and the next try waits.
    await w.weekly.tick();
    w.post('post-3', 'carol');
    w.advance(HOUR);
    await w.weekly.tick();
    expect(w.handed.plans).toHaveLength(0);
    w.advance(5 * HOUR);
    await w.weekly.tick();
    expect(w.handed.plans).toHaveLength(1);
    expect(isoWeek(w.now())).toBe('2026-W46');
    await w.weekly.tick();
    w.advance(6 * HOUR);
    await w.weekly.tick();
    expect(w.handed.plans).toHaveLength(1);
    expect(await w.weekly.listWeeks()).toMatchObject([{ week: '2026-W46', status: 'planned', people_invited: 0, people_with_weekly_consent: 3 }]);
  });

  it('the model stand-in answers each weekly prompt in the shape it asks for, in words the program may keep', () => {
    const s = INSIGHTS_SPEC.weekly;
    const scout = JSON.parse(insightsModelStub(s.scout.user.replace('{notes}', '[post-1] @alice: one\n[post-2] @bob: two')));
    expect(scout.post_ids).toEqual(['post-1', 'post-2']);
    expect(cleanText(scout.question, s.scout.questionMaxChars)).toBe(scout.question);
    const read = (log: string) => JSON.parse(insightsModelStub(s.read.user.replace('{question}', scout.question).replace('{log}', log)));
    expect(read('[+0h00m00s] PERSON: tidy the notes')).toEqual({ relevant: 'no', cases: [] });
    const finding = read('[+0h00m00s] AGENT CALLED Bash: {"command":"run --timeout 60"}');
    expect(finding.relevant).toBe('yes');
    expect(cleanText(finding.cases[0], s.read.findingMaxChars)).toBe(finding.cases[0]);
    const skill = JSON.parse(insightsModelStub(s.combine.user.replace('{question}', scout.question).replace('{findings}', `- ${finding.cases[0]}`)));
    expect(cleanText(skill.title, s.combine.titleMaxChars)).toBe(skill.title);
    expect(cleanText(skill.when, s.combine.whenMaxChars)).toBe(skill.when);
    expect(skill.steps).toHaveLength(2);
    for (const step of skill.steps) expect(cleanText(step, s.combine.stepMaxChars)).toBe(step);
    expect(JSON.parse(insightsModelStub(s.check.user.replace('{text}', skill.title)))).toEqual({ specific: 'no' });
    // The skill-check prompt still gets the fixed answer shape.
    expect(JSON.parse(insightsModelStub(INSIGHTS_SPEC.user.replace('{log}', 'a timeout')))).toMatchObject({ applies: 'yes' });
  });
});
