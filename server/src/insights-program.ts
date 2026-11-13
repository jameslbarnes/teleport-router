/** What Router, the insights enclave and owners' clients all compute the same way: the program and its hash,
 * the question a run asks, the texts people sign, the view of a trace the model is shown, and the answer
 * that may come back. The enclave's image is built from this file and a few others, so it stays small:
 * nothing here may import Router's storage or server code.
 */
import { canonical } from './author-records.js';
import { INSIGHTS_SPEC } from './insights-spec.js';
import { sha256Hex } from './trace-envelope.js';

export const DERIVED_MAX = 400 * 1024;        // ciphertext bytes of one extraction copy
export const DERIVED_TEXT_MAX = 600_000;      // characters after decompression, and of the view shown to the model
export const MAX_ENTRIES_PER_RUN = 50;
/** Fewer people than this and nothing about a run's answers is ever published. */
export const MIN_PEOPLE = 3;
const REQUEST_HOURS_MAX = 168;
/** An authorization must last until its request's deadline, and never longer than this. */
export const AUTHORIZATION_MAX_MS = (REQUEST_HOURS_MAX + 24) * 3600_000;

/** The fixed program. Its hash is what a consent names: the questions that can be asked,
 * the instructions to the model, the model, what the model is shown and what may come out. */
export function insightsProgram(model: string) {
  const s = INSIGHTS_SPEC;
  const spec = {
    name: s.name, version: s.version, model,
    templates: {
      'skill-check': {
        params: { question: { oneOf: Object.keys(s.questions) } },
        questions: s.questions as Record<string, { rule: string; when: string }>,
        system: s.system, user: s.user,
        output: { applies: [...s.output.applies], effect: [...s.output.effect], cost: [...s.output.cost] },
        logView: s.logView,
      },
    },
    weekly: s.weekly,
    limits: { derivedMaxBytes: DERIVED_MAX, derivedTextMaxChars: DERIVED_TEXT_MAX, entriesPerRun: MAX_ENTRIES_PER_RUN, eachTraceReadOncePerQuestion: true, minPeopleToRelease: MIN_PEOPLE },
    released: `Skill checks: each contributor gets only their own answers, sealed to them, and approves or vetoes publishing them; once everyone has decided, counts of the fixed answers are published if at least ${MIN_PEOPLE} people approved, otherwise nothing. Weekly pipeline: at most one drafted skill a week, built from general findings of at least ${MIN_PEOPLE} people; the draft is sealed to those people for ${s.weekly.vetoHours} hours, any one of them can cancel it, and it is published only if none did.`,
  };
  return { ...spec, sha256: sha256Hex(canonical(spec)) };
}
export type InsightsProgram = ReturnType<typeof insightsProgram>;

/** A request's question: a template and the id of one of its listed questions. Nothing else is accepted,
 * so nobody who asks for a run can put words of their own in front of the model. */
export function checkQuestion(program: InsightsProgram, templateName: unknown, paramsInput: unknown) {
  const template = typeof templateName === 'string' && Object.hasOwn(program.templates, templateName)
    ? program.templates[templateName as keyof typeof program.templates] : undefined;
  if (!template || typeof templateName !== 'string') throw new Error(`template must be one of: ${Object.keys(program.templates).join(', ')}`);
  const given = paramsInput && typeof paramsInput === 'object' && !Array.isArray(paramsInput) ? paramsInput as Record<string, unknown> : {};
  const id = given.question;
  if (Object.keys(given).length !== 1 || typeof id !== 'string' || !Object.hasOwn(template.questions, id))
    throw new Error(`params must be { "question": one of ${template.params.question.oneOf.join(', ')} }`);
  const params: Record<string, string> = { question: id };
  return { name: templateName, template, params, rule: template.questions[id].rule, when: template.questions[id].when,
    sha256: questionSha256(program.sha256, templateName, params) };
}

/** The question's identity, computed the same way by Router, the enclave and owners' clients. */
export const questionSha256 = (programSha256: string, template: string, params: Record<string, string>) =>
  sha256Hex(canonical({ program: programSha256, template, params }));

/** Who can put new code behind the release key, as the deployment declares it. */
export type UpgradePolicy =
  | { by: 'operator' }
  | { by: 'timelock'; chain: string; appContract: string; timelock: string; delayHours: number };

export function checkUpgradePolicy(input: unknown): UpgradePolicy {
  const u = input as Record<string, unknown> | null;
  const address = (a: unknown) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (u && u.by === 'operator' && Object.keys(u).length === 1) return { by: 'operator' };
  if (u && u.by === 'timelock' && Object.keys(u).length === 5 && typeof u.chain === 'string' && /^[a-z0-9-]{2,32}$/.test(u.chain)
    && address(u.appContract) && address(u.timelock) && Number.isInteger(u.delayHours) && (u.delayHours as number) >= 48 && (u.delayHours as number) <= 720)
    return { by: 'timelock', chain: u.chain, appContract: (u.appContract as string).toLowerCase(), timelock: (u.timelock as string).toLowerCase(), delayHours: u.delayHours as number };
  throw new Error('The upgrade policy must be the operator, or a timelock with a chain, app contract and timelock addresses, and 48 to 720 hours of delay.');
}

function upgradesLine(u: UpgradePolicy): string {
  return u.by === 'timelock'
    ? `Code updates: only through a public ${u.delayHours}-hour timelock on ${u.chain} (app contract ${u.appContract}, timelock ${u.timelock}). New code can use the release key only after it has been public that long, unless someone holding a cancel key stops it first, and I can revoke before then. This permission is not tied to one code version.`
    : 'Code updates: approved by the operator of this Router, not by me. This permission is not tied to one code version.';
}

export interface InsightsPolicy {
  v: 1; domain: 'teleport-router/insights-consent'; server: string; policyId: string;
  owner: { handle: string; did: string };
  program: { name: string; version: number; sha256: string };
  enclave: { appId: string; releaseKey: string; upgrades: UpgradePolicy };
  scope: { groups: string[] };
  triggers: { handle: string; keyId: string }[];
  egress: { provider: 'Anthropic API'; model: string };
  limits: { maxTracesPerRun: number };
  /** True: the owner agrees to the whole weekly pipeline, with no signature for each run. False: skill checks only, each authorized by the owner. */
  weekly: boolean;
  issuedAt: string; expiresAt: string;
}

/** What the enclave signs once it has picked a week's question from public posts, before any trace is opened. */
export interface WeeklyPlan {
  v: 1; kind: 'router-insights-weekly-plan';
  week: string; run: string;
  question: string;
  /** The public posts whose traces the run may read. */
  entries: string[];
  program: { name: string; version: number; sha256: string };
  enclave: { appId: string; releaseKey: string };
  plannedAt: string;
  /** The run may not start before this: the time people who have not consented get to answer an invitation. */
  runAfter: string;
}
export interface SignedPlan { plan: WeeklyPlan; signature: string; signer: string }
export interface WeeklySkill { title: string; when: string; steps: string[] }
/** What a contributor signs to cancel a week's draft before it is published. */
export interface WeeklyVeto { v: 1; domain: 'teleport-router/insights-weekly-veto'; run: string; enclave: { appId: string; releaseKey: string } }
export const vetoMessage = (v: WeeklyVeto) => 'Teleport Router: cancel this week\'s drafted skill before it is published\n\n' + canonical(v);
export type WeeklyStatus = 'planned' | 'running' | 'waiting' | 'published' | 'vetoed' | 'nothing' | 'withheld';
/** A week of the year as the pipeline names it, for example 2026-W46 (ISO 8601). */
export function isoWeek(ms: number): string {
  const d = new Date(ms); d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));           // the Thursday of this week
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** The only words of its own the program may keep or publish. Text that fails is dropped, not repaired. */
export function cleanText(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return '';
  // Typographic apostrophes and dashes are read as plain ones; nothing else is changed.
  const t = value.replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, ' ').trim();
  if (!t || t.length > maxChars || !/^[A-Za-z0-9 ,.;:'()?-]+$/.test(t) || /https?:|www\.|\d{4,}|[A-Za-z0-9-]{24,}/i.test(t)) return '';
  return t;
}
/** The first JSON object in a model reply. */
export function replyJson(reply: string): Record<string, unknown> {
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON answer');
  const raw = JSON.parse(reply.slice(start, end + 1));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('No JSON answer');
  return raw;
}

/** What an owner signs to let one run read some of their traces. */
export interface RunAuthorization {
  v: 1; domain: 'teleport-router/insights-run-authorization';
  run: string;
  enclave: { appId: string; releaseKey: string };
  policyId: string;
  question: { template: string; params: Record<string, string>; sha256: string };
  entries: { entryId: string; derivedSha256: string }[];
  expiresAt: string;
}
export const authorizationMessage = (a: RunAuthorization) => 'Teleport Router: allow one insights run to read these traces\n\n' + canonical(a);

/** What a contributor signs to approve, or veto, publishing their own contribution to one run. `commitment` is the
 * salted hash their sealed preview carries; nobody without that preview can work out what it commits to. */
export interface ContributionApproval {
  v: 1; domain: 'teleport-router/insights-contribution-approval';
  run: string; enclave: { appId: string; releaseKey: string }; commitment: string; approve: boolean;
}
export const approvalMessage = (a: ContributionApproval) => 'Teleport Router: decide whether my contribution to this insights run may be published\n\n' + canonical(a);

/** The text an owner signs. Deterministic, so the server and any client derive the same bytes. */
export function consentMessage(p: InsightsPolicy): string {
  return [
    'Teleport Router: permission to read my private traces for insights',
    '',
    `I am @${p.owner.handle} (${p.owner.did}).`,
    'I allow the program below to read the extraction copy of the private traces behind my posts, in runs I authorize one at a time.',
    '',
    `Program: ${p.program.name} v${p.program.version}`,
    `Program SHA-256: ${p.program.sha256}`,
    `Runs only inside: the enclave of ${p.server} (app ${p.enclave.appId})`,
    `Enclave release key: ${p.enclave.releaseKey}`,
    upgradesLine(p.enclave.upgrades),
    `May read: traces of my published posts in ${p.scope.groups.map(g => '#' + g).join(', ')}`,
    `May be requested by: ${p.triggers.length ? p.triggers.map(t => `@${t.handle} [${t.keyId}]`).join(', ') : 'nobody (no skill checks; the weekly pipeline starts itself)'}`,
    'May ask: in a skill check, only the questions listed in the program, chosen by id',
    p.weekly
      ? `Weekly pipeline: yes. Once a week the program may read the public posts in those groups, choose one question about how agents work, read the traces behind the posts it picked without asking me again, and draft one skill. I get the draft first, sealed to me, and can cancel it for ${INSIGHTS_SPEC.weekly.vetoHours} hours; if nobody cancels, it is published.`
      : 'Weekly pipeline: no. Every run needs my signature.',
    `Leaves the enclave during a run: what I typed, what my agent wrote and which tools it called, sent to the ${p.egress.provider} (model ${p.egress.model}). What the tools returned is left out.`,
    `Comes out: my own answers, sealed to me; a published result of counts built only from contributions their owners approved, and only with ${MIN_PEOPLE} or more of them`,
    `Limits: at most ${p.limits.maxTracesPerRun} of my traces per run; each trace read once per question`,
    `Valid from ${p.issuedAt} until ${p.expiresAt}. I can revoke it at any time; revoking stops later runs only.`,
    `Policy ID: ${p.policyId}`,
    `Policy SHA-256: ${sha256Hex(canonical(p))}`,
  ].join('\n');
}

// ── What the model is shown of a trace ──────────────────────────────────────────────────

const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `+${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s`;
};
// The view is wrapped in <log> tags, so no angle bracket from a trace may reach it; and one line per item.
const plain = (text: string, max: number) => {
  const t = text.replace(/\s+/g, ' ').trim().replace(/</g, '‹').replace(/>/g, '›');
  return t.length <= max ? t : `${t.slice(0, max)} … (${t.length - max} more characters)`;
};
const sizeOf = (value: unknown): number => typeof value === 'string' ? value.length
  : Array.isArray(value) ? value.reduce<number>((n, v) => n + sizeOf(v), 0)
  : value && typeof value === 'object' ? sizeOf((value as any).text ?? (value as any).content ?? '') : 0;

/**
 * Build the view of one trace that the model reads. The enclave does this itself, from the trace's records,
 * so the view does not depend on which client uploaded the trace.
 *
 * Text that came from outside the session is the way a stranger could steer the model: a web page, a search
 * result, a file, an email or someone else's note can say anything, including lines made to look like later
 * parts of the session. All of that arrives as tool results, so tool results are never shown: only that a
 * call returned, how much, and whether it failed. What remains is what the person typed, what the agent
 * wrote and which tools it called. That text can still repeat outside words (a paste, a quotation); the
 * limit is disclosed in the program (`logView`) rather than hidden.
 */
export function renderLog(raw: string, view: { personTextMaxChars: number; agentTextMaxChars: number; toolInputMaxChars: number }, maxChars = DERIVED_TEXT_MAX): string {
  let doc: any;
  try { doc = JSON.parse(raw); } catch { throw new Error('The trace is not a record list'); }
  if (!doc || doc.kind !== 'router-post-trace' || !Array.isArray(doc.records)) throw new Error('The trace is not a record list');
  const lines: string[] = [];
  let start: number | null = null, shown = 0;
  for (const r of doc.records) {
    if (!r || typeof r !== 'object') continue;
    const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : NaN;
    if (Number.isFinite(at) && start === null) start = at;
    const when = Number.isFinite(at) && start !== null ? elapsed(at - start) : '+?';
    const role = r.message?.role ?? r.type;
    if (role !== 'user' && role !== 'assistant') continue;
    const content = r.message?.content;
    const blocks: any[] = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
    for (const b of blocks) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        lines.push(role === 'user' ? `[${when}] PERSON: ${plain(b.text, view.personTextMaxChars)}` : `[${when}] AGENT: ${plain(b.text, view.agentTextMaxChars)}`);
        shown++;
      } else if (b.type === 'tool_use' && role === 'assistant') {
        const name = typeof b.name === 'string' ? b.name.replace(/[^\w.:-]/g, '_').slice(0, 80) : 'tool';
        lines.push(`[${when}] AGENT CALLED ${name}: ${plain(JSON.stringify(b.input ?? {}), view.toolInputMaxChars)}`);
        shown++;
      } else if (b.type === 'tool_result') {
        const size = Number.isInteger(b.left_out_characters) && b.left_out_characters >= 0 ? b.left_out_characters : sizeOf(b.content);
        lines.push(`[${when}] TOOL RETURNED: ${b.is_error === true ? 'failed' : 'ok'}, ${size} characters, not shown`);
      }
    }
  }
  if (!shown) throw new Error('The trace has nothing the program can show');
  let text = lines.join('\n');
  if (text.length > maxChars) {
    // Keep the beginning and the end, whole lines only.
    const head: string[] = [], tail: string[] = [];
    let used = 0, i = 0, j = lines.length - 1;
    while (i <= j && used + lines[i].length + 1 <= maxChars * 0.6) { head.push(lines[i]); used += lines[i].length + 1; i++; }
    while (j >= i && used + lines[j].length + 1 <= maxChars - 80) { tail.unshift(lines[j]); used += lines[j].length + 1; j--; }
    text = [...head, `[… ${j - i + 1} lines left out to fit the size limit …]`, ...tail].join('\n');
  }
  return text;
}

/** Accept only the fixed answer shape: three choices from the listed values. Anything else the model wrote is dropped. */
export function parseAnswer(reply: string, schema: { applies: readonly string[]; effect: readonly string[]; cost: readonly string[] }) {
  const start = reply.indexOf('{'), end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('No JSON answer');
  const raw = JSON.parse(reply.slice(start, end + 1));
  const answer = { applies: String(raw.applies), effect: String(raw.effect), cost: String(raw.cost) };
  if (!schema.applies.includes(answer.applies) || !schema.effect.includes(answer.effect) || !schema.cost.includes(answer.cost)) throw new Error('Answer outside the allowed values');
  return answer;
}
