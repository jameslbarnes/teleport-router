import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Benchmark notes go to one private group. An admin defines a scenario, a member posts a result,
// another member reviews it, and router_benchmarks works out the board from the published notes.
const port = 25000 + Math.floor(Math.random() * 4000);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const admin = { key: generateSecretKey(), handle: `adm${tag}` };
const member = { key: generateSecretKey(), handle: `mem${tag}` };
const reviewer = { key: generateSecretKey(), handle: `rev${tag}` };
const outsider = { key: generateSecretKey(), handle: `out${tag}` };
const lab = `lab-${tag}`;
const open = `open-${tag}`;
let child: ChildProcess;
const clients: Client[] = [];

const SCENARIO = {
  kind: 'scenario', scenario: 'held-out-sentences', title: 'Speech recognition · held-out sentences', region: 'adaptation',
  metric: 'word error rate, %', better: 'lower', baseline: 24.3, tolerance: 0.05,
};

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'benchmarks-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  clients.push(client);
  return client;
}

const text = (result: any): string => (result.content as any[] || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

/** Writes a benchmark note and, unless told not to, publishes it at once. */
async function write(client: Client, key: string, benchmark: Record<string, unknown>, to: string[], publish = true) {
  const result = await client.callTool({ name: 'router_write_entry', arguments: {
    client: 'code', entry: `Synthetic benchmark note ${tag}`, benchmark, to, search_keywords: [], sensitivity_check: 'Synthetic benchmark test', posting_intent: 'user-requested',
  } });
  if (result.isError) return { error: text(result), id: '', text: '', structured: {} as any };
  const receipt = (result.structuredContent as any).receipt;
  if (publish) {
    if (receipt.notification_required) {
      expect((await api(`/api/entries/${receipt.entry_id}/notice`, {
        notice_id: receipt.notice_id, notice_sha256: receipt.notice_sha256,
        evidence_kind: 'agent_reported', conversation_ref: 'synthetic-benchmark-test:notice',
      }, key)).ok).toBe(true);
    }
    expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, key)).ok).toBe(true);
  }
  return { error: '', id: receipt.entry_id as string, text: text(result), structured: result.structuredContent as any };
}

const board = (client: Client, args: Record<string, unknown>) => client.callTool({ name: 'router_benchmarks', arguments: args });

describe('benchmark notes', () => {
  let adminClient: Client, memberClient: Client, reviewerClient: Client, outsiderClient: Client;
  let resultId = '';

  beforeAll(async () => {
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`Benchmark test server did not start (exit ${child.exitCode}): ${startupOutput}`);

    for (const user of [admin, member, reviewer, outsider]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    expect((await api('/api/channels', { secret_key: admin.key, id: lab, name: 'Speech lab', visibility: 'private', join_rule: 'invite', storage: 'router' })).ok).toBe(true);
    const { token } = await (await api(`/api/channels/${lab}/invite`, { secret_key: admin.key })).json() as { token: string };
    for (const user of [member, reviewer]) {
      expect((await api(`/api/channels/${lab}/join`, { secret_key: user.key, invite_token: token })).ok).toBe(true);
    }
    expect((await api('/api/channels', { secret_key: outsider.key, id: open, name: 'Open room', join_rule: 'open' })).ok).toBe(true);
    expect((await api(`/api/channels/${open}/join`, { secret_key: member.key })).ok).toBe(true);

    adminClient = await connect(admin.key);
    memberClient = await connect(member.key);
    reviewerClient = await connect(reviewer.key);
    outsiderClient = await connect(outsider.key);
  }, 40000);

  afterAll(async () => {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    child?.kill();
  });

  it('lets only an admin define a scenario, and only in one private group', async () => {
    expect((await write(memberClient, member.key, SCENARIO, [`#${lab}`])).error).toMatch(/Only an admin/);
    expect((await write(adminClient, admin.key, SCENARIO, [`#${lab}`, `@${member.handle}`])).error).toMatch(/exactly one private group/);
    expect((await write(memberClient, member.key, SCENARIO, [`#${open}`])).error).toMatch(/exactly one private group/);
    expect((await write(adminClient, admin.key, { ...SCENARIO, better: 'smaller' }, [`#${lab}`])).error).toMatch(/benchmark\.better/);
    const defined = await write(adminClient, admin.key, SCENARIO, [`#${lab}`]);
    expect(defined.error).toBe('');
    expect(defined.text).toContain('Benchmark: a new scenario "Speech recognition · held-out sentences"');
  });

  it('previews a result and refuses a self-review', async () => {
    expect((await write(memberClient, member.key, { kind: 'result', scenario: 'no-such-thing', score: 1, method: 'x' }, [`#${lab}`])).error).toMatch(/No scenario/);
    const posted = await write(memberClient, member.key, { kind: 'result', scenario: 'held-out-sentences', score: 20.9, method: 'Adapted on 10 sentences' }, [`#${lab}`]);
    expect(posted.error).toBe('');
    expect(posted.text).toContain('this moves Speech recognition · held-out sentences from 24.3 to 20.9 (3.4 better): about 365 points, 705 if someone replicates it');
    // Clients that show only the structured result must still see it.
    expect(posted.structured.benchmark).toContain('about 365 points, 705 if someone replicates it');
    resultId = posted.id;
    expect((await write(memberClient, member.key, { kind: 'review', result: resultId, score: 20.9 }, [`#${lab}`])).error).toMatch(/your own result/);
  });

  it('counts the result once another member reviews it', async () => {
    let shown = await board(memberClient, { group_id: lab });
    expect(text(shown)).toContain('No checked results yet.');
    expect(text(shown)).toContain(`Waiting for a review or replication: 20.9  @${member.handle}`);

    const reviewed = await write(reviewerClient, reviewer.key, { kind: 'review', result: resultId, score: 20.9 }, [`#${lab}`]);
    expect(reviewed.text).toContain(`your review confirms @${member.handle}'s 20.9`);

    shown = await board(memberClient, { group_id: lab });
    expect(text(shown)).toContain(`1. 20.9  @${member.handle}  "Adapted on 10 sentences"`);
    expect(text(shown)).toContain(`checked by @${reviewer.handle} (review)`);
    expect(text(shown)).toContain(`@${member.handle}: 365 points · level 3 (65 of 300 to level 4) · adaptation 365 (level 3)`);
    // Text only, so a client that prefers structured results shows the board itself.
    expect(shown.structuredContent).toBeUndefined();
    expect(text(await board(reviewerClient, { group_id: `#${lab}`, handle: `@${reviewer.handle}` }))).toContain(`@${reviewer.handle}: 15 points`);
  });

  it('leaves out notes that are still waiting', async () => {
    await write(memberClient, member.key, { kind: 'result', scenario: 'held-out-sentences', score: 19, method: 'Not published yet' }, [`#${lab}`], false);
    const shown = text(await board(adminClient, { group_id: lab, scenario: 'held-out-sentences' }));
    expect(shown).not.toContain('Not published yet');
    expect(shown).toContain(`1. 20.9  @${member.handle}`);
  });

  it('shows the board to current members of a private group only', async () => {
    expect((await board(outsiderClient, { group_id: lab })).isError).toBe(true);
    expect(text(await board(outsiderClient, { group_id: lab }))).toMatch(/current member/);
    expect(text(await board(memberClient, { group_id: open }))).toMatch(/open group/);
  });

  it('works the same in a group whose notes live in the group’s own storage', async () => {
    const vault = `vault-${tag}`;
    const created = await api('/api/channels', { secret_key: admin.key, id: vault, name: 'Own storage', storage: 'tinycloud' });
    expect(created.ok).toBe(true);
    expect((await created.json() as any).store?.kind).toBe('tinycloud');
    const { token } = await (await api(`/api/channels/${vault}/invite`, { secret_key: admin.key })).json() as { token: string };
    for (const user of [member, reviewer]) {
      expect((await api(`/api/channels/${vault}/join`, { secret_key: user.key, invite_token: token })).ok).toBe(true);
    }

    expect((await write(adminClient, admin.key, SCENARIO, [`#${vault}`])).error).toBe('');
    const posted = await write(memberClient, member.key, { kind: 'result', scenario: 'held-out-sentences', score: 20.2, method: 'Stored in the group' }, [`#${vault}`]);
    expect(posted.error).toBe('');
    expect((await write(reviewerClient, reviewer.key, { kind: 'replication', result: posted.id, score: 20.1 }, [`#${vault}`])).error).toBe('');

    const shown = await board(memberClient, { group_id: vault });
    expect(text(shown)).toContain(`1. 20.2  @${member.handle}  "Stored in the group"`);
    expect(text(shown)).toContain(`checked by @${reviewer.handle} (replication) · replicated`);
    // First score 25, plus 4.1 better than the 24.3 baseline at 100 per unit, doubled once replicated.
    expect(text(shown)).toContain(`@${member.handle}: 845 points`);
    // Points are kept per group: the first group's board is unchanged.
    expect(text(await board(memberClient, { group_id: lab }))).toContain(`@${member.handle}: 365 points`);
  });
});
