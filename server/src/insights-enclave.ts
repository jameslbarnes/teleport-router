/** The insights enclave: a small app in its own CVM that holds the release key and runs the extraction.
 *
 * Router keeps storage, consents and run requests, and hands the enclave ciphertext for one run at a
 * time. Router never holds the release key and the enclave never gets storage access, so reading a
 * trace needs both. Because Router assembles each run, the enclave trusts nothing Router says about
 * scope or answers. It opens a trace only when:
 *   - the owner's consent is signed by the key that owns their storage and names this program,
 *     this enclave and its upgrade policy, and has not expired; and
 *   - the owner signed a fresh authorization for this run: this enclave, that consent, the exact
 *     question, the run's nonce, and each entry with the hash of its ciphertext.
 * The owner's agent signs that authorization under the owner's standing rules; it is what checks
 * scope (which posts, which groups) before signing.
 *
 * Nothing about the answers leaves in plaintext. Each contributor gets a preview sealed to their own
 * key: their answers, their notes, and the draft result. The result is published, signed by the
 * release key, only after every contributor has signed approval of its exact hash, and only when at
 * least MIN_PEOPLE distinct owners contributed. A veto stops it.
 *
 * Disclosed limits of this version: run state and read-once markers live in memory, so they hold
 * only within one running enclave. Who can upgrade this code is the deployment's upgrade policy,
 * named in every consent. The model provider sees the trace text it is sent.
 */
import { randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { computeAddress, verifyMessage, Wallet } from 'ethers';
import { canonical } from './author-records.js';
import { approvalMessage, authorizationMessage, AUTHORIZATION_MAX_MS, checkUpgradePolicy, consentMessage, insightsProgram, MIN_PEOPLE, parseAnswer, questionSha256,
  type InsightsPolicy, type ResultApproval, type RunAuthorization, type UpgradePolicy } from './insights-release.js';
import { checkPartMeta, compressPublicKey, openPart, publicKeyOf, sealPart, sha256Hex, type PartMeta } from './trace-envelope.js';

const DERIVED_MAX = 400 * 1024, DERIVED_TEXT_MAX = 600_000, MAX_OWNERS = 50, MAX_ENTRIES = 50;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const didAddress = (did: unknown) => typeof did === 'string' ? /^did:pkh:eip155:1:(0x[\da-fA-F]{40})$/.exec(did)?.[1]?.toLowerCase() : undefined;

export { authorizationMessage, approvalMessage, questionSha256, type RunAuthorization, type ResultApproval } from './insights-release.js';

export interface EnclaveDeps {
  releasePrivateKey: string; appId: string; model: string; upgrades?: UpgradePolicy;
  build: { gitSha: string | null; imageDigest: string | null };
  complete: (args: { model: string; system: string; user: string; maxTokens: number }) => Promise<string>;
  /** A TDX quote over 64 bytes of report data, when running in a CVM. Null outside one. */
  quote?: (reportData: Buffer) => Promise<unknown | null>;
  now?: () => number;
}

interface OwnerInput {
  did?: unknown; publicKey?: unknown;
  consent?: { policy?: InsightsPolicy; signature?: unknown };
  authorization?: { body?: RunAuthorization; signature?: unknown };
  traces?: { entryId?: unknown; meta?: unknown; ciphertext?: unknown }[];
}
type Answer = { applies: string; effect: string; cost: string };
interface Contribution { did: string; publicKey: string; items: { entryId: string; traceSha256: string; answer: Answer; note: string }[] }
interface EnclaveRun {
  run: string; at: string; questionSha256: string; template: string; params: Record<string, string>;
  contributors: Contribution[]; draft: Record<string, unknown> | null; resultSha256: string | null;
  decisions: Map<string, boolean>; status: 'withheld' | 'awaiting_approval' | 'published' | 'vetoed'; published: unknown | null;
}

export function insightsEnclave(deps: EnclaveDeps) {
  const now = deps.now || Date.now;
  const program = insightsProgram(deps.model);
  const upgrades = checkUpgradePolicy(deps.upgrades || { by: 'operator' });
  const releaseKey = publicKeyOf(deps.releasePrivateKey);
  const signer = new Wallet(deps.releasePrivateKey);
  const enclave = { appId: deps.appId, releaseKey };
  const runs = new Map<string, EnclaveRun>();
  const readOnce = new Set<string>();
  /** What the attestation binds: this key, this program, this policy, this app. */
  const identity = { release_key: releaseKey, app_id: deps.appId, program_sha256: program.sha256, upgrades, min_people: MIN_PEOPLE };
  const identitySha256 = sha256Hex(canonical(identity));

  function checkOwner(o: OwnerInput, question: { template: string; params: Record<string, string>; sha256: string }, run: string) {
    const address = didAddress(o.did);
    if (!address) throw new Error('owner did must be did:pkh:eip155:1:<address>');
    const publicKey = typeof o.publicKey === 'string' ? compressPublicKey(o.publicKey) : '';
    if (!publicKey || computeAddress(publicKey).toLowerCase() !== address) throw new Error('The owner public key does not belong to that did.');
    const p = o.consent?.policy;
    if (!p || p.v !== 1 || p.domain !== 'teleport-router/insights-consent' || p.owner?.did !== o.did) throw new Error('No consent from this owner.');
    let signedBy = '';
    try { signedBy = verifyMessage(consentMessage(p), String(o.consent?.signature)).toLowerCase(); } catch { /* below */ }
    if (signedBy !== address) throw new Error('The consent is not signed by the owner.');
    if (p.program?.sha256 !== program.sha256 || p.program?.name !== program.name) throw new Error('The consent names a different program.');
    if (p.enclave?.appId !== deps.appId || p.enclave?.releaseKey !== releaseKey) throw new Error('The consent names a different enclave.');
    if (canonical(p.enclave?.upgrades ?? null) !== canonical(upgrades)) throw new Error('The consent names a different upgrade policy.');
    if (p.egress?.model !== program.model) throw new Error('The consent names a different model.');
    if (!(Date.parse(p.expiresAt) > now())) throw new Error('The consent has expired.');

    const a = o.authorization?.body;
    if (!a || a.v !== 1 || a.domain !== 'teleport-router/insights-run-authorization') throw new Error('No authorization for this run.');
    let authorizedBy = '';
    try { authorizedBy = verifyMessage(authorizationMessage(a), String(o.authorization?.signature)).toLowerCase(); } catch { /* below */ }
    if (authorizedBy !== address) throw new Error('The authorization is not signed by the owner.');
    if (a.run !== run || a.enclave?.appId !== deps.appId || a.enclave?.releaseKey !== releaseKey) throw new Error('The authorization is for another run or enclave.');
    if (a.policyId !== p.policyId) throw new Error('The authorization relies on a different consent.');
    if (a.question?.sha256 !== question.sha256 || a.question?.template !== question.template || canonical(a.question?.params ?? null) !== canonical(question.params))
      throw new Error('The authorization is for a different question.');
    const expires = Date.parse(a.expiresAt);
    if (!(expires > now()) || expires - now() > AUTHORIZATION_MAX_MS) throw new Error('The authorization has expired or lasts too long.');
    if (!Array.isArray(a.entries) || !a.entries.length || a.entries.length > p.limits.maxTracesPerRun) throw new Error('The authorization lists too many or no entries.');
    const allowed = new Map(a.entries.map(e => [e.entryId, e.derivedSha256]));
    return { address, publicKey, policy: p, allowed };
  }

  return {
    program, releaseKey,

    /** Public: what an owner's client checks before trusting this enclave. */
    async info() {
      const reportData = Buffer.alloc(64);
      Buffer.from(identitySha256, 'hex').copy(reportData);
      const quote = deps.quote ? await deps.quote(reportData).catch(() => null) : null;
      return { ...identity, program, identity_sha256: identitySha256, report_data: reportData.toString('hex'),
        build: deps.build, quote, key_binding: upgrades.by === 'timelock'
          ? `app identity, with new code only through a public ${upgrades.delayHours}-hour timelock on ${upgrades.chain}`
          : 'app identity: any build the operator deploys can use this key' };
    },

    /** One run. Returns only sealed previews and hashes; nothing readable about anyone's answers. */
    async run(input: { run?: unknown; template?: unknown; params?: unknown; owners?: unknown }) {
      if (!validId(input.run)) throw new Error('run must be an id');
      if (runs.has(input.run)) throw new Error('This run has already happened.');
      const template = typeof input.template === 'string' ? program.templates[input.template as keyof typeof program.templates] : undefined;
      if (!template || typeof input.template !== 'string') throw new Error('Unknown template');
      const params: Record<string, string> = {};
      for (const [name, rule] of Object.entries(template.params)) {
        const value = (input.params as any)?.[name];
        if (typeof value !== 'string' || !value.trim() || value.length > rule.maxChars || !/^[A-Za-z0-9 ,.;:'()\/-]+$/.test(value)) throw new Error(`Bad ${name}`);
        params[name] = value.trim();
      }
      const question = { template: input.template, params, sha256: questionSha256(program.sha256, input.template, params) };
      const owners = Array.isArray(input.owners) ? input.owners as OwnerInput[] : [];
      if (!owners.length || owners.length > MAX_OWNERS) throw new Error(`owners must list 1 to ${MAX_OWNERS} people`);
      const seen = new Set<string>();
      const contributors: Contribution[] = [];
      const skipped: Record<string, number> = {};
      const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
      let entriesTotal = 0;

      for (const o of owners) {
        let checked: ReturnType<typeof checkOwner>;
        try { checked = checkOwner(o, question, input.run); } catch { skip('not_authorized'); continue; }
        if (seen.has(checked.address)) { skip('duplicate_owner'); continue; }
        seen.add(checked.address);
        const contribution: Contribution = { did: o.did as string, publicKey: checked.publicKey, items: [] };
        for (const t of Array.isArray(o.traces) ? o.traces : []) {
          if (++entriesTotal > MAX_ENTRIES) { skip('too_many_entries'); break; }
          if (!validId(t.entryId) || !checked.allowed.has(t.entryId)) { skip('entry_not_authorized'); continue; }
          let log = '';
          try {
            const meta: PartMeta = checkPartMeta(t.meta, ['owner', 'release']);
            if (typeof t.ciphertext !== 'string') throw new Error('ciphertext');
            const ciphertext = Buffer.from(t.ciphertext, 'base64');
            const traceSha256 = sha256Hex(ciphertext);
            if (ciphertext.length > DERIVED_MAX || traceSha256 !== meta.sha256 || traceSha256 !== checked.allowed.get(t.entryId)) { skip('trace_changed'); continue; }
            const marker = `${question.sha256}:${traceSha256}`;
            if (readOnce.has(marker)) { skip('already_read_for_this_question'); continue; }
            readOnce.add(marker);
            const packed = openPart(meta, ciphertext, { ownerDid: o.did as string, entryId: t.entryId }, 'derived', 'release', deps.releasePrivateKey);
            log = gunzipSync(packed, { maxOutputLength: DERIVED_TEXT_MAX * 4 }).toString('utf8').slice(0, DERIVED_TEXT_MAX);
            packed.fill(0);
            const reply = await deps.complete({ model: program.model, system: template.system, maxTokens: 400,
              user: template.user.replace('{skill}', params.skill).replace('{when}', params.when).replace('{log}', () => log) });
            const parsed = parseAnswer(reply, template.output, log);
            contribution.items.push({ entryId: t.entryId, traceSha256, answer: parsed.answer, note: parsed.note });
          } catch { skip('unreadable_or_failed'); } finally { log = ''; }
        }
        if (contribution.items.length) contributors.push(contribution);
      }

      const r: EnclaveRun = { run: input.run, at: new Date(now()).toISOString(), questionSha256: question.sha256, template: question.template, params,
        contributors, draft: null, resultSha256: null, decisions: new Map(), status: 'withheld', published: null };
      runs.set(r.run, r);
      if (contributors.length >= MIN_PEOPLE) {
        const items = contributors.flatMap(c => c.items);
        const count = (field: keyof Answer) => items.reduce<Record<string, number>>((acc, i) => { acc[i.answer[field]] = (acc[i.answer[field]] || 0) + 1; return acc; }, {});
        // The draft carries no owner, post or order that could point to either.
        r.draft = { run: r.run, question_sha256: r.questionSha256, template: r.template, params, program: { name: program.name, version: program.version, sha256: program.sha256 },
          people: contributors.length, people_where_it_applies: contributors.filter(c => c.items.some(i => i.answer.applies === 'yes')).length,
          traces_read: items.length, applies: count('applies'), effect: count('effect'), cost: count('cost'),
          notes: [...new Set(items.map(i => i.note).filter(Boolean))].sort() };
        r.resultSha256 = sha256Hex(canonical(r.draft));
        r.status = 'awaiting_approval';
      }
      // Each contributor's preview is sealed to them: their own answers, and the draft everyone must approve.
      const previews = await Promise.all(contributors.map(async c => {
        const body = { v: 1, kind: 'router-insights-preview', run: r.run, at: r.at, enclave, question, program: r.draft ? (r.draft as any).program : { sha256: program.sha256 },
          build: deps.build, sent_to: `Anthropic API (${program.model})`, your_items: c.items, draft: r.draft, result_sha256: r.resultSha256,
          withheld: r.draft ? null : `fewer than ${MIN_PEOPLE} people contributed` };
        const signature = await signer.signMessage(canonical(body));
        const sealed = sealPart(Buffer.from(canonical({ body, signature, signer: signer.address })), { ownerDid: c.did, entryId: `run-${r.run}` }, 'preview', { owner: c.publicKey });
        return { did: c.did, meta: sealed.meta, ciphertext: sealed.ciphertext.toString('base64') };
      }));
      return { run: r.run, status: r.status, result_sha256: r.resultSha256, contributors: contributors.length, skipped, previews };
    },

    /** A contributor's signed approval or veto of the exact draft. Publishes once everyone has approved. */
    async decide(input: { run?: unknown; did?: unknown; approval?: { body?: ResultApproval; signature?: unknown } }) {
      const r = typeof input.run === 'string' ? runs.get(input.run) : undefined;
      if (!r) throw new Error('No such run.');
      const c = r.contributors.find(x => x.did === input.did);
      if (!c) throw new Error('Only contributors to this run can decide.');
      if (r.status !== 'awaiting_approval') throw new Error(`This run is ${r.status.replace(/_/g, ' ')}.`);
      const a = input.approval?.body;
      let by = '';
      try { by = a ? verifyMessage(approvalMessage(a), String(input.approval?.signature)).toLowerCase() : ''; } catch { /* below */ }
      if (!a || by !== didAddress(c.did) || a.v !== 1 || a.domain !== 'teleport-router/insights-result-approval' || a.run !== r.run
        || a.enclave?.appId !== deps.appId || a.enclave?.releaseKey !== releaseKey || a.resultSha256 !== r.resultSha256 || typeof a.approve !== 'boolean')
        throw new Error('That decision is not a valid signature over this result.');
      r.decisions.set(c.did, a.approve);
      if (!a.approve) { r.status = 'vetoed'; return { run: r.run, status: r.status }; }
      if (r.contributors.every(x => r.decisions.get(x.did) === true)) {
        const body = { ...r.draft, released: true, approvals: r.contributors.length, enclave, published_at: new Date(now()).toISOString() };
        r.published = { body, signature: await signer.signMessage(canonical(body)), signer: signer.address };
        r.status = 'published';
      }
      return { run: r.run, status: r.status, approved: [...r.decisions.values()].filter(Boolean).length, contributors: r.contributors.length, published: r.published };
    },

    /** Public: a run's status, and its result once published. */
    status(run: unknown) {
      const r = typeof run === 'string' ? runs.get(run) : undefined;
      if (!r) return null;
      return { run: r.run, at: r.at, status: r.status, question_sha256: r.questionSha256, result_sha256: r.resultSha256,
        contributors: r.contributors.length, decided: r.decisions.size, published: r.published };
    },
  };
}

/** For owners' clients: open a preview sealed to them. */
export function openPreview(sealed: { meta: PartMeta; ciphertext: string }, ownerDid: string, run: string, ownerPrivateKey: string) {
  return JSON.parse(openPart(sealed.meta, Buffer.from(sealed.ciphertext, 'base64'), { ownerDid, entryId: `run-${run}` }, 'preview', 'owner', ownerPrivateKey).toString('utf8'));
}

export const newRunId = () => randomUUID();
