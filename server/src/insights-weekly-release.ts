/** The weekly insights pipeline: Router's side. The enclave's side, and the whole flow, is in insights-weekly.ts.
 *
 * People consent once to the weekly pipeline (`weekly: true` in their consent); nobody signs each run.
 *
 *   plan     Router gathers the last 7 days of published posts in the open groups that at least one current
 *            weekly consent names, and hands them to the enclave. If the enclave signs a plan (one question,
 *            the posts that bear on it), Router checks the signature against the enclave's release key and
 *            keeps the plan in a register.
 *   invite   Each author of a planned post who has no current weekly consent gets one Router message: which of
 *            their own posts were picked, the question, what the program does, and how to consent or to stop
 *            these messages. At most one a week, never to someone who turned them off, and never a word about
 *            anyone else.
 *   run      Once the plan's `runAfter` has passed, Router hands the enclave the extraction copies behind the
 *            planned posts, for the people whose current consent allows the weekly pipeline and names the
 *            post's group. Each sealed preview that comes back goes into its owner's own space.
 *   veto     A contributor's signed cancellation is passed on. Only the enclave judges it.
 *
 * What Router remembers. The register lives in memory. After a restart it is rebuilt from the enclave, which
 * keeps its weeks on its own disk, so a week is not planned twice. "Was this person invited this week" is a
 * field on the account record, so it survives a restart too. Sealed previews that could not be stored yet
 * are held in memory only.
 *
 * What is public: what the enclave shows of each week (the signed plan, counts, the skill once published),
 * and two counts from Router: people invited, and people with a weekly consent among the planned authors.
 * Never who.
 */
import { computeAddress, verifyMessage } from 'ethers';
import { canonical } from './author-records.js';
import type { AuthorBinding } from './author-store.js';
import type { GroupStore } from './group-store.js';
import type { JournalEntry, User } from './storage.js';
import { cleanText, isoWeek, MIN_PEOPLE, type SignedPlan } from './insights-program.js';
import { INSIGHTS_SPEC } from './insights-spec.js';
import type { EnclaveClient, EnclaveInfo, InsightsPolicy, SealedPreview, WeeklyOwnerInput, WeekView } from './insights-release.js';

const DAYS = 7, GROUP_POSTS_MAX = 500, OWNERS_MAX = 50, TRACES_MAX = 50, STORE_TRIES = 3;
/** When a week could not be planned (too few posts, or the enclave did not answer), the timer tries again this much later. */
const PLAN_RETRY_MS = 6 * 3600_000;
const validId = (id: unknown): id is string => typeof id === 'string' && /^[\w-]{1,160}$/.test(id);
const groupId = (g: unknown): g is string => typeof g === 'string' && /^[a-z0-9][a-z0-9-]{1,40}$/.test(g);
const handleOk = (h: unknown): h is string => typeof h === 'string' && /^[a-z0-9_-]{1,40}$/.test(h);
const message = (err: unknown) => err instanceof Error ? err.message : String(err);

/** Two fields on the account record: the person's switch for invitations, and the last week they were sent one. */
export type WeeklyUser = User & { insightsInvites?: 'on' | 'off'; insightsInvited?: { week: string; at: number } };

export interface WeeklyReleaseDeps {
  /** The insights enclave and what it said about itself at startup. */
  enclave: { client: EnclaveClient; info: EnclaveInfo } | null;
  /** Consents and stored traces: the two methods insightsRelease offers for this. */
  release: {
    weeklyConsent(user: User): InsightsPolicy | null;
    weeklyOwner(user: User, entryIds: string[]): Promise<WeeklyOwnerInput | null>;
  };
  baseUrl: string;
  getUser(handle: string): Promise<User | null>;
  updateUser(handle: string, updates: Record<string, unknown>): Promise<User | null>;
  listUsers(): Promise<User[]>;
  getEntry(id: string): Promise<JournalEntry | null>;
  storeFor(binding: AuthorBinding): Promise<GroupStore>;
  /** A group's join rule, or null if there is no such group. */
  getGroup(id: string): Promise<{ joinRule?: 'open' | 'invite'; visibility?: 'public' | 'private' } | null>;
  /** The newest posts addressed to a group, waiting ones included (they are skipped here). */
  listGroupEntries(group: string, limit: number): Promise<JournalEntry[]>;
  /** Send one private Router message from the system to a handle. */
  sendMessage(handle: string, text: string): Promise<void>;
  now?: () => number;
}

interface Week {
  week: string; run: string; plan: SignedPlan;
  /** Set before the enclave is called, so two timers cannot hand the same week over twice. */
  handed: boolean; inviting: boolean;
  note: string | null;
  invited: number; consenting: number;
  /** Sealed previews not yet written to their owner's space. */
  undelivered: { handle: string; preview: SealedPreview }[];
}
export type RunOutcome = { run: string; outcome: 'not_before'; run_after: string }
  | { run: string; outcome: 'handed_over'; status: string; contributors: number; skipped: Record<string, number> }
  | { run: string; outcome: 'too_few_people'; people: number }
  | { run: string; outcome: 'failed'; error: string };

export function insightsWeeklyRelease(deps: WeeklyReleaseDeps) {
  const now = deps.now || Date.now;
  const iso = (t: number) => new Date(t).toISOString();
  const w = INSIGHTS_SPEC.weekly;
  const need = () => { if (!deps.enclave) throw new Error('Insights runs are not enabled on this server.'); return deps.enclave; };
  /** Planned weeks, by run id. */
  const weeks = new Map<string, Week>();
  /** Weeks the enclave already has a record for, planned or not: they are not planned again. */
  const settled = new Set<string>();
  let ready: Promise<void> | null = null, planning: Promise<unknown> | null = null, nextPlanAttempt = 0;

  /** A plan counts only if the enclave's release key signed exactly these bytes, for this enclave and with clean words. */
  function checkPlan(signed: SignedPlan | null | undefined, week?: string, offered?: Set<string>): SignedPlan {
    const info = need().info, p = signed?.plan;
    let by = '';
    try { by = signed ? verifyMessage(canonical(signed.plan), String(signed.signature)) : ''; } catch { /* below */ }
    const releaseAddress = computeAddress(info.release_key);
    if (!p || by !== releaseAddress || (typeof info.signer === 'string' && info.signer !== releaseAddress))
      throw new Error('The plan is not signed by the enclave\'s release key.');
    if (p.v !== 1 || p.kind !== 'router-insights-weekly-plan' || p.enclave?.releaseKey !== info.release_key || p.enclave?.appId !== info.app_id
      || p.program?.sha256 !== info.program_sha256 || !/^\d{4}-W\d{2}$/.test(p.week) || !validId(p.run) || (week !== undefined && p.week !== week)
      || !Array.isArray(p.entries) || !p.entries.length || !p.entries.every(validId) || (offered && !p.entries.every(id => offered.has(id)))
      // The question is quoted in invitations, so it must be the plain line the program is allowed to write.
      || cleanText(p.question, w.scout.questionMaxChars) !== p.question
      || !Number.isFinite(Date.parse(p.runAfter)) || !Number.isFinite(Date.parse(p.plannedAt)))
      throw new Error('The plan is not one this enclave and program could have made from the posts it was given.');
    return signed!;
  }

  const listed = async (): Promise<WeekView[]> => { const s = await need().client.weeklyStatus(); return Array.isArray(s) ? s : []; };

  /** After a start: take the weeks the enclave remembers instead of planning them again. */
  const ensure = () => ready ??= (async () => {
    for (const v of await listed()) {
      settled.add(v.week);
      if (!v.plan || weeks.has(v.run)) continue;
      try {
        const plan = checkPlan(v.plan, v.week);
        // The enclave shows a week it is reading, or has read, as anything but "planned"; those are never handed over again.
        weeks.set(v.run, { week: v.week, run: v.run, plan, handed: v.status !== 'planned', inviting: false, note: null, invited: 0, consenting: 0, undelivered: [] });
      } catch (err) { console.error(`[Insights] weekly: a plan the enclave lists for ${String(v.week).slice(0, 20)} was refused: ${message(err)}`); }
    }
    // Previews a restart may have cut short: without theirs, a contributor could not cancel a draft that is waiting.
    // The enclave keeps them; they are stored again in each contributor's own space (the same key, so nothing doubles).
    for (const week of weeks.values()) {
      if (!week.handed) continue;
      try {
        const previews = await need().client.weeklyPreviews(week.run);
        if (!previews.length) continue;
        const byDid = new Map<string, string>();
        for (const handle of (await authorsOf(week)).keys()) { const did = (await deps.getUser(handle))?.tinycloud?.ownerDid; if (did) byDid.set(did, handle); }
        week.undelivered = previews.flatMap(preview => byDid.has(preview.did) ? [{ handle: byDid.get(preview.did)!, preview }] : []);
        await deliver(week);
      } catch (err) { console.error(`[Insights] weekly: previews of ${week.run} could not be fetched again: ${message(err)}`); }
    }
    // Invitations a restart may have cut short, and the two counts. Sending is at most once per person per week.
    for (const week of weeks.values()) await invite(week).catch(err => console.error(`[Insights] weekly: invitations for ${week.week} failed: ${message(err)}`));
  })().catch(err => { ready = null; throw err; });

  /** The planned posts that are still published, by author. */
  async function authorsOf(week: Week) {
    const byAuthor = new Map<string, { entryId: string; groups: string[] }[]>();
    for (const entryId of week.plan.plan.entries) {
      const entry = await deps.getEntry(entryId);
      if (!entry?.handle || (entry.publishAt && entry.publishAt > now())) continue;
      const groups = (entry.to || []).filter(d => d.startsWith('#')).map(d => d.slice(1)).filter(groupId);
      byAuthor.set(entry.handle, [...(byAuthor.get(entry.handle) || []), { entryId, groups }]);
    }
    return byAuthor;
  }

  /** Plain text, built only from the person's own post ids and groups, the plan's question and fixed words. */
  function invitationText(week: Week, posts: { entryId: string; groups: string[] }[]) {
    const p = week.plan.plan;
    const groups = [...new Set(posts.flatMap(x => x.groups))];
    return [
      `Router insights: an invitation for the week ${p.week}`,
      '',
      'This week the insights program picked one question about how AI coding agents work:',
      `"${p.question}"`,
      '',
      `It picked ${posts.length === 1 ? 'this public post of yours' : 'these public posts of yours'} as bearing on it: ${posts.map(x => x.entryId).join(', ')}.`,
      '',
      `What the program does: once a week it reads the public posts in open groups and may pick one question. Then, inside a separate enclave, it reads the private traces (work logs) behind the posts it picked, only for people who have consented. From general findings of at least ${MIN_PEOPLE} people it may draft one skill. Each person it draws on gets the draft first, sealed to them, and any one of them can cancel it for ${w.vetoHours} hours. If nobody cancels, the skill is published.`,
      '',
      'Your trace is read only if you consent. Nothing of yours has been read, and without your consent nothing will be.',
      '',
      `To take part: read what the program and the enclave say about themselves at ${deps.baseUrl}/api/insights/release. Then have your agent sign a consent that allows the weekly pipeline${groups.length ? ` for ${groups.map(g => '#' + g).join(', ')}` : ''} (from the Router repository, in server/: node scripts/insights-owner.mjs consent --weekly), and upload the trace behind each post with an extraction copy under that consent. A post that already has a trace cannot get another.`,
      `The run starts no earlier than ${p.runAfter}. A consent or trace that arrives after it starts is not used this week.`,
      '',
      `To stop these invitations: ask your agent to POST {"invites":"off"} to ${deps.baseUrl}/api/insights/invites with your Router key. You get at most one a week.`,
    ].join('\n');
  }

  /** Invite the planned authors who have no weekly consent, once, and count. Safe to call again. */
  async function invite(week: Week) {
    if (week.inviting) return;
    week.inviting = true;
    try {
      const open = !week.handed && now() < Date.parse(week.plan.plan.runAfter);
      let invited = 0, consenting = 0;
      for (const [handle, posts] of await authorsOf(week)) {
        const user = await deps.getUser(handle) as WeeklyUser | null;
        if (!user) continue;
        if (deps.release.weeklyConsent(user)) { consenting++; continue; }
        if (user.insightsInvited?.week === week.week) { invited++; continue; }
        if (!open || user.insightsInvites === 'off') continue;
        // Recorded before sending: a failure from here on loses one invitation rather than sending two.
        if (!await deps.updateUser(handle, { insightsInvited: { week: week.week, at: now() } })) continue;
        invited++;
        try { await deps.sendMessage(handle, invitationText(week, posts)); }
        catch (err) { console.error(`[Insights] weekly: an invitation for ${week.week} could not be sent: ${message(err)}`); }
      }
      week.invited = invited; week.consenting = consenting;
    } finally { week.inviting = false; }
  }

  /** The week's published posts in the open groups that current weekly consents name. */
  async function gatherPosts() {
    const groups = new Set<string>();
    for (const user of await deps.listUsers()) for (const g of deps.release.weeklyConsent(user)?.scope.groups || []) groups.add(g);
    const openGroups = new Map<string, boolean>();
    const isOpen = async (g: string) => {
      if (!openGroups.has(g)) {
        const group = groupId(g) ? await deps.getGroup(g) : null;
        openGroups.set(g, !!group && (group.joinRule || (group.visibility === 'private' ? 'invite' : 'open')) === 'open');
      }
      return openGroups.get(g)!;
    };
    // A post an earlier week's plan already picked is not offered again, so a trace is not read in two weeks running.
    const planned = new Set([...weeks.values()].flatMap(week => week.plan.plan.entries));
    const t = now(), since = t - DAYS * 86400_000;
    const posts = new Map<string, { entryId: string; handle: string; group: string; text: string; at: number }>();
    for (const group of [...groups].sort()) {
      if (!await isOpen(group)) continue;
      for (const e of await deps.listGroupEntries(group, GROUP_POSTS_MAX)) {
        if (posts.has(e.id) || planned.has(e.id) || !validId(e.id) || !handleOk(e.handle) || typeof e.content !== 'string' || !e.content.trim()) continue;
        if (e.timestamp < since || e.timestamp > t || (e.publishAt && e.publishAt > t)) continue;      // too old, or still waiting
        // Public means every place it was sent is an open group: a post also sent to a person or a private group is left out.
        const to = e.to?.length ? e.to : [`#${group}`];
        let everywhereOpen = true;
        for (const d of to) if (!d.startsWith('#') || !await isOpen(d.slice(1))) { everywhereOpen = false; break; }
        if (everywhereOpen) posts.set(e.id, { entryId: e.id, handle: e.handle, group, text: e.content, at: e.timestamp });
      }
    }
    // The enclave reads a bounded number of notes; give it the newest.
    return [...posts.values()].sort((a, b) => b.at - a.at).slice(0, w.scout.maxNotes).map(({ at, ...post }) => post);
  }

  const publicWeek = (v: WeekView) => {
    const mine = weeks.get(v.run);
    return { ...v, people_invited: mine ? mine.invited : null, people_with_weekly_consent: mine ? mine.consenting : null, router_note: mine?.note ?? null };
  };

  async function planOnce() {
    const e = need();
    await ensure();
    const week = isoWeek(now());
    if (settled.has(week)) {
      const existing = (await listed()).find(v => v.week === week);
      return existing ? { ...publicWeek(existing), already_planned: true } : { week, status: 'not_planned' as const, reason: 'the enclave has a record of this week that it no longer lists' };
    }
    const posts = await gatherPosts();
    if (new Set(posts.map(p => p.handle)).size < MIN_PEOPLE)
      return { week, status: 'not_planned' as const, reason: `fewer than ${MIN_PEOPLE} people have public posts this week in the open groups that weekly consents name` };
    const view = await e.client.weeklyPlan({ week, posts });
    settled.add(week);
    if (view.plan) {
      // Checked before anything is done because of it: a forged or altered plan sends no invitation and starts no run.
      const plan = checkPlan(view.plan, week, new Set(posts.map(p => p.entryId)));
      const record: Week = weeks.get(plan.plan.run) || { week, run: plan.plan.run, plan, handed: view.status !== 'planned', inviting: false, note: null, invited: 0, consenting: 0, undelivered: [] };
      weeks.set(record.run, record);
      await invite(record);
    }
    return publicWeek(view);
  }

  /** Write sealed previews into their owners' spaces; whatever fails stays for the next try. */
  async function deliver(week: Week) {
    const left: Week['undelivered'] = [];
    for (const item of week.undelivered) {
      let stored = false;
      for (let i = 0; i < STORE_TRIES && !stored; i++) {
        try {
          const user = await deps.getUser(item.handle);
          if (!user?.tinycloud || user.tinycloud.ownerDid !== item.preview.did) break;
          await (await deps.storeFor(user.tinycloud)).put(`insights/weekly/${week.run}`, canonical({ run: week.run, at: iso(now()), meta: item.preview.meta, ciphertext: item.preview.ciphertext }));
          stored = true;
        } catch { /* tried again */ }
      }
      if (!stored) left.push(item);
    }
    week.undelivered = left;
    if (left.length) console.error(`[Insights] weekly: ${left.length} sealed preview(s) of ${week.run} could not be stored yet`);
  }

  async function runWeek(): Promise<RunOutcome[]> {
    const e = need();
    await ensure();
    const out: RunOutcome[] = [];
    for (const week of [...weeks.values()]) {
      if (week.handed) continue;
      const runAfter = week.plan.plan.runAfter;
      if (now() < Date.parse(runAfter)) { out.push({ run: week.run, outcome: 'not_before', run_after: runAfter }); continue; }
      // Set before the first await, so two timers racing cannot hand the same week over twice.
      week.handed = true;
      try {
        const owners: (WeeklyOwnerInput & { handle: string })[] = [];
        let traces = 0, consenting = 0;
        for (const [handle, posts] of await authorsOf(week)) {
          const user = await deps.getUser(handle);
          // Checked now, not when the plan was made: a consent revoked, expired or replaced since counts for nothing.
          if (!user || !deps.release.weeklyConsent(user)) continue;
          consenting++;
          if (owners.length >= OWNERS_MAX || traces >= TRACES_MAX) continue;
          const mine = await deps.release.weeklyOwner(user, posts.map(p => p.entryId));
          if (!mine) continue;
          mine.traces = mine.traces.slice(0, TRACES_MAX - traces);
          if (!mine.traces.length) continue;
          traces += mine.traces.length;
          owners.push({ ...mine, handle });
        }
        week.consenting = consenting;
        // Fewer people than a skill needs: nobody's trace leaves storage, and the enclave is not called.
        if (owners.length < MIN_PEOPLE) {
          week.note = `not run: fewer than ${MIN_PEOPLE} people had a weekly consent and a trace for a planned post`;
          out.push({ run: week.run, outcome: 'too_few_people', people: owners.length });
          continue;
        }
        const result = await e.client.weeklyRun({ run: week.run, owners: owners.map(({ handle, ...owner }) => owner) });
        const byDid = new Map(owners.map(o => [o.did, o.handle]));
        week.undelivered = result.previews.flatMap(preview => byDid.has(preview.did) ? [{ handle: byDid.get(preview.did)!, preview }] : []);
        await deliver(week);
        out.push({ run: week.run, outcome: 'handed_over', status: result.status, contributors: result.contributors, skipped: result.skipped });
      } catch (err) {
        week.note = 'the run failed when it was handed to the enclave';
        console.error(`[Insights] weekly: ${week.run} failed: ${message(err)}`);
        out.push({ run: week.run, outcome: 'failed', error: message(err).slice(0, 200) });
      }
    }
    return out;
  }

  /** Plan the current week, unless it has a plan already. Calls that arrive together share one attempt. */
  const planWeek = () => (planning ??= planOnce().finally(() => { planning = null; })) as ReturnType<typeof planOnce>;

  return {
    planWeek,

    /** Hand over every planned week whose invitation time has passed. Called every minute; each week is handed over at most once. */
    runWeek,

    /** The timer, once a minute. A week is planned at the first tick on or after Monday 00:00 UTC (the ISO week's
     * start) at which the enclave has no record of it, over the 7 days before; if it cannot be planned then, it is
     * tried again every six hours until the week ends. */
    async tick() {
      await ensure();
      const t = now();
      if (!settled.has(isoWeek(t)) && t >= nextPlanAttempt) {
        nextPlanAttempt = t + PLAN_RETRY_MS;
        try { await planWeek(); } catch (err) { console.error(`[Insights] weekly: planning failed: ${message(err)}`); }
      }
      await runWeek();
      for (const week of weeks.values()) if (week.undelivered.length) await deliver(week);
    },

    /** A contributor's signed cancellation, passed to the enclave. Only the enclave judges the signature. */
    async vetoWeek(user: User, run: unknown, veto: unknown) {
      const did = user.tinycloud?.ownerDid;
      if (!did || !validId(run)) throw new Error('No run of yours with that id.');
      return publicWeek(await need().client.weeklyVeto({ run, did, veto }));
    },

    /** Public: the recent weeks as the enclave shows them, with Router's two counts. Never who was invited, who declined or who contributed. */
    async listWeeks() {
      await ensure();
      return (await listed()).map(publicWeek);
    },

    /** The caller's preview of a week's draft, sealed to their key. Router stores it but cannot open it. */
    async getWeeklyPreview(user: User, run: unknown) {
      if (!validId(run)) throw new Error('run_id is required');
      if (!user.tinycloud) throw new Error('Connect your own encrypted storage first.');
      const raw = await (await deps.storeFor(user.tinycloud)).get(`insights/weekly/${run}`);
      return raw === null ? null : JSON.parse(raw);
    },

    /** The person's switch for invitations. Off: no invitation is sent to them, whatever is planned. */
    async setInvites(user: User, value: unknown) {
      if (value !== 'on' && value !== 'off') throw new Error('invites must be "on" or "off"');
      if (!await deps.updateUser(user.handle, { insightsInvites: value })) throw new Error('Could not save the setting');
      return { invites: value };
    },
  };
}

/** A stand-in for the model, for local tests with synthetic data only (INSIGHTS_MODEL_STUB=1). It tells the
 * program's prompts apart by their tags and gives each the JSON shape it asks for. A log "bears on the
 * question" when it mentions a timeout. Every word here passes cleanText. */
export function insightsModelStub(user: string): string {
  if (user.includes('<notes>'))
    return JSON.stringify({ question: 'Where did a long job hit a timeout or fail late, and what would have shown the mistake sooner',
      post_ids: [...user.matchAll(/^\[([\w-]+)\] @/gm)].map(m => m[1]) });
  if (user.includes('<findings>'))
    return JSON.stringify({ title: 'Short trial before a long job', when: 'The agent is about to start a job that takes more than a few minutes.',
      steps: ['Run the job on one small input first.', 'Start the full job only when the trial has passed.'] });
  if (user.includes('<text>')) return JSON.stringify({ specific: 'no' });
  const timeout = /<log>[\s\S]*timeout[\s\S]*<\/log>/.test(user);
  if (user.startsWith('Question:'))
    return JSON.stringify(timeout ? { relevant: 'yes', finding: 'Try a long job on a small slice first, so a mistake shows in seconds and not at the timeout.' } : { relevant: 'no', finding: '' });
  // A skill check: a fixed answer keyed on the same word.
  return JSON.stringify(timeout
    ? { applies: 'yes', effect: 'would_have_helped', cost: 'tens_of_minutes', note: 'A tiny trial run first would have exposed the mistake early.' }
    : { applies: 'no', effect: 'not_applicable', cost: 'none', note: '' });
}
