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
 * Each contributor sees only their own contribution, never anyone else's: their preview, sealed to
 * them, holds their answers and notes and a commitment to them salted with a secret only that preview
 * carries. Each contributor then signs approval, or a veto, of their own contribution by that
 * commitment. Once everyone has decided, the result is built from the approved contributions only and
 * published, signed by the release key, if at least MIN_PEOPLE approved; otherwise nothing comes out.
 * Distinct keys are not proof of distinct people: someone who controls the other contributors could
 * subtract their own answers from a published count. That limit is disclosed.
 *
 * Other disclosed limits of this version: run state and read-once markers live in memory, so they hold
 * only within one running enclave, and a contributor who never decides holds publication up. Who can
 * upgrade this code is the deployment's upgrade policy, named in every consent. The model provider sees
 * the trace text it is sent.
 */
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { computeAddress, verifyMessage, Wallet } from 'ethers';
import { canonical } from './author-records.js';
import { approvalMessage, authorizationMessage, AUTHORIZATION_MAX_MS, checkUpgradePolicy, consentMessage, insightsProgram, MIN_PEOPLE, parseAnswer, questionSha256,
  type InsightsPolicy, type ContributionApproval, type RunAuthorization, type UpgradePolicy } from './insights-release.js';
import { checkPartMeta, compressPublicKey, openPart, publicKeyOf, sealPart, sha256Hex, type PartMeta } from './trace-envelope.js';

export { authorizationMessage, approvalMessage, questionSha256, type RunAuthorization, type ContributionApproval } from './insights-release.js';

const DERIVED_MAX = 400 * 1024, DERIVED_TEXT_MAX = 600_000, MAX_OWNERS = 50, MAX_ENTRIES = 50;
const RUNS_KEPT = 500, READ_MARKERS_KEPT = 200_000;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const didAddress = (did: unknown) => typeof did === 'string' ? /^did:pkh:eip155:1:(0x[\da-fA-F]{40})$/.exec(did)?.[1]?.toLowerCase() : undefined;

/** The commitment a contributor approves: their own items, salted with a secret only their preview carries. */
export const contributionCommitment = (run: string, did: string, salt: string, items: unknown) => sha256Hex(canonical({ run, did: did.toLowerCase(), salt, items }));

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
type Item = { entryId: string; traceSha256: string; answer: Answer; note: string };
interface Contribution { did: string; publicKey: string; items: Item[]; commitment: string }
type RunStatus = 'running' | 'awaiting_decisions' | 'published' | 'withheld';
interface EnclaveRun {
  run: string; at: string; questionSha256: string; template: string; params: Record<string, string>;
  contributors: Contribution[]; decisions: Map<string, boolean>; status: RunStatus; published: unknown | null;
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
  let busy = false;
  /** What the attestation binds: this key, this program, this policy, this app. */
  const identity = { release_key: releaseKey, app_id: deps.appId, program_sha256: program.sha256, upgrades, min_people: MIN_PEOPLE };
  const identitySha256 = sha256Hex(canonical(identity));
  const reportData = Buffer.alloc(64);
  Buffer.from(identitySha256, 'hex').copy(reportData);
  // The quote attests a fixed identity, so one is enough; asking the hardware on every request is not.
  let quoted: Promise<unknown | null> | null = null;

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

  function remember(r: EnclaveRun) {
    // Bounded memory: forget the oldest finished runs first; refuse new runs if everything kept is still open.
    if (runs.size >= RUNS_KEPT) {
      const oldest = [...runs.values()].find(x => x.status === 'published' || x.status === 'withheld');
      if (!oldest) throw new Error('Too many runs are waiting for decisions. Try again later.');
      runs.delete(oldest.run);
    }
    runs.set(r.run, r);
  }
  function markRead(marker: string) {
    if (readOnce.size >= READ_MARKERS_KEPT) readOnce.delete(readOnce.values().next().value as string);
    readOnce.add(marker);
  }

  function publishIfDecided(r: EnclaveRun) {
    if (r.status !== 'awaiting_decisions' || !r.contributors.every(c => r.decisions.has(c.did))) return;
    const approved = r.contributors.filter(c => r.decisions.get(c.did) === true);
    if (approved.length < MIN_PEOPLE) { r.status = 'withheld'; return; }
    const items = approved.flatMap(c => c.items);
    const count = (field: keyof Answer) => items.reduce<Record<string, number>>((acc, i) => { acc[i.answer[field]] = (acc[i.answer[field]] || 0) + 1; return acc; }, {});
    // Built from approved contributions only, with no owner, post or order that could point to either.
    const body = { run: r.run, question_sha256: r.questionSha256, template: r.template, params: r.params,
      program: { name: program.name, version: program.version, sha256: program.sha256 }, released: true,
      people: approved.length, people_where_it_applies: approved.filter(c => c.items.some(i => i.answer.applies === 'yes')).length,
      traces_read: items.length, applies: count('applies'), effect: count('effect'), cost: count('cost'),
      notes: [...new Set(items.map(i => i.note).filter(Boolean))].sort(), enclave, published_at: new Date(now()).toISOString() };
    r.published = { body, signature: signer.signMessageSync(canonical(body)), signer: signer.address };
    r.status = 'published';
  }

  return {
    program, releaseKey,

    /** Public: what an owner's client checks before trusting this enclave. */
    async info() {
      if (!quoted) quoted = deps.quote ? deps.quote(reportData).catch(() => null) : Promise.resolve(null);
      return { ...identity, program, identity_sha256: identitySha256, report_data: reportData.toString('hex'),
        build: deps.build, quote: await quoted, signer: signer.address, key_binding: upgrades.by === 'timelock'
          ? `app identity, with new code only through a public ${upgrades.delayHours}-hour timelock on ${upgrades.chain}`
          : 'app identity: any build the operator deploys can use this key' };
    },

    /** One run. Returns only sealed previews and counts; nothing readable about anyone's answers. */
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
      const owners = Array.isArray(input.owners) ? input.owners as OwnerInput[] : [];
      if (!owners.length || owners.length > MAX_OWNERS) throw new Error(`owners must list 1 to ${MAX_OWNERS} people`);
      if (busy) throw new Error('Another run is in progress. Try again later.');
      const question = { template: input.template, params, sha256: questionSha256(program.sha256, input.template, params) };
      // Reserve the run before any await, so a duplicate request cannot run it twice.
      const r: EnclaveRun = { run: input.run, at: new Date(now()).toISOString(), questionSha256: question.sha256, template: question.template, params,
        contributors: [], decisions: new Map(), status: 'running', published: null };
      remember(r);
      busy = true;
      const skipped: Record<string, number> = {};
      const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
      try {
        const seen = new Set<string>();
        let entriesTotal = 0;
        for (const o of owners) {
          let checked: ReturnType<typeof checkOwner>;
          try { checked = checkOwner(o, question, r.run); } catch { skip('not_authorized'); continue; }
          if (seen.has(checked.address)) { skip('duplicate_owner'); continue; }
          seen.add(checked.address);
          const items: Item[] = [];
          const done = new Set<string>();
          for (const t of Array.isArray(o.traces) ? o.traces : []) {
            if (++entriesTotal > MAX_ENTRIES) { skip('too_many_entries'); break; }
            if (!validId(t.entryId) || !checked.allowed.has(t.entryId)) { skip('entry_not_authorized'); continue; }
            if (done.has(t.entryId)) { skip('duplicate_entry'); continue; }
            done.add(t.entryId);
            let log = '';
            try {
              const meta: PartMeta = checkPartMeta(t.meta, ['owner', 'release']);
              if (typeof t.ciphertext !== 'string') throw new Error('ciphertext');
              const ciphertext = Buffer.from(t.ciphertext, 'base64');
              const traceSha256 = sha256Hex(ciphertext);
              if (ciphertext.length > DERIVED_MAX || traceSha256 !== meta.sha256 || traceSha256 !== checked.allowed.get(t.entryId)) { skip('trace_changed'); continue; }
              const marker = `${question.sha256}:${traceSha256}`;
              if (readOnce.has(marker)) { skip('already_read_for_this_question'); continue; }
              const packed = openPart(meta, ciphertext, { ownerDid: o.did as string, entryId: t.entryId }, 'derived', 'release', deps.releasePrivateKey);
              log = gunzipSync(packed, { maxOutputLength: DERIVED_TEXT_MAX * 4 }).toString('utf8').slice(0, DERIVED_TEXT_MAX);
              packed.fill(0);
              const reply = await deps.complete({ model: program.model, system: template.system, maxTokens: 400,
                user: template.user.replace('{skill}', params.skill).replace('{when}', params.when).replace('{log}', () => log) });
              const parsed = parseAnswer(reply, template.output, log);
              // Consumed only once it produced an answer: a failed attempt can be retried.
              markRead(marker);
              items.push({ entryId: t.entryId, traceSha256, answer: parsed.answer, note: parsed.note });
            } catch { skip('unreadable_or_failed'); } finally { log = ''; }
          }
          if (items.length) r.contributors.push({ did: o.did as string, publicKey: checked.publicKey, items, commitment: '' });
        }
        r.status = r.contributors.length >= MIN_PEOPLE ? 'awaiting_decisions' : 'withheld';
        // Each contributor sees only their own contribution, committed to with a salt only their preview carries.
        const previews = r.contributors.map(c => {
          const salt = randomBytes(32).toString('hex');
          c.commitment = contributionCommitment(r.run, c.did, salt, c.items);
          const body = { v: 1, kind: 'router-insights-preview', run: r.run, at: r.at, enclave, question,
            program: { name: program.name, version: program.version, sha256: program.sha256 }, build: deps.build, sent_to: `Anthropic API (${program.model})`,
            your_items: c.items, salt, commitment: c.commitment, contributors: r.contributors.length, min_people: MIN_PEOPLE,
            withheld: r.status === 'withheld' ? `fewer than ${MIN_PEOPLE} people contributed` : null };
          const signature = signer.signMessageSync(canonical(body));
          const sealed = sealPart(Buffer.from(canonical({ body, signature, signer: signer.address })), { ownerDid: c.did, entryId: `run-${r.run}` }, 'preview', { owner: c.publicKey });
          return { did: c.did, meta: sealed.meta, ciphertext: sealed.ciphertext.toString('base64') };
        });
        return { run: r.run, status: r.status, contributors: r.contributors.length, skipped, previews };
      } catch (err) {
        r.status = 'withheld';
        throw err;
      } finally { busy = false; }
    },

    /** A contributor's signed approval or veto of their own contribution. Publishes once everyone has decided. */
    async decide(input: { run?: unknown; did?: unknown; approval?: { body?: ContributionApproval; signature?: unknown } }) {
      const r = typeof input.run === 'string' ? runs.get(input.run) : undefined;
      if (!r) throw new Error('No such run.');
      const c = r.contributors.find(x => x.did === input.did);
      if (!c) throw new Error('Only contributors to this run can decide.');
      if (r.status !== 'awaiting_decisions') throw new Error(`This run is ${r.status.replace(/_/g, ' ')}.`);
      if (r.decisions.has(c.did)) throw new Error('You have already decided on this run.');
      const a = input.approval?.body;
      let by = '';
      try { by = a ? verifyMessage(approvalMessage(a), String(input.approval?.signature)).toLowerCase() : ''; } catch { /* below */ }
      if (!a || by !== didAddress(c.did) || a.v !== 1 || a.domain !== 'teleport-router/insights-contribution-approval' || a.run !== r.run
        || a.enclave?.appId !== deps.appId || a.enclave?.releaseKey !== releaseKey || a.commitment !== c.commitment || typeof a.approve !== 'boolean')
        throw new Error('That decision is not a valid signature over your contribution to this run.');
      r.decisions.set(c.did, a.approve);
      publishIfDecided(r);
      return { run: r.run, status: r.status, decided: r.decisions.size, contributors: r.contributors.length, published: r.published };
    },

    /** Public: a run's status, and its result once published. */
    status(run: unknown) {
      const r = typeof run === 'string' ? runs.get(run) : undefined;
      if (!r) return null;
      return { run: r.run, at: r.at, status: r.status, question_sha256: r.questionSha256,
        contributors: r.contributors.length, decided: r.decisions.size, published: r.published };
    },
  };
}

/** For owners' clients: open a preview sealed to them. Check its signature against the release key you checked. */
export function openPreview(sealed: { meta: PartMeta; ciphertext: string }, ownerDid: string, run: string, ownerPrivateKey: string) {
  return JSON.parse(openPart(sealed.meta, Buffer.from(sealed.ciphertext, 'base64'), { ownerDid, entryId: `run-${run}` }, 'preview', 'owner', ownerPrivateKey).toString('utf8'));
}
