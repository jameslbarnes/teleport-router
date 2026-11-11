import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { Wallet, verifyMessage } from 'ethers';
import { testWallet } from './author-test-fixtures.js';
import { canonical } from './author-records.js';
import { consentMessage, insightsProgram, type InsightsPolicy } from './insights-release.js';
import { insightsEnclave, authorizationMessage, approvalMessage, openPreview, questionSha256, type RunAuthorization, type ResultApproval } from './insights-enclave.js';
import { publicKeyOf, sealPart, sha256Hex } from './trace-envelope.js';

// Synthetic people and synthetic work logs only.
const RELEASE_KEY = '0x' + createHash('sha256').update('synthetic enclave release key').digest('hex');
const APP = 'app-enclave-test', MODEL = 'model-under-test';
const LOG_YES = 'USER: run the long evaluation\nTOOL: started the full run with a short timeout\nTOOL: failed after forty minutes on a bad argument';
const LOG_NO = 'USER: tidy the notes\nASSISTANT: reorganised three sections';
const QUESTION = { template: 'skill-check', params: { skill: 'Smoke test before long runs', when: 'a run is expected to take more than a few minutes' } };

function setup() {
  let clock = Date.parse('2026-11-12T12:00:00Z');
  const calls: string[] = [];
  const enclave = insightsEnclave({ releasePrivateKey: RELEASE_KEY, appId: APP, model: MODEL, build: { gitSha: 'abc1234', imageDigest: null },
    complete: async ({ user }) => { calls.push(user); return JSON.stringify(user.includes('timeout')
      ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: 'A tiny trial run first would have exposed the mistake early.' }
      : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' }); },
    now: () => clock });
  const program = insightsProgram(MODEL);
  const releaseKey = publicKeyOf(RELEASE_KEY);
  const qSha = questionSha256(program.sha256, QUESTION.template, QUESTION.params);

  const owner = async (name: string, log: string, opts: { program?: string; signer?: Wallet } = {}) => {
    const wallet = testWallet(name);
    const did = `did:pkh:eip155:1:${wallet.address}`;
    const policy: InsightsPolicy = { v: 1, domain: 'teleport-router/insights-consent', server: 'https://router.example', policyId: `policy-${name}`,
      owner: { handle: name, did }, program: { name: program.name, version: program.version, sha256: opts.program || program.sha256 },
      enclave: { appId: APP, releaseKey, upgrades: { by: 'operator' } }, scope: { groups: ['insights-notes'] }, triggers: [],
      egress: { provider: 'Anthropic API', model: MODEL }, limits: { maxTracesPerRun: 5 },
      issuedAt: new Date(clock).toISOString(), expiresAt: new Date(clock + 30 * 86400_000).toISOString() };
    const entryId = `post-${name}`;
    const sealed = sealPart(gzipSync(Buffer.from(log)), { ownerDid: did, entryId }, 'derived', { owner: wallet.signingKey.compressedPublicKey, release: releaseKey });
    const trace = { entryId, meta: sealed.meta, ciphertext: sealed.ciphertext.toString('base64') };
    return { name, wallet, did, policy, trace, consentSignature: await wallet.signMessage(consentMessage(policy)) };
  };
  const authorize = async (o: Awaited<ReturnType<typeof owner>>, run: string, change: Partial<RunAuthorization> = {}, signer = o.wallet) => {
    const body: RunAuthorization = { v: 1, domain: 'teleport-router/insights-run-authorization', run, enclave: { appId: APP, releaseKey }, policyId: o.policy.policyId,
      question: { ...QUESTION, sha256: qSha }, entries: [{ entryId: o.trace.entryId, derivedSha256: o.trace.meta.sha256 }],
      expiresAt: new Date(clock + 3600_000).toISOString(), ...change };
    return { did: o.did, publicKey: o.wallet.signingKey.publicKey, consent: { policy: o.policy, signature: o.consentSignature },
      authorization: { body, signature: await signer.signMessage(authorizationMessage(body)) }, traces: [o.trace] };
  };
  const approve = async (o: Awaited<ReturnType<typeof owner>>, run: string, resultSha256: string, yes = true) => {
    const body: ResultApproval = { v: 1, domain: 'teleport-router/insights-result-approval', run, enclave: { appId: APP, releaseKey }, resultSha256, approve: yes };
    return enclave.decide({ run, did: o.did, approval: { body, signature: await o.wallet.signMessage(approvalMessage(body)) } });
  };
  return { enclave, calls, owner, authorize, approve, releaseKey, advance: (ms: number) => { clock += ms; } };
}

describe('Insights enclave', () => {
  it('opens only signed, authorized traces, seals every answer to its owner, and publishes only after all contributors approve', async () => {
    const s = setup();
    const people = [await s.owner('alice', LOG_YES), await s.owner('bob', LOG_NO), await s.owner('carol', LOG_NO)];
    const out = await s.enclave.run({ run: 'run-1', ...QUESTION, owners: await Promise.all(people.map(p => s.authorize(p, 'run-1'))) });
    expect(out).toMatchObject({ status: 'awaiting_approval', contributors: 3, skipped: {} });
    expect(s.calls).toHaveLength(3);
    // What goes back to Router is sealed: no answer, note or count in readable form.
    expect(JSON.stringify(out)).not.toMatch(/would_have_helped|not_applicable|trial run|applies/);

    // Each owner opens their own preview with their own key; nobody else can.
    const preview = openPreview(out.previews.find(p => p.did === people[0].did)!, people[0].did, 'run-1', people[0].wallet.privateKey);
    expect(preview.body.your_items).toMatchObject([{ entryId: 'post-alice', answer: { applies: 'yes' }, note: 'A tiny trial run first would have exposed the mistake early.' }]);
    expect(preview.body.draft).toMatchObject({ people: 3, traces_read: 3, applies: { yes: 1, no: 2 }, notes: ['A tiny trial run first would have exposed the mistake early.'] });
    expect(verifyMessage(canonical(preview.body), preview.signature)).toBe(new Wallet(RELEASE_KEY).address);
    expect(() => openPreview(out.previews.find(p => p.did === people[0].did)!, people[0].did, 'run-1', people[1].wallet.privateKey)).toThrow();

    // Nothing is public until everyone approves the exact result.
    expect(s.enclave.status('run-1')).toMatchObject({ status: 'awaiting_approval', published: null });
    await expect(s.approve(people[0], 'run-1', '0'.repeat(64))).rejects.toThrow('not a valid signature');
    await s.approve(people[0], 'run-1', out.result_sha256!);
    await s.approve(people[1], 'run-1', out.result_sha256!);
    const done = await s.approve(people[2], 'run-1', out.result_sha256!);
    expect(done.status).toBe('published');
    const published = done.published as any;
    expect(verifyMessage(canonical(published.body), published.signature)).toBe(new Wallet(RELEASE_KEY).address);
    expect(published.body).toMatchObject({ released: true, approvals: 3, people: 3, applies: { yes: 1, no: 2 } });
    expect(JSON.stringify(published)).not.toMatch(/alice|bob|carol|post-/);

    // The same question is not read again from the same traces.
    const again = await s.enclave.run({ run: 'run-2', ...QUESTION, owners: await Promise.all(people.map(p => s.authorize(p, 'run-2'))) });
    expect(again).toMatchObject({ status: 'withheld', skipped: { already_read_for_this_question: 3 } });
  });

  it('refuses whatever Router could fake: another signer, question, run, trace or program', async () => {
    const s = setup();
    const [alice, bob, carol, dave, erin, frank] = await Promise.all([
      s.owner('alice', LOG_YES), s.owner('bob', LOG_NO), s.owner('carol', LOG_NO), s.owner('dave', LOG_NO), s.owner('erin', LOG_NO),
      s.owner('frank', LOG_NO, { program: '0'.repeat(64) })]);
    const owners = [
      await s.authorize(alice, 'run-x', {}, testWallet('mallory')),                                          // not the owner's signature
      await s.authorize(bob, 'run-x', { question: { template: 'skill-check', params: { skill: 'Something else', when: 'always' }, sha256: '1'.repeat(64) } }),
      await s.authorize(carol, 'run-other'),                                                               // signed for another run
      { ...await s.authorize(dave, 'run-x'), traces: [{ ...dave.trace, ciphertext: Buffer.from('tampered').toString('base64') }] },
      { ...await s.authorize(erin, 'run-x'), traces: [{ ...erin.trace, entryId: 'post-unlisted' }] },
      await s.authorize(frank, 'run-x'),                                                                   // consent names another program
    ];
    const out = await s.enclave.run({ run: 'run-x', ...QUESTION, owners });
    expect(out).toMatchObject({ status: 'withheld', contributors: 0, previews: [],
      skipped: { not_authorized: 4, trace_changed: 1, entry_not_authorized: 1 } });
    expect(s.calls).toHaveLength(0);

    // An expired authorization counts for nothing either.
    const late = await s.authorize(alice, 'run-y');
    s.advance(2 * 3600_000);
    expect((await s.enclave.run({ run: 'run-y', ...QUESTION, owners: [late] })).skipped).toEqual({ not_authorized: 1 });
  });

  it('withholds the result below three people, and one veto stops publication', async () => {
    const s = setup();
    const [alice, bob, carol] = await Promise.all([s.owner('alice', LOG_YES), s.owner('bob', LOG_NO), s.owner('carol', LOG_NO)]);
    const two = await s.enclave.run({ run: 'run-a', ...QUESTION, owners: [await s.authorize(alice, 'run-a'), await s.authorize(bob, 'run-a')] });
    expect(two).toMatchObject({ status: 'withheld', result_sha256: null, contributors: 2 });
    expect(openPreview(two.previews[0], two.previews[0].did, 'run-a', [alice, bob].find(p => p.did === two.previews[0].did)!.wallet.privateKey).body)
      .toMatchObject({ draft: null, withheld: 'fewer than 3 people contributed' });

    const s2 = setup();
    const people = [await s2.owner('alice', LOG_YES), await s2.owner('bob', LOG_NO), await s2.owner('carol', LOG_NO)];
    const out = await s2.enclave.run({ run: 'run-b', ...QUESTION, owners: await Promise.all(people.map(p => s2.authorize(p, 'run-b'))) });
    await s2.approve(people[0], 'run-b', out.result_sha256!);
    expect((await s2.approve(people[1], 'run-b', out.result_sha256!, false)).status).toBe('vetoed');
    await expect(s2.approve(people[2], 'run-b', out.result_sha256!)).rejects.toThrow('vetoed');
    expect(s2.enclave.status('run-b')).toMatchObject({ status: 'vetoed', published: null });
    expect(carol.name).toBe('carol');
  });

  it('describes itself with what the attestation binds', async () => {
    const s = setup();
    let seen: Buffer | null = null;
    const withQuote = insightsEnclave({ releasePrivateKey: RELEASE_KEY, appId: APP, model: MODEL, build: { gitSha: null, imageDigest: null },
      complete: async () => '', quote: async data => { seen = data; return { quote: 'synthetic' }; } });
    const info = await withQuote.info();
    expect(info).toMatchObject({ release_key: s.releaseKey, app_id: APP, upgrades: { by: 'operator' }, min_people: 3, quote: { quote: 'synthetic' } });
    expect(info.identity_sha256).toBe(sha256Hex(canonical({ release_key: s.releaseKey, app_id: APP, program_sha256: info.program_sha256, upgrades: { by: 'operator' }, min_people: 3 })));
    expect(seen!.subarray(0, 32).toString('hex')).toBe(info.identity_sha256);
  });
});
