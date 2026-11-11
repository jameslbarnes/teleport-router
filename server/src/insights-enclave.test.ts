import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import { testWallet } from './author-test-fixtures.js';
import { canonical } from './author-records.js';
import { consentMessage, insightsProgram, type InsightsPolicy } from './insights-release.js';
import { insightsEnclave, authorizationMessage, approvalMessage, contributionCommitment, openPreview, questionSha256,
  type RunAuthorization, type ContributionApproval } from './insights-enclave.js';
import { publicKeyOf, sealPart, sha256Hex } from './trace-envelope.js';

// Synthetic people and synthetic work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic enclave release key').digest('hex');
const APP = 'app-enclave-test', MODEL = 'model-under-test';
const LOG_YES = 'USER: run the long evaluation\nTOOL: started the full run with a short timeout\nTOOL: failed after forty minutes on a bad argument';
const LOG_NO = 'USER: tidy the notes\nASSISTANT: reorganised three sections';
const QUESTION = { template: 'skill-check', params: { skill: 'Smoke test before long runs', when: 'a run is expected to take more than a few minutes' } };
const NOTE = 'A tiny trial run first would have exposed the mistake early.';

function setup(opts: { failFirst?: boolean; slow?: Promise<void> } = {}) {
  let clock = Date.parse('2026-11-12T12:00:00Z');
  const calls: string[] = [];
  let quotes = 0, failed = false;
  const enclave = insightsEnclave({ releasePrivateKey: RELEASE_KEY, appId: APP, model: MODEL, build: { gitSha: 'abc1234', imageDigest: null },
    complete: async ({ user }) => {
      calls.push(user);
      if (opts.slow) await opts.slow;
      if (opts.failFirst && !failed) { failed = true; throw new Error('model unavailable'); }
      return JSON.stringify(user.includes('timeout') ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: NOTE }
        : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' });
    },
    quote: async () => { quotes++; return { quote: 'synthetic' }; },
    now: () => clock });
  const program = insightsProgram(MODEL);
  const releaseKey = publicKeyOf(RELEASE_KEY);
  const qSha = questionSha256(program.sha256, QUESTION.template, QUESTION.params);

  const owner = async (name: string, log: string, opts2: { program?: string } = {}) => {
    const wallet = testWallet(name);
    const did = `did:pkh:eip155:1:${wallet.address}`;
    const policy: InsightsPolicy = { v: 1, domain: 'teleport-router/insights-consent', server: 'https://router.example', policyId: `policy-${name}`,
      owner: { handle: name, did }, program: { name: program.name, version: program.version, sha256: opts2.program || program.sha256 },
      enclave: { appId: APP, releaseKey, upgrades: { by: 'operator' } }, scope: { groups: ['insights-notes'] }, triggers: [],
      egress: { provider: 'Anthropic API', model: MODEL }, limits: { maxTracesPerRun: 5 },
      issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 30 * 86400_000).toISOString() };
    const entryId = `post-${name}`;
    const sealed = sealPart(gzipSync(Buffer.from(log)), { ownerDid: did, entryId }, 'derived', { owner: wallet.signingKey.compressedPublicKey, release: releaseKey });
    const trace = { entryId, meta: sealed.meta, ciphertext: sealed.ciphertext.toString('base64') };
    return { name, wallet, did, policy, trace, consentSignature: await wallet.signMessage(consentMessage(policy)) };
  };
  type Owner = Awaited<ReturnType<typeof owner>>;
  const authorize = async (o: Owner, run: string, change: Partial<RunAuthorization> = {}, signer = o.wallet) => {
    const body: RunAuthorization = { v: 1, domain: 'teleport-router/insights-run-authorization', run, enclave: { appId: APP, releaseKey }, policyId: o.policy.policyId,
      question: { ...QUESTION, sha256: qSha }, entries: [{ entryId: o.trace.entryId, derivedSha256: o.trace.meta.sha256 }],
      expiresAt: new Date(clock + 3600_000).toISOString(), ...change };
    return { did: o.did, publicKey: o.wallet.signingKey.publicKey, consent: { policy: o.policy, signature: o.consentSignature },
      authorization: { body, signature: await signer.signMessage(authorizationMessage(body)) }, traces: [o.trace] };
  };
  const preview = (out: { previews: { did: string; meta: any; ciphertext: string }[] }, o: Owner, run: string) =>
    openPreview(out.previews.find(p => p.did === o.did)!, o.did, run, o.wallet.privateKey);
  const decide = async (o: Owner, run: string, commitment: string, yes = true) => {
    const body: ContributionApproval = { v: 1, domain: 'teleport-router/insights-contribution-approval', run, enclave: { appId: APP, releaseKey }, commitment, approve: yes };
    return enclave.decide({ run, did: o.did, approval: { body, signature: await o.wallet.signMessage(approvalMessage(body)) } });
  };
  return { enclave, calls, owner, authorize, preview, decide, releaseKey, quotes: () => quotes, advance: (ms: number) => { clock += ms; } };
}

describe('Insights enclave', () => {
  it('opens only signed, authorized traces, shows each owner only their own contribution, and publishes approved contributions', async () => {
    const s = setup();
    const people = [await s.owner('alice', LOG_YES), await s.owner('bob', LOG_NO), await s.owner('carol', LOG_NO)];
    const out = await s.enclave.run({ run: 'run-1', ...QUESTION, owners: await Promise.all(people.map(p => s.authorize(p, 'run-1'))) });
    expect(out).toMatchObject({ status: 'awaiting_decisions', contributors: 3, skipped: {} });
    expect(s.calls).toHaveLength(3);
    // What goes back to Router is sealed: no answer, note, count or hash of them in readable form.
    expect(JSON.stringify(out)).not.toMatch(/would_have_helped|not_applicable|trial run|applies|commitment|result/);

    // Each owner sees only their own items, with a salted commitment to them; nobody else can open the preview.
    const alice = s.preview(out, people[0], 'run-1');
    expect(verifyMessage(canonical(alice.body), alice.signature)).toBe(new Wallet(RELEASE_KEY).address);
    expect(alice.body.your_items).toMatchObject([{ entryId: 'post-alice', answer: { applies: 'yes' }, note: NOTE }]);
    expect(alice.body.draft).toBeUndefined();
    expect(JSON.stringify(alice.body)).not.toMatch(/post-bob|post-carol/);
    expect(alice.body.commitment).toBe(contributionCommitment('run-1', people[0].did, alice.body.salt, alice.body.your_items));
    expect(() => openPreview(out.previews.find(p => p.did === people[0].did)!, people[0].did, 'run-1', people[1].wallet.privateKey)).toThrow();

    // Nothing is public until everyone has decided; a decision must sign the owner's own commitment, once.
    expect(s.enclave.status('run-1')).toMatchObject({ status: 'awaiting_decisions', published: null });
    const bob = s.preview(out, people[1], 'run-1');
    await expect(s.decide(people[0], 'run-1', bob.body.commitment)).rejects.toThrow('not a valid signature');
    await s.decide(people[0], 'run-1', alice.body.commitment);
    await expect(s.decide(people[0], 'run-1', alice.body.commitment)).rejects.toThrow('already decided');
    await s.decide(people[1], 'run-1', bob.body.commitment);
    expect(s.enclave.status('run-1')).toMatchObject({ status: 'awaiting_decisions', decided: 2, published: null });
    const done = await s.decide(people[2], 'run-1', s.preview(out, people[2], 'run-1').body.commitment);
    expect(done.status).toBe('published');
    const published = done.published as any;
    expect(verifyMessage(canonical(published.body), published.signature)).toBe(new Wallet(RELEASE_KEY).address);
    expect(published.body).toMatchObject({ released: true, people: 3, traces_read: 3, applies: { yes: 1, no: 2 }, notes: [NOTE] });
    expect(JSON.stringify(published)).not.toMatch(/alice|bob|carol|post-/);

    // The same question is not read again from the same traces.
    const again = await s.enclave.run({ run: 'run-2', ...QUESTION, owners: await Promise.all(people.map(p => s.authorize(p, 'run-2'))) });
    expect(again).toMatchObject({ status: 'withheld', skipped: { already_read_for_this_question: 3 } });
  });

  it('refuses whatever Router could fake: another signer, question, run, trace, program or a repeated entry', async () => {
    const s = setup();
    const [alice, bob, carol, dave, erin, frank, gina] = await Promise.all([
      s.owner('alice', LOG_YES), s.owner('bob', LOG_NO), s.owner('carol', LOG_NO), s.owner('dave', LOG_NO), s.owner('erin', LOG_NO),
      s.owner('frank', LOG_NO, { program: '0'.repeat(64) }), s.owner('gina', LOG_NO)]);
    const owners = [
      await s.authorize(alice, 'run-x', {}, testWallet('mallory')),                                          // not the owner's signature
      await s.authorize(bob, 'run-x', { question: { template: 'skill-check', params: { skill: 'Something else', when: 'always' }, sha256: '1'.repeat(64) } }),
      await s.authorize(carol, 'run-other'),                                                               // signed for another run
      { ...await s.authorize(dave, 'run-x'), traces: [{ ...dave.trace, ciphertext: Buffer.from('tampered').toString('base64') }] },
      { ...await s.authorize(erin, 'run-x'), traces: [{ ...erin.trace, entryId: 'post-unlisted' }] },
      await s.authorize(frank, 'run-x'),                                                                   // consent names another program
      { ...await s.authorize(gina, 'run-x'), traces: [gina.trace, gina.trace] },                           // the same entry twice
    ];
    const out = await s.enclave.run({ run: 'run-x', ...QUESTION, owners });
    expect(out).toMatchObject({ status: 'withheld', contributors: 1, skipped: { not_authorized: 4, trace_changed: 1, entry_not_authorized: 1, duplicate_entry: 1 } });
    expect(s.calls).toHaveLength(1);
    await expect(s.enclave.run({ run: 'run-x', ...QUESTION, owners })).rejects.toThrow('already happened');

    // An expired authorization counts for nothing either.
    const late = await s.authorize(alice, 'run-y');
    s.advance(2 * 3600_000);
    expect((await s.enclave.run({ run: 'run-y', ...QUESTION, owners: [late] })).skipped).toEqual({ not_authorized: 1 });
  });

  it('withholds below three approvals, leaves out a vetoed contribution, and lets a failed read be retried', async () => {
    const s = setup();
    const [alice, bob] = await Promise.all([s.owner('alice', LOG_YES), s.owner('bob', LOG_NO)]);
    const two = await s.enclave.run({ run: 'run-a', ...QUESTION, owners: [await s.authorize(alice, 'run-a'), await s.authorize(bob, 'run-a')] });
    expect(two).toMatchObject({ status: 'withheld', contributors: 2 });
    expect(s.preview(two, alice, 'run-a').body).toMatchObject({ withheld: 'fewer than 3 people contributed' });

    // Four contributors, one veto: published from the three who approved, without the vetoed answers.
    const s2 = setup();
    const four = [await s2.owner('alice', LOG_YES), await s2.owner('bob', LOG_NO), await s2.owner('carol', LOG_NO), await s2.owner('dave', LOG_NO)];
    const out = await s2.enclave.run({ run: 'run-b', ...QUESTION, owners: await Promise.all(four.map(p => s2.authorize(p, 'run-b'))) });
    await s2.decide(four[0], 'run-b', s2.preview(out, four[0], 'run-b').body.commitment, false);
    for (const p of four.slice(1)) await s2.decide(p, 'run-b', s2.preview(out, p, 'run-b').body.commitment);
    expect((s2.enclave.status('run-b')!.published as any).body).toMatchObject({ people: 3, applies: { no: 3 }, notes: [] });

    // Three contributors and one veto leaves two: nothing is published.
    const s3 = setup();
    const three = [await s3.owner('alice', LOG_YES), await s3.owner('bob', LOG_NO), await s3.owner('carol', LOG_NO)];
    const out3 = await s3.enclave.run({ run: 'run-c', ...QUESTION, owners: await Promise.all(three.map(p => s3.authorize(p, 'run-c'))) });
    await s3.decide(three[0], 'run-c', s3.preview(out3, three[0], 'run-c').body.commitment);
    await s3.decide(three[1], 'run-c', s3.preview(out3, three[1], 'run-c').body.commitment, false);
    expect((await s3.decide(three[2], 'run-c', s3.preview(out3, three[2], 'run-c').body.commitment)).status).toBe('withheld');
    expect(s3.enclave.status('run-c')).toMatchObject({ status: 'withheld', published: null });

    // A trace whose read failed is not used up: a later run of the same question can read it.
    const s4 = setup({ failFirst: true });
    const solo = await s4.owner('alice', LOG_YES);
    expect((await s4.enclave.run({ run: 'run-d', ...QUESTION, owners: [await s4.authorize(solo, 'run-d')] })).skipped).toEqual({ unreadable_or_failed: 1 });
    expect((await s4.enclave.run({ run: 'run-e', ...QUESTION, owners: [await s4.authorize(solo, 'run-e')] })).contributors).toBe(1);
  });

  it('runs one at a time, reserving the run before any await', async () => {
    let release!: () => void;
    const s = setup({ slow: new Promise<void>(r => { release = r; }) });
    const alice = await s.owner('alice', LOG_YES);
    const first = s.enclave.run({ run: 'run-1', ...QUESTION, owners: [await s.authorize(alice, 'run-1')] });
    await expect(s.enclave.run({ run: 'run-1', ...QUESTION, owners: [await s.authorize(alice, 'run-1')] })).rejects.toThrow('already happened');
    await expect(s.enclave.run({ run: 'run-2', ...QUESTION, owners: [await s.authorize(alice, 'run-2')] })).rejects.toThrow('in progress');
    release();
    expect((await first).contributors).toBe(1);
  });

  it('describes itself with what the attestation binds, quoting once', async () => {
    const s = setup();
    const info = await s.enclave.info();
    await s.enclave.info();
    expect(s.quotes()).toBe(1);
    expect(info).toMatchObject({ release_key: s.releaseKey, app_id: APP, upgrades: { by: 'operator' }, min_people: 3, quote: { quote: 'synthetic' },
      signer: new Wallet(RELEASE_KEY).address });
    expect(info.identity_sha256).toBe(sha256Hex(canonical({ release_key: s.releaseKey, app_id: APP, program_sha256: info.program_sha256, upgrades: { by: 'operator' }, min_people: 3 })));
    expect(info.report_data.slice(0, 64)).toBe(info.identity_sha256);
  });
});
