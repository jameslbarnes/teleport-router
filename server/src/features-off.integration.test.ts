import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateSecretKey, derivePseudonym } from './identity.js';
import { generateEntryId, type JournalEntry } from './storage.js';
import { normalizeBenchmarkNote } from './benchmarks.js';
import { normalizeTerritoryNote } from './research-map.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// Skill notes, benchmarks and research maps are switched off unless ROUTER_SKILL_NOTES,
// ROUTER_BENCHMARKS and ROUTER_RESEARCH_MAPS are "1". Switched off, no tool, field, list or page
// offers them, a call or a write that uses them is refused, and notes stored while they were on
// are still there as ordinary notes. The posting tools (router_skills) are a different thing and stay.
const port = 14500 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const author = { key: generateSecretKey(), handle: `offa${tag}` };
const reader = { key: generateSecretKey(), handle: `offr${tag}` };
const WHEN = 'A live pipeline got slower and you do not know which stage.';
const OFF_TOOLS = ['router_use_skill', 'router_benchmarks', 'router_map'];
const OFF_FIELDS = ['skill', 'benchmark', 'territory', 'place', 'mark'];
let child: ChildProcess;
let dataDir = '';
const clients: Client[] = [];

// Notes written while the features were on, as the server finds them after a restart.
const stored = (content: string, fields: Partial<JournalEntry>): JournalEntry => ({
  id: generateEntryId(), pseudonym: derivePseudonym(author.key), handle: author.handle, client: 'code', content,
  timestamp: Date.now() - 60_000, publishAt: Date.now() + 3_600_000, ...fields,
});
const skillNote = stored(`OFFSKILL${tag} time each stage separately before guessing.`, { skill: { name: 'tracing-latency', whenToUse: WHEN } });
const benchmarkNote = stored(`OFFBENCH${tag} held-out sentences, word error rate.`, { benchmark: normalizeBenchmarkNote({
  kind: 'scenario', scenario: 'held-out', title: 'Held-out sentences', region: 'adaptation', metric: 'word error rate, %', better: 'lower', baseline: 24.3,
}) });
const mapNote = stored(`OFFMAP${tag} the field as of today.`, { territory: normalizeTerritoryNote({
  name: 'field-map', title: 'A synthetic field', places: [{ id: 'listening', label: 'Listening', status: 'open' }],
}) });
const placedNote = stored(`OFFPLACE${tag} training on its own output did nothing.`, { place: 'field-map/listening', mark: 'failed-attempt' });

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'features-off-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  clients.push(client);
  return client;
}

const text = (result: any): string => (result.content as any[] || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
const write = (client: Client, fields: Record<string, unknown>) => client.callTool({ name: 'router_write_entry', arguments: {
  client: 'code', entry: 'A synthetic note.', to: [`@${reader.handle}`], search_keywords: [], sensitivity_check: 'Synthetic switch test', posting_intent: 'user-requested', ...fields,
} });

describe('skill notes, benchmarks and research maps switched off', () => {
  let authorClient: Client, readerClient: Client;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'router-features-off-'));
    const recoveryFile = join(dataDir, 'pending-recovery.json');
    writeFileSync(recoveryFile, JSON.stringify({ entries: [skillNote, benchmarkNote, mapNote, placedNote], conversations: [] }));
    let startupOutput = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, ROUTER_SKILL_NOTES: '', ROUTER_BENCHMARKS: '', ROUTER_RESEARCH_MAPS: '', RECOVERY_FILE: recoveryFile,
        PORT: String(port), BASE_URL: base, STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000', TINYCLOUD_GROUPS: 'memory', TINYCLOUD_AUTHORS: '', MODERATOR_URL: '', TELEGRAM_BOT_TOKEN: '', MATRIX_HOMESERVER_URL: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', data => { startupOutput = (startupOutput + data.toString()).slice(-2000); });
    child.stdout?.resume();
    let ready = false;
    for (let i = 0; i < 200; i++) {
      try { if ((await api('/health')).ok) { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 150));
    }
    if (!ready) throw new Error(`Switch test server did not start (exit ${child.exitCode}): ${startupOutput}`);
    for (const user of [author, reader]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    // The stored notes publish the usual way, by their author.
    for (const note of [skillNote, benchmarkNote, mapNote, placedNote]) {
      expect((await api(`/api/entries/${note.id}/publish`, {}, author.key)).ok, note.content).toBe(true);
    }
    authorClient = await connect(author.key);
    readerClient = await connect(reader.key);
  }, 40000);

  afterAll(async () => {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    child?.kill();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('lists none of their tools or fields, and no tool or instruction mentions them', async () => {
    // The author has a published skill note, which would be listed at session start if skill notes were on.
    expect(authorClient.getInstructions() || '').not.toMatch(/Skills shared with this person|router_use_skill/);
    const { tools } = await authorClient.listTools();
    const names = tools.map(t => t.name);
    for (const name of OFF_TOOLS) expect(names, name).not.toContain(name);
    const writeTool = tools.find(t => t.name === 'router_write_entry')!;
    for (const field of OFF_FIELDS) expect(Object.keys(writeTool.inputSchema.properties || {}), field).not.toContain(field);
    expect(Object.keys(writeTool.inputSchema.properties || {})).toEqual(expect.arrayContaining(['entry', 'to', 'tags', 'repo']));
    const everything = JSON.stringify(tools);
    for (const word of [...OFF_TOOLS, 'Skills shared with this person', 'know-how', 'benchmark', 'leaderboard', 'research map', 'when_to_use']) {
      expect(everything, word).not.toContain(word);
    }
  });

  it('refuses calls to their tools with a plain reason', async () => {
    const skill = await authorClient.callTool({ name: 'router_use_skill', arguments: { action: 'list' } });
    expect(skill.isError).toBe(true);
    expect(text(skill)).toBe('Skill notes are switched off on this server.');
    for (const action of ['enable_group', 'mute', 'report']) {
      const refused = await authorClient.callTool({ name: 'router_use_skill', arguments: { action, group: 'anything', name: 'tracing-latency', outcome: 'helped' } });
      expect(text(refused), action).toBe('Skill notes are switched off on this server.');
    }
    const board = await authorClient.callTool({ name: 'router_benchmarks', arguments: { group_id: 'anything' } });
    expect(board.isError).toBe(true);
    expect(text(board)).toBe('Benchmarks are switched off on this server.');
    const map = await authorClient.callTool({ name: 'router_map', arguments: { group_id: 'anything' } });
    expect(map.isError).toBe(true);
    expect(text(map)).toBe('Research maps are switched off on this server.');
  });

  it('refuses a write that still sends one of their fields, and posts nothing', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['skill', { name: 'tracing-latency', when_to_use: WHEN }, 'Skill notes'],
      ['benchmark', { kind: 'scenario', scenario: 'held-out' }, 'Benchmarks'],
      ['territory', { name: 'field-map', title: 'A field', places: [] }, 'Research maps'],
      ['place', 'field-map/listening', 'Research maps'],
      ['mark', 'finding', 'Research maps'],
    ];
    for (const [field, value, feature] of cases) {
      const result = await write(authorClient, { [field]: value });
      expect(result.isError, field).toBe(true);
      expect(text(result), field).toBe(`${feature} are switched off on this server. Post it again without the \`${field}\` field.`);
    }
    // Without those fields the same write goes through.
    const ordinary = await write(authorClient, {});
    expect(ordinary.isError).toBeFalsy();
    expect((ordinary.structuredContent as any).receipt.entry_id).toBeTruthy();
  });

  it('answers the map page and its API like missing pages', async () => {
    const res = await api('/api/channels/anything/map', undefined, author.key);
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error).toBe('Research maps are switched off on this server.');
    expect((await api('/map')).status).toBe(404);
    expect((await api('/map.js')).status).toBe(404);
  });

  it('keeps notes stored while they were on, readable and searchable as ordinary notes', async () => {
    for (const note of [skillNote, benchmarkNote, mapNote, placedNote]) {
      const marker = note.content.split(' ')[0];
      const found = text(await readerClient.callTool({ name: 'router_search', arguments: { query: marker } }));
      expect(found, marker).toContain(marker);
      const read = await readerClient.callTool({ name: 'router_get_entry', arguments: { entry_id: note.id } });
      expect(read.isError, marker).toBeFalsy();
      expect(text(read), marker).toContain(`@${author.handle} posted a note:`);
      expect(text(read), marker).toContain(note.content);
    }
    expect(text(await readerClient.callTool({ name: 'router_get_entry', arguments: { entry_id: skillNote.id } }))).not.toContain(WHEN);
  });

  it('leaves the posting tools that router_skills manages as they are', async () => {
    const { tools } = await authorClient.listTools();
    for (const name of ['router_skills', 'router_skills_browse', 'router_skills_clone']) expect(tools.map(t => t.name), name).toContain(name);
    const list = await authorClient.callTool({ name: 'router_skills', arguments: { action: 'list' } });
    expect(list.isError).toBeFalsy();
    expect(text(list)).toContain('router_write_entry');
    for (const name of OFF_TOOLS) expect(text(list), name).not.toContain(name);
    const created = await authorClient.callTool({ name: 'router_skills', arguments: {
      action: 'create', name: `offtool${tag}`, description: 'Post a synthetic status line.', instructions: 'Write one line.',
    } });
    expect(created.isError, text(created)).toBeFalsy();
    const after = await authorClient.listTools();
    expect(after.tools.map(t => t.name)).toContain(`skill_offtool${tag}`);
  });
});
