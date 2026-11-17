import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateSecretKey } from './identity.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

// A group admin posts a research map; members attach notes to its places; router_map and the
// members-only API show the map with what is attached. Nobody outside the group sees any of it.
// Windows reserves some ports above 29000; this range has none reserved and no other test uses it.
const port = 12000 + Math.floor(Math.random() * 2500);
const base = `http://127.0.0.1:${port}`;
const tag = Date.now().toString(36).slice(-6);
const admin = { key: generateSecretKey(), handle: `adm${tag}` };
const member = { key: generateSecretKey(), handle: `mem${tag}` };
const outsider = { key: generateSecretKey(), handle: `out${tag}` };
const lab = `maplab-${tag}`;
let child: ChildProcess;
const clients: Client[] = [];

const MAP = {
  name: 'field-map', title: 'A synthetic field',
  places: [
    { id: 'listening', label: 'Listening' },
    { id: 'few-examples', label: 'Few-example adaptation', parent: 'listening', status: 'emerging' },
    { id: 'hidden-errors', label: 'Hidden errors', parent: 'listening', status: 'open' },
  ],
};

async function api(path: string, body?: unknown, key?: string) {
  return fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'map-test', version: '1' });
  await client.connect(new SSEClientTransport(new URL(`${base}/mcp/sse?key=${key}`)));
  clients.push(client);
  return client;
}

const text = (result: any): string => (result.content as any[] || []).filter(b => b.type === 'text').map(b => b.text).join('\n');

async function write(client: Client, key: string, entry: string, fields: Record<string, unknown>, to: string[]) {
  const result = await client.callTool({ name: 'router_write_entry', arguments: {
    client: 'code', entry, to, search_keywords: [], sensitivity_check: 'Synthetic map test', posting_intent: 'user-requested', ...fields,
  } });
  if (result.isError) return { error: text(result), id: '', text: '', structured: {} as any };
  const receipt = (result.structuredContent as any).receipt;
  expect((await api(`/api/entries/${receipt.entry_id}/publish`, {}, key)).ok).toBe(true);
  return { error: '', id: receipt.entry_id as string, text: text(result), structured: result.structuredContent as any };
}

describe('research maps', () => {
  let adminClient: Client, memberClient: Client, outsiderClient: Client;

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
    if (!ready) throw new Error(`Map test server did not start (exit ${child.exitCode}): ${startupOutput}`);
    for (const user of [admin, member, outsider]) {
      expect((await api('/api/identity/register', { secret_key: user.key, handle: user.handle })).ok).toBe(true);
    }
    expect((await api('/api/channels', { secret_key: admin.key, id: lab, name: 'Map lab', visibility: 'private', join_rule: 'invite', storage: 'router' })).ok).toBe(true);
    const { token } = await (await api(`/api/channels/${lab}/invite`, { secret_key: admin.key })).json() as { token: string };
    expect((await api(`/api/channels/${lab}/join`, { secret_key: member.key, invite_token: token })).ok).toBe(true);
    adminClient = await connect(admin.key);
    memberClient = await connect(member.key);
    outsiderClient = await connect(outsider.key);
  }, 40000);

  afterAll(async () => {
    await Promise.all(clients.map(c => c.close().catch(() => {})));
    child?.kill();
  });

  it('lets only an admin post the map, to one private group', async () => {
    expect((await write(memberClient, member.key, 'Map', { territory: MAP }, [`#${lab}`])).error).toMatch(/Only an admin/);
    expect((await write(adminClient, admin.key, 'Map', { territory: MAP }, [`#${lab}`, `@${member.handle}`])).error).toMatch(/exactly one private group/);
    expect((await write(adminClient, admin.key, 'Map', { territory: MAP, place: 'field-map/listening' }, [`#${lab}`])).error).toMatch(/only the map/);
    const posted = await write(adminClient, admin.key, 'The field as of today.', { territory: MAP }, [`#${lab}`]);
    expect(posted.error).toBe('');
    expect(posted.text).toContain('Map: "A synthetic field" (field-map), 3 places, 2 with a status.');
    // Clients that show only the structured result must still see it.
    expect(posted.structured.map).toContain('Map: "A synthetic field" (field-map), 3 places, 2 with a status.');
  });

  it('attaches notes to places that exist', async () => {
    expect((await write(memberClient, member.key, 'Lost', { place: 'field-map/nowhere' }, [`#${lab}`])).error).toMatch(/has no place "nowhere"/);
    expect((await write(memberClient, member.key, 'No place', { mark: 'finding' }, [`#${lab}`])).error).toMatch(/A mark needs a place/);
    const attached = await write(memberClient, member.key, 'Training on its own output did nothing.', { place: 'field-map/few-examples', mark: 'failed-attempt' }, [`#${lab}`]);
    expect(attached.error).toBe('');
    expect(attached.text).toContain('On the map: failed attempt at "Few-example adaptation" (field-map/few-examples)');
    expect(attached.structured.map).toContain('On the map: failed attempt at "Few-example adaptation"');
  });

  it('shows members the map through the tool and the API', async () => {
    const overviewResult = await memberClient.callTool({ name: 'router_map', arguments: { group_id: lab } });
    expect(overviewResult.structuredContent).toBeUndefined();
    const overview = text(overviewResult);
    expect(overview).toContain('  Few-example adaptation [emerging] · 1 failed attempt  (field-map/few-examples)');
    expect(overview).toContain('  Hidden errors [open gap]  (field-map/hidden-errors)');
    const detail = text(await adminClient.callTool({ name: 'router_map', arguments: { group_id: `#${lab}`, place: 'field-map/few-examples' } }));
    expect(detail).toContain(`@${member.handle}  failed attempt: "Training on its own output did nothing."`);

    const res = await api(`/api/channels/${lab}/map`, undefined, member.key);
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.viewer).toBe(member.handle);
    const place = body.maps[0].places.find((p: any) => p.id === 'few-examples');
    expect(place.marks).toHaveLength(1);
    expect(place.marks[0]).toMatchObject({ handle: member.handle, kind: 'failed-attempt', text: 'Training on its own output did nothing.' });
  });

  it('shows nothing to anyone outside the group', async () => {
    expect((await api(`/api/channels/${lab}/map`)).status).toBe(401);
    expect((await api(`/api/channels/${lab}/map`, undefined, outsider.key)).status).toBe(403);
    expect((await outsiderClient.callTool({ name: 'router_map', arguments: { group_id: lab } })).isError).toBe(true);
  });

  it('serves the map page with a strict content policy', async () => {
    const page = await api('/map');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(await page.text()).toContain('<script src="/map.js?v=1"></script>');
    expect((await api('/map.js')).status).toBe(200);
  });
});
