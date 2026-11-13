/** The weekly pipeline, inside the insights enclave.
 *
 * A person who allows it in their consent agrees to the whole pipeline once; nobody signs each run. Each week:
 *
 *   plan   Router hands the enclave that week's public posts. The model may pick one question about how
 *          agents work and the posts that bear on it. The enclave signs that plan. No trace has been opened
 *          yet, so the plan, and any invitation Router sends because of it, carries nothing private. A week
 *          gets one plan, and the run may not start until the plan's invitation time has passed.
 *   run    Router hands over the extraction copies behind the planned posts, for the people whose consent
 *          allows the weekly pipeline. The enclave checks each consent itself, shows the model its own view
 *          of each trace (renderLog: no tool results), and keeps at most a general sentence per trace. With
 *          findings from at least MIN_PEOPLE people it asks for one drafted skill, and a second reading that
 *          can only stop the draft.
 *   wait   The draft is sealed to each person it draws on, with their own findings. For `vetoHours` any one
 *          of them can cancel it with a signature. Nothing else can publish it sooner.
 *   publish  If nobody cancelled, the skill is published, signed by the release key.
 *
 * Everything the program writes itself (question, findings, skill) must pass cleanText: a short line in a
 * small character set, with no addresses, long numbers or long tokens. Text that fails is dropped.
 *
 * Disclosed limits. Router chooses which public posts the enclave is shown, so Router can steer what is
 * looked into, within what people consented to. Public posts are written by anyone in the group, and could be
 * written to push the question somewhere it should not go; the question's rules, the output rules and the
 * veto are the guards. The same draft goes to every contributor, so someone who controls the other
 * contributors learns what the remaining person's findings added. State is kept in a file on the CVM's
 * disk; whoever can roll that disk back could make a week run twice. The clock is the CVM's.
 */
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { computeAddress, verifyMessage, Wallet } from 'ethers';
import { canonical } from './author-records.js';
import { checkUpgradePolicy, cleanText, consentMessage, insightsProgram, isoWeek, renderLog, replyJson, vetoMessage, DERIVED_MAX, DERIVED_TEXT_MAX, MIN_PEOPLE,
  type InsightsPolicy, type SignedPlan, type UpgradePolicy, type WeeklyPlan, type WeeklySkill, type WeeklyStatus, type WeeklyVeto } from './insights-program.js';
import { checkPartMeta, compressPublicKey, openPart, publicKeyOf, sealPart, sha256Hex, type PartMeta } from './trace-envelope.js';

const MAX_OWNERS = 50, MAX_TRACES = 50, FINDINGS_PER_PERSON = 2, WEEKS_KEPT = 60;
/** A plan nobody runs is closed this long after its run could have started. */
const PLAN_LAPSES_MS = 7 * 24 * 3600_000;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const didAddress = (did: unknown) => typeof did === 'string' ? /^did:pkh:eip155:1:(0x[\da-fA-F]{40})$/.exec(did)?.[1]?.toLowerCase() : undefined;
const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›').slice(0, max);

export interface WeeklyDeps {
  releasePrivateKey: string; appId: string; model: string; upgrades?: UpgradePolicy;
  complete: (args: { model: string; system: string; user: string; maxTokens: number }) => Promise<string>;
  /** Where the weeks are remembered across restarts. Without it they last only as long as the process. */
  state?: { load(): unknown | null; save(value: unknown): void };
  now?: () => number;
}
interface OwnerInput {
  did?: unknown; publicKey?: unknown;
  consent?: { policy?: InsightsPolicy; signature?: unknown };
  traces?: { entryId?: unknown; meta?: unknown; ciphertext?: unknown }[];
}
interface WeekRecord {
  week: string; run: string; status: WeeklyStatus; reason: string | null;
  plan: SignedPlan | null;
  contributors: { did: string; publicKey: string }[];
  publishAfter: string | null;
  draft: WeeklySkill | null;
  /** The sealed previews, kept so Router can fetch them again if the run's answer was lost. Only their owners can open them. */
  previews?: { did: string; meta: PartMeta; ciphertext: string }[];
  published: { body: unknown; signature: string; signer: string } | null;
}

export function insightsWeekly(deps: WeeklyDeps) {
  const now = deps.now || Date.now;
  const program = insightsProgram(deps.model);
  const w = program.weekly;
  const upgrades = checkUpgradePolicy(deps.upgrades || { by: 'operator' });
  const releaseKey = publicKeyOf(deps.releasePrivateKey);
  const signer = new Wallet(deps.releasePrivateKey);
  const enclave = { appId: deps.appId, releaseKey };
  const weeks = new Map<string, WeekRecord>();
  let busy = false;

  // A week interrupted mid-run is not run again: its traces may already have been read.
  const loaded = deps.state?.load() as { weeks?: WeekRecord[] } | null | undefined;
  for (const r of loaded?.weeks || []) weeks.set(r.week, r.status === 'running' ? { ...r, status: 'withheld', reason: 'interrupted' } : r);
  const save = () => {
    while (weeks.size > WEEKS_KEPT) weeks.delete(weeks.keys().next().value as string);
    deps.state?.save({ v: 1, weeks: [...weeks.values()] });
  };
  const byRun = (run: unknown) => [...weeks.values()].find(r => r.run === run);
  const ask = async (step: { system: string; user: string }, fill: Record<string, string>, maxTokens: number) => {
    let user: string = step.user;
    for (const [name, value] of Object.entries(fill)) user = user.replace(`{${name}}`, () => value);
    const call = async () => replyJson(await deps.complete({ model: program.model, system: step.system, user, maxTokens }));
    // A reply that is not the JSON asked for is asked for once more, inside the same run; then it counts as a failure.
    try { return await call(); } catch { return call(); }
  };

  function checkConsent(o: OwnerInput) {
    const address = didAddress(o.did);
    if (!address) throw new Error('did');
    const publicKey = typeof o.publicKey === 'string' ? compressPublicKey(o.publicKey) : '';
    if (!publicKey || computeAddress(publicKey).toLowerCase() !== address) throw new Error('public key');
    const p = o.consent?.policy;
    if (!p || p.v !== 1 || p.domain !== 'teleport-router/insights-consent' || p.owner?.did !== o.did) throw new Error('no consent');
    let signedBy = '';
    try { signedBy = verifyMessage(consentMessage(p), String(o.consent?.signature)).toLowerCase(); } catch { /* below */ }
    if (signedBy !== address) throw new Error('not signed by the owner');
    // The one thing a weekly run rests on: this person said yes to the weekly pipeline, in a consent that names
    // this program, this enclave and its upgrade policy, and has not expired.
    if (p.weekly !== true) throw new Error('the consent does not allow the weekly pipeline');
    if (p.program?.sha256 !== program.sha256 || p.program?.name !== program.name) throw new Error('another program');
    if (p.enclave?.appId !== deps.appId || p.enclave?.releaseKey !== releaseKey) throw new Error('another enclave');
    if (canonical(p.enclave?.upgrades ?? null) !== canonical(upgrades)) throw new Error('another upgrade policy');
    if (p.egress?.model !== program.model) throw new Error('another model');
    if (!(Date.parse(p.expiresAt) > now())) throw new Error('expired');
    return { address, publicKey, policy: p };
  }

  function publishDue() {
    let changed = false;
    for (const r of weeks.values()) {
      if (r.status === 'planned' && r.plan && now() > Date.parse(r.plan.plan.runAfter) + PLAN_LAPSES_MS) { r.status = 'nothing'; r.reason = 'the plan was never run'; changed = true; continue; }
      if (r.status !== 'waiting' || !r.publishAfter || now() < Date.parse(r.publishAfter) || !r.draft || !r.plan) continue;
      const body = { v: 1, kind: 'router-insights-weekly-skill', week: r.week, run: r.run, question: r.plan.plan.question, people: r.contributors.length,
        skill: r.draft, program: { name: program.name, version: program.version, sha256: program.sha256 }, enclave, published_at: new Date(now()).toISOString() };
      r.published = { body, signature: signer.signMessageSync(canonical(body)), signer: signer.address };
      r.status = 'published'; r.draft = null; changed = true;
    }
    if (changed) save();
  }
  const publicView = (r: WeekRecord) => ({ week: r.week, run: r.run, status: r.status, reason: r.reason, plan: r.plan,
    contributors: r.contributors.length, publish_after: r.publishAfter, published: r.published });

  return {
    program,

    /** Pick this week's question from public posts, or nothing. One plan a week; asking again returns the same one. */
    async plan(input: { week?: unknown; posts?: unknown }) {
      const week = isoWeek(now());
      if (input.week !== week) throw new Error(`Only the current week (${week}) can be planned.`);
      const existing = weeks.get(week);
      if (existing) return publicView(existing);
      const given = Array.isArray(input.posts) ? input.posts.slice(0, w.scout.maxNotes) : [];
      const posts = new Map<string, { handle: string; text: string }>();
      for (const p of given as any[]) {
        if (!validId(p?.entryId) || typeof p.handle !== 'string' || !/^[a-z0-9_-]{1,40}$/.test(p.handle) || typeof p.text !== 'string') continue;
        posts.set(p.entryId, { handle: p.handle, text: oneLine(p.text, w.scout.noteTextMaxChars) });
      }
      if (new Set([...posts.values()].map(p => p.handle)).size < MIN_PEOPLE) throw new Error(`A week needs public posts from at least ${MIN_PEOPLE} people.`);
      if (busy) throw new Error('The enclave is busy. Try again later.');
      busy = true;
      try {
        const notes = [...posts].map(([id, p]) => `[${id}] @${p.handle}: ${p.text}`).join('\n');
        const reply = await ask(w.scout, { notes }, 400);
        const question = cleanText(reply.question, w.scout.questionMaxChars);
        const entries = [...new Set((Array.isArray(reply.post_ids) ? reply.post_ids : []).filter((id): id is string => typeof id === 'string' && posts.has(id)))].slice(0, w.scout.maxPosts);
        const people = new Set(entries.map(id => posts.get(id)!.handle)).size;
        const record: WeekRecord = { week, run: `weekly-${week}`, status: 'nothing', reason: null, plan: null, contributors: [], publishAfter: null, draft: null, published: null };
        if (!question) record.reason = 'no question worth asking this week';
        else if (people < MIN_PEOPLE) record.reason = `the question touched posts from fewer than ${MIN_PEOPLE} people`;
        else {
          const t = now();
          const plan: WeeklyPlan = { v: 1, kind: 'router-insights-weekly-plan', week, run: record.run, question, entries,
            program: { name: program.name, version: program.version, sha256: program.sha256 }, enclave,
            plannedAt: new Date(t).toISOString(), runAfter: new Date(t + w.inviteHours * 3600_000).toISOString() };
          record.plan = { plan, signature: signer.signMessageSync(canonical(plan)), signer: signer.address };
          record.status = 'planned';
        }
        weeks.set(week, record);
        save();
        return publicView(record);
      } finally { busy = false; }
    },

    /** Read the planned traces of the people whose consent allows it, and draft at most one skill. */
    async run(input: { run?: unknown; owners?: unknown }) {
      const r = byRun(input.run);
      if (!r || !r.plan) throw new Error('No such planned run.');
      if (r.status !== 'planned') throw new Error(`This run is ${r.status}.`);
      if (now() < Date.parse(r.plan.plan.runAfter)) throw new Error(`This run may not start before ${r.plan.plan.runAfter}.`);
      const owners = Array.isArray(input.owners) ? input.owners as OwnerInput[] : [];
      if (!owners.length || owners.length > MAX_OWNERS) throw new Error(`owners must list 1 to ${MAX_OWNERS} people`);
      if (busy) throw new Error('The enclave is busy. Try again later.');
      busy = true;
      // Recorded before anything is opened: if the process dies from here on, this week is not read again.
      r.status = 'running'; save();
      const planned = new Set(r.plan.plan.entries);
      const question = r.plan.plan.question;
      const skipped: Record<string, number> = {};
      const skip = (reason: string) => { skipped[reason] = (skipped[reason] || 0) + 1; };
      const found: { did: string; publicKey: string; findings: string[] }[] = [];
      try {
        const seen = new Set<string>();
        let total = 0;
        for (const o of owners) {
          let c: ReturnType<typeof checkConsent>;
          try { c = checkConsent(o); } catch { skip('no_weekly_consent'); continue; }
          if (seen.has(c.address)) { skip('duplicate_owner'); continue; }
          seen.add(c.address);
          const findings: string[] = [], done = new Set<string>();
          let mine = 0;
          for (const t of Array.isArray(o.traces) ? o.traces : []) {
            if (++total > MAX_TRACES) { skip('too_many_traces'); break; }
            if (!validId(t.entryId) || !planned.has(t.entryId)) { skip('entry_not_planned'); continue; }
            if (done.has(t.entryId)) { skip('duplicate_entry'); continue; }
            done.add(t.entryId);
            if (++mine > c.policy.limits.maxTracesPerRun) { skip('over_the_consent_limit'); continue; }
            let log = '';
            try {
              const meta: PartMeta = checkPartMeta(t.meta, ['owner', 'release']);
              if (typeof t.ciphertext !== 'string') throw new Error('ciphertext');
              const ciphertext = Buffer.from(t.ciphertext, 'base64');
              if (ciphertext.length > DERIVED_MAX || sha256Hex(ciphertext) !== meta.sha256) { skip('trace_changed'); continue; }
              // The envelope is bound to this owner and this post: a trace cannot be presented as someone else's or as another post's.
              const packed = openPart(meta, ciphertext, { ownerDid: o.did as string, entryId: t.entryId }, 'derived', 'release', deps.releasePrivateKey);
              const unpacked = gunzipSync(packed, { maxOutputLength: DERIVED_MAX * 64 });
              packed.fill(0);
              log = renderLog(unpacked.toString('utf8'), program.templates['skill-check'].logView, DERIVED_TEXT_MAX);
              unpacked.fill(0);
              const reply = await ask(w.read, { question, log }, 300);
              const finding = reply.relevant === 'yes' ? cleanText(reply.finding, w.read.findingMaxChars) : '';
              if (finding && findings.length < FINDINGS_PER_PERSON && !findings.includes(finding)) findings.push(finding);
            } catch { skip('unreadable_or_failed'); } finally { log = ''; }
          }
          if (findings.length) found.push({ did: o.did as string, publicKey: c.publicKey, findings });
        }

        let draft: WeeklySkill | null = null;
        if (found.length < MIN_PEOPLE) { r.status = 'withheld'; r.reason = `findings from fewer than ${MIN_PEOPLE} people`; }
        else {
          // One line per finding, in an order that says nothing about whose it is.
          const findings = found.flatMap(f => f.findings).sort().map(f => `- ${f}`).join('\n');
          const reply = await ask(w.combine, { question, findings }, 600);
          const title = cleanText(reply.title, w.combine.titleMaxChars), when = cleanText(reply.when, w.combine.whenMaxChars);
          const steps = (Array.isArray(reply.steps) ? reply.steps : []).slice(0, w.combine.maxSteps).map(s => cleanText(s, w.combine.stepMaxChars));
          if (!title || !when || !steps.length || steps.some(s => !s)) { r.status = 'nothing'; r.reason = 'no skill was warranted, or its words broke the rules'; }
          else {
            // A second reading that can only stop the draft.
            const verdict = await ask(w.check, { text: [title, when, ...steps].join('\n') }, 100).catch(() => ({ specific: 'unknown' }));
            if (verdict.specific !== 'no') { r.status = 'withheld'; r.reason = 'the check did not clear the draft'; }
            else { draft = { title, when, steps }; r.status = 'waiting'; r.reason = null; r.publishAfter = new Date(now() + w.vetoHours * 3600_000).toISOString(); }
          }
        }
        r.draft = draft;
        r.contributors = found.map(f => ({ did: f.did, publicKey: f.publicKey }));
        save();
        // Each contributor gets the draft and their own findings, sealed to them. Nobody else can read either before the wait is over.
        const previews = found.map(f => {
          const body = { v: 1, kind: 'router-insights-weekly-preview', week: r.week, run: r.run, question, enclave,
            program: { name: program.name, version: program.version, sha256: program.sha256 }, sent_to: `Anthropic API (${program.model})`,
            your_findings: f.findings, draft, status: r.status, reason: r.reason, contributors: found.length, publish_after: r.publishAfter, nonce: randomBytes(16).toString('hex') };
          const sealed = sealPart(Buffer.from(canonical({ body, signature: signer.signMessageSync(canonical(body)), signer: signer.address })),
            { ownerDid: f.did, entryId: r.run }, 'preview', { owner: f.publicKey });
          return { did: f.did, meta: sealed.meta, ciphertext: sealed.ciphertext.toString('base64') };
        });
        r.previews = previews; save();
        return { run: r.run, status: r.status as WeeklyStatus, reason: r.reason, contributors: found.length, skipped, previews, publish_after: r.publishAfter };
      } catch (err) {
        r.status = 'withheld'; r.reason = 'the run failed'; r.draft = null; save();
        throw err;
      } finally { busy = false; }
    },

    /** A contributor's signed cancellation. One is enough; nothing can undo it. */
    veto(input: { run?: unknown; did?: unknown; veto?: { body?: WeeklyVeto; signature?: unknown } }) {
      publishDue();
      const r = byRun(input.run);
      if (!r) throw new Error('No such run.');
      const c = r.contributors.find(x => x.did === input.did);
      if (!c) throw new Error('Only people this draft draws on can cancel it.');
      if (r.status !== 'waiting') throw new Error(`This run is ${r.status}.`);
      const v = input.veto?.body;
      let by = '';
      try { by = v ? verifyMessage(vetoMessage(v), String(input.veto?.signature)).toLowerCase() : ''; } catch { /* below */ }
      if (!v || by !== didAddress(c.did) || v.v !== 1 || v.domain !== 'teleport-router/insights-weekly-veto' || v.run !== r.run
        || v.enclave?.appId !== deps.appId || v.enclave?.releaseKey !== releaseKey) throw new Error('That is not a valid signed cancellation of this draft.');
      r.status = 'vetoed'; r.reason = 'cancelled by a contributor'; r.draft = null; r.publishAfter = null;
      save();
      return publicView(r);
    },

    /** For Router: a run's sealed previews again. Each opens only with its owner's key. */
    previews(run: unknown) {
      const r = byRun(run);
      if (!r) throw new Error('No such run.');
      return r.previews || [];
    },

    /** Publish any draft whose wait is over. The server calls this every minute; status and veto call it too. */
    tick() { publishDue(); },

    /** Public: one week, or the recent ones. A waiting draft is never shown here. */
    status(run?: unknown) {
      publishDue();
      if (run === undefined) return [...weeks.values()].slice(-20).reverse().map(publicView);
      const r = byRun(run);
      return r ? publicView(r) : null;
    },
  };
}

/** For owners' clients: open a weekly preview sealed to them. Check its signature against the release key you checked. */
export function openWeeklyPreview(sealed: { meta: PartMeta; ciphertext: string }, ownerDid: string, run: string, ownerPrivateKey: string) {
  return JSON.parse(openPart(sealed.meta, Buffer.from(sealed.ciphertext, 'base64'), { ownerDid, entryId: run }, 'preview', 'owner', ownerPrivateKey).toString('utf8'));
}
