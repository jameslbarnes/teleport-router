/**
 * Integration tests for Router MCP tools.
 *
 * Spawns the server as a child process on a random port,
 * connects via SSE as an MCP client, and exercises the agent tools.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { spawn, type ChildProcess } from 'child_process';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { generateSecretKey } from './identity.js';

const TEST_PORT = 9876 + Math.floor(Math.random() * 1000);
const MODERATOR_KEY = generateSecretKey();
const REGULAR_KEY = generateSecretKey();
// Unique per run to avoid Firestore collisions from previous runs
const MODERATOR_HANDLE = `mod${Date.now().toString(36).slice(-6)}`;

let serverProcess: ChildProcess;
let modClient: Client;
let modTransport: SSEClientTransport;
let regularClient: Client;
let regularTransport: SSEClientTransport;

// Stand-in for the automated moderator service: HOLDs entries containing the marker.
const AUTO_HOLD_MARKER = '[auto-hold-test]';
let moderationServer: Server;

async function callTool(client: Client, name: string, args: Record<string, any> = {}): Promise<string> {
  const result = await client.callTool({ name, arguments: args });
  const textBlock = (result.content as any[])?.find((b: any) => b.type === 'text');
  return textBlock?.text || '';
}

async function waitForServer(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/entries`);
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server did not start within ${timeoutMs}ms`);
}

async function connectClient(port: number, secretKey: string): Promise<{ client: Client; transport: SSEClientTransport }> {
  const url = new URL(`http://localhost:${port}/mcp/sse?key=${secretKey}`);
  const transport = new SSEClientTransport(url);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

describe('MCP Tool Integration Tests', () => {
  beforeAll(async () => {
    moderationServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let entry = '';
        try { entry = JSON.parse(body).entry || ''; } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ verdict: entry.includes(AUTO_HOLD_MARKER) ? 'HOLD: flagged by the test moderator' : 'PASS' }));
      });
    });
    await new Promise<void>((resolve) => moderationServer.listen(0, '127.0.0.1', () => resolve()));
    const moderationPort = (moderationServer.address() as AddressInfo).port;

    serverProcess = spawn('npx', ['tsx', 'src/http.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(TEST_PORT),
        STAGING_DELAY_MS: '3600000',
        STAGED_STORAGE: 'memory',
        MODERATOR_HANDLES: MODERATOR_HANDLE,
        MODERATOR_URL: `http://127.0.0.1:${moderationPort}`,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    serverProcess.stderr?.on('data', (data) => {
      const line = data.toString().trim();
      if (line && !line.includes('ExperimentalWarning') && !line.includes('Unauthorized')) {
        console.error(`[server:err] ${line}`);
      }
    });

    await waitForServer(TEST_PORT);

    // Register moderator identity
    const regRes = await fetch(`http://localhost:${TEST_PORT}/api/identity/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret_key: MODERATOR_KEY, handle: MODERATOR_HANDLE }),
    });
    if (!regRes.ok) {
      throw new Error(`Register failed: ${await regRes.text()}`);
    }

    // Connect clients
    const mod = await connectClient(TEST_PORT, MODERATOR_KEY);
    modClient = mod.client;
    modTransport = mod.transport;

    const reg = await connectClient(TEST_PORT, REGULAR_KEY);
    regularClient = reg.client;
    regularTransport = reg.transport;
  }, 30000);

  afterAll(async () => {
    try { await modTransport?.close(); } catch {}
    try { await regularTransport?.close(); } catch {}
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        serverProcess.on('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
    }
    await new Promise<void>((resolve) => moderationServer?.close(() => resolve()) ?? resolve());
  });

  // ── Tool Discovery ──────────────────────────────────────

  describe('Tool discovery', () => {
    it('moderator sees agent tools', async () => {
      const { tools } = await modClient.listTools();
      const names = tools.map(t => t.name);
      expect(names).toContain('router_poll_events');
      expect(names).toContain('router_review_staged');
      expect(names).toContain('router_hold_entry');
      expect(names).toContain('router_release_entry');
      expect(names).toContain('router_onboard_identity');
      expect(names).toContain('router_platform_send_dm');
      expect(names).toContain('router_post_daily_digest');
    });

    it('regular user does NOT see agent tools', async () => {
      const { tools } = await regularClient.listTools();
      const names = tools.map(t => t.name);
      expect(names).not.toContain('router_poll_events');
      expect(names).not.toContain('router_hold_entry');
      expect(names).not.toContain('router_onboard_identity');
      expect(names).not.toContain('router_platform_send_dm');
      expect(names).not.toContain('router_post_daily_digest');
    });

    it('both see standard tools', async () => {
      for (const client of [modClient, regularClient]) {
        const { tools } = await client.listTools();
        const names = tools.map(t => t.name);
        expect(names).toContain('router_write_entry');
        expect(names).toContain('router_search');
        expect(names).toContain('router_search_matrix');
      }
    });
  });

  describe('router_onboard_identity', () => {
    it('provisions a new handle and verified Matrix link for the agent', async () => {
      const handle = `ob${Date.now().toString(36).slice(-8)}`;
      const matrixId = `@${handle}:matrix.example.test`;

      const text = await callTool(modClient, 'router_onboard_identity', {
        platform: 'matrix',
        platform_user_id: matrixId,
        desired_handle: handle,
        display_name: 'Onboarding Test',
        source: 'matrix_space_join',
      });

      expect(text).toContain('ONBOARDING_PROVISIONED');
      expect(text).toContain(`handle: @${handle}`);
      expect(text).toContain(`platform_user_id: ${matrixId}`);
      expect(text).toContain('secret_key:');
      expect(text).toContain('/mcp/sse?key=');

      const key = text.match(/secret_key: (\S+)/)?.[1];
      expect(key).toBeTruthy();

      const profile = await fetch(`http://localhost:${TEST_PORT}/api/profile/${handle}?key=${key}`);
      expect(profile.ok).toBe(true);
      const body = await profile.json();
      expect(body.linkedAccounts).toEqual([
        expect.objectContaining({
          platform: 'matrix',
          platformUserId: matrixId,
          verified: true,
        }),
      ]);
    });

    it('does not return another secret key for an already linked Matrix user', async () => {
      const handle = `ob${Date.now().toString(36).slice(-8)}`;
      const matrixId = `@${handle}:matrix.example.test`;

      await callTool(modClient, 'router_onboard_identity', {
        platform: 'matrix',
        platform_user_id: matrixId,
        desired_handle: handle,
      });
      const second = await callTool(modClient, 'router_onboard_identity', {
        platform: 'matrix',
        platform_user_id: matrixId,
        desired_handle: `${handle}x`.slice(0, 15),
      });

      expect(second).toContain('ALREADY_ONBOARDED');
      expect(second).not.toContain('secret_key:');
    });
  });

  describe('router_post_daily_digest', () => {
    it('fails closed for moderators when Matrix is not connected', async () => {
      const text = await callTool(modClient, 'router_post_daily_digest', {
        date: '2026-01-01',
        text: 'Digest body.',
      });

      expect(text).toContain('Matrix platform not connected');
    });

    it('rejects non-moderator callers even if invoked directly', async () => {
      const text = await callTool(regularClient, 'router_post_daily_digest', {
        date: '2026-01-01',
        text: 'Digest body.',
      });

      expect(text).toContain('Only the Router agent can post the daily digest');
    });
  });

  // ── Event Queue ──────────────────────────────────────────

  describe('router_poll_events', () => {
    it('returns no events initially', async () => {
      const result = await modClient.callTool({ name: 'router_poll_events', arguments: { cursor: 0 } });
      const textBlock = (result.content as any[])?.find((b: any) => b.type === 'text');
      const text = textBlock?.text || '';
      expect(text).toContain('No new events');
      expect(result.structuredContent).toMatchObject({
        events: [],
        latest_cursor: 0,
        next_cursor: 0,
      });
    });

    it('sees entry_staged after write', async () => {
      await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Event polling test entry',
      });
      const text = await callTool(modClient, 'router_poll_events', { cursor: 0 });
      expect(text).toContain('entry_staged');
      // Content should NOT be in events (privacy)
      expect(text).not.toContain('Event polling test');
    });

    it('cursor-based pagination works', async () => {
      const first = await callTool(modClient, 'router_poll_events', { cursor: 0 });
      const cursor = parseInt(first.match(/cursor (\d+)/)![1]);

      await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Cursor pagination test',
      });

      // Should see a new event with higher cursor
      const second = await callTool(modClient, 'router_poll_events', { cursor });
      expect(second).toContain('entry_staged');
    });
  });

  // ── Content Moderation ──────────────────────────────────

  describe('router_review_staged', () => {
    it("lists the caller's own waiting entries", async () => {
      const wr = await callTool(modClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Moderator own waiting entry',
      });
      const ownId = wr.match(/Entry ID: (\S+)/)![1];

      const text = await callTool(modClient, 'router_review_staged', {});
      expect(text).toContain('pending entries');
      expect(text).toContain('publishes in');
      expect(text).toContain(ownId);
    });

    it("does not show moderators other people's ordinary waiting entries", async () => {
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Regular waiting entry that review must not reveal',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      const text = await callTool(modClient, 'router_review_staged', {});
      expect(text).not.toContain(entryId);
      expect(text).not.toContain('must not reveal');
    });
  });

  describe('router_hold_entry', () => {
    let heldEntryId: string;

    it('holds a staged entry', async () => {
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'I hate my cofounder, they never shut up',
      });
      heldEntryId = wr.match(/Entry ID: (\S+)/)![1];

      const hold = await callTool(modClient, 'router_hold_entry', {
        entry_id: heldEntryId,
        reason: 'Interpersonal complaint.',
      });
      expect(hold).toContain('held indefinitely');
    });

    it('shows HELD in review', async () => {
      const text = await callTool(modClient, 'router_review_staged', {});
      expect(text).toContain('HELD (indefinite)');
      expect(text).toContain(heldEntryId);
    });

    it('rejects non-existent entry', async () => {
      const text = await callTool(modClient, 'router_hold_entry', { entry_id: 'fake-id' });
      expect(text).toContain('not in the staging buffer');
    });

    it('requires entry_id', async () => {
      const text = await callTool(modClient, 'router_hold_entry', {});
      expect(text).toContain('Entry ID is required');
    });
  });

  describe('router_release_entry', () => {
    it('allows self-publish for an ordinary pending entry', async () => {
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Ordinary pending entry for self-publish test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      const res = await fetch(`http://localhost:${TEST_PORT}/api/entries/${entryId}/publish?key=${REGULAR_KEY}`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        success: true,
      });
    });

    it('allows self-publish for a moderator-held entry', async () => {
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Held pending entry for self-publish test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      await callTool(modClient, 'router_hold_entry', { entry_id: entryId, reason: 'test' });

      const res = await fetch(`http://localhost:${TEST_PORT}/api/entries/${entryId}/publish?key=${REGULAR_KEY}`, {
        method: 'POST',
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({
        success: true,
      });
    });

    it('releases a held entry', async () => {
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'Safe entry for release test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      await callTool(modClient, 'router_hold_entry', { entry_id: entryId, reason: 'test' });
      const release = await callTool(modClient, 'router_release_entry', { entry_id: entryId });
      expect(release).toContain('back on its original schedule');

      // No longer held, and not the moderator's own: gone from their review
      const review = await callTool(modClient, 'router_review_staged', {});
      expect(review).not.toContain(entryId);
    });

    it('rejects non-existent entry', async () => {
      const text = await callTool(modClient, 'router_release_entry', { entry_id: 'fake-id' });
      expect(text).toContain('not in the staging buffer');
    });
  });

  // ── Full Lifecycle ──────────────────────────────────────

  describe('Full moderation lifecycle', () => {
    it('write → stage event → hidden from review → hold → review → release', async () => {
      // 1. Write
      const wr = await callTool(regularClient, 'router_write_entry', {
        sensitivity_check: 'No sensitive content. I, Claude, certify I am completing this check.',
        client: 'code',
        entry: 'TEE attestation observation for lifecycle test',
      });
      const entryId = wr.match(/Entry ID: (\S+)/)![1];

      // 2. Poll → entry_staged
      const events = await callTool(modClient, 'router_poll_events', { cursor: 0, limit: 100 });
      expect(events).toContain('entry_staged');
      expect(events).not.toContain('TEE attestation'); // content not leaked in events

      // 3. Review: an ordinary waiting entry stays private to its author
      const staged = await callTool(modClient, 'router_review_staged', {});
      expect(staged).not.toContain(entryId);

      // 4. Hold: held entries are what moderators review
      await callTool(modClient, 'router_hold_entry', { entry_id: entryId, reason: 'review' });
      const held = await callTool(modClient, 'router_review_staged', {});
      expect(held).toContain('HELD');
      expect(held).toContain(entryId);

      // 5. Release: back on the original schedule, not published early
      const release = await callTool(modClient, 'router_release_entry', { entry_id: entryId });
      expect(release).toContain('back on its original schedule');

      // 6. No longer held, so gone from the moderator's review
      const final = await callTool(modClient, 'router_review_staged', {});
      expect(final).not.toContain(entryId);
    });
  });

  // ── Waiting posts stay private ──────────────────────────

  describe('Waiting posts stay private to their author', () => {
    const SENSITIVITY = 'No sensitive content. I, Claude, certify I am completing this check.';
    // A valid key that was never registered: no handle, like REGULAR_KEY.
    // Guards against "no handle" === "no handle" counting as authorship.
    const OTHER_KEY = generateSecretKey();
    const RECIPIENT_KEY = generateSecretKey();
    const RECIPIENT_HANDLE = `rcpt${Date.now().toString(36).slice(-6)}`;
    const base = () => `http://localhost:${TEST_PORT}`;
    let otherClient: Client;
    let otherTransport: SSEClientTransport;

    async function write(client: Client, entry: string, extra: Record<string, any> = {}): Promise<string> {
      const text = await callTool(client, 'router_write_entry', { sensitivity_check: SENSITIVITY, client: 'code', entry, ...extra });
      const id = text.match(/Entry ID: (\S+)/)?.[1];
      if (!id) throw new Error(`write failed: ${text}`);
      return id;
    }

    async function publish(entryId: string, key: string): Promise<string> {
      const res = await fetch(`${base()}/api/entries/${entryId}/publish?key=${key}`, { method: 'POST' });
      expect(res.status).toBe(200);
      return (await res.json()).entry.id;
    }

    beforeAll(async () => {
      const other = await connectClient(TEST_PORT, OTHER_KEY);
      otherClient = other.client;
      otherTransport = other.transport;

      const reg = await fetch(`${base()}/api/identity/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret_key: RECIPIENT_KEY, handle: RECIPIENT_HANDLE }),
      });
      if (!reg.ok) throw new Error(`Register failed: ${await reg.text()}`);
    });

    afterAll(async () => {
      try { await otherTransport?.close(); } catch {}
    });

    it('post page: hidden from anonymous viewers, other keys and moderators; shown to the author', async () => {
      const entryId = await write(regularClient, 'Waiting permalink privacy check');

      expect((await fetch(`${base()}/api/entry/${entryId}`)).status).toBe(404);
      expect((await fetch(`${base()}/api/entry/${entryId}?key=${OTHER_KEY}`)).status).toBe(404);
      expect((await fetch(`${base()}/api/entry/${entryId}?key=${MODERATOR_KEY}`)).status).toBe(404);

      const own = await fetch(`${base()}/api/entry/${entryId}?key=${REGULAR_KEY}`);
      expect(own.status).toBe(200);
      expect((await own.json()).content).toBe('Waiting permalink privacy check');
    });

    it('post page: visible to everyone once it publishes', async () => {
      const entryId = await write(regularClient, 'Published permalink check');
      const publishedId = await publish(entryId, REGULAR_KEY);

      const res = await fetch(`${base()}/api/entry/${publishedId}`);
      expect(res.status).toBe(200);
      expect((await res.json()).content).toBe('Published permalink check');
    });

    it('router_get_entry: only the author can open a waiting post', async () => {
      const entryId = await write(regularClient, 'Waiting get_entry privacy check');

      expect(await callTool(modClient, 'router_get_entry', { entry_id: entryId })).toContain('Entry not found');
      expect(await callTool(otherClient, 'router_get_entry', { entry_id: entryId })).toContain('Entry not found');
      expect(await callTool(regularClient, 'router_get_entry', { entry_id: entryId })).toContain('Waiting get_entry privacy check');
    });

    it('replies: a waiting reply is shown only to its author', async () => {
      const parentId = await publish(await write(regularClient, 'Published parent for reply privacy'), REGULAR_KEY);
      const replyId = await write(modClient, 'Waiting reply privacy check', { in_reply_to: parentId });

      const anon = await (await fetch(`${base()}/api/entry/${parentId}/replies`)).json();
      expect(anon.replies.map((r: any) => r.id)).not.toContain(replyId);
      const other = await (await fetch(`${base()}/api/entry/${parentId}/replies?key=${OTHER_KEY}`)).json();
      expect(other.replies.map((r: any) => r.id)).not.toContain(replyId);

      const own = await (await fetch(`${base()}/api/entry/${parentId}/replies?key=${MODERATOR_KEY}`)).json();
      expect(own.replies.map((r: any) => r.id)).toContain(replyId);
    });

    it("replies: a waiting parent's thread is not found for anyone but its author", async () => {
      const parentId = await write(regularClient, 'Waiting parent for thread privacy');

      expect((await fetch(`${base()}/api/entry/${parentId}/replies`)).status).toBe(404);
      expect((await fetch(`${base()}/api/entry/${parentId}/replies?key=${OTHER_KEY}`)).status).toBe(404);
      expect((await fetch(`${base()}/api/entry/${parentId}/replies?key=${REGULAR_KEY}`)).status).toBe(200);
    });

    it('inbox: an addressed post reaches the recipient only when it publishes', async () => {
      const entryId = await write(modClient, 'Addressed waiting entry for inbox privacy', { to: [`@${RECIPIENT_HANDLE}`] });
      const inbox = async () => (await (await fetch(`${base()}/api/inbox?key=${RECIPIENT_KEY}`)).json()).received
        .map((e: any) => e.content);

      expect(await inbox()).not.toContain('Addressed waiting entry for inbox privacy');

      await publish(entryId, MODERATOR_KEY);
      expect(await inbox()).toContain('Addressed waiting entry for inbox privacy');
    });

    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await fetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
      return res.json();
    };
    const channelFeed = async (channelId: string, key?: string) => {
      const res = await fetch(`${base()}/api/channels/${channelId}/entries${key ? `?secret_key=${key}` : ''}`);
      expect(res.status).toBe(200);
      return ((await res.json()).entries as any[]).map(e => e.content);
    };

    it('channel feed (open channel): a waiting post is hidden from everyone but its author', async () => {
      const channelId = `lk-open-${Date.now().toString(36).slice(-6)}`;
      await post('/api/channels', { secret_key: MODERATOR_KEY, id: channelId, name: 'Open privacy check', join_rule: 'open' });
      const entryId = await write(modClient, 'Waiting open-channel post', { to: [`#${channelId}`, `@${RECIPIENT_HANDLE}`] });

      expect(await channelFeed(channelId)).not.toContain('Waiting open-channel post');
      expect(await channelFeed(channelId, OTHER_KEY)).not.toContain('Waiting open-channel post');
      expect(await channelFeed(channelId, RECIPIENT_KEY)).not.toContain('Waiting open-channel post');
      expect(await channelFeed(channelId, MODERATOR_KEY)).toContain('Waiting open-channel post');

      await publish(entryId, MODERATOR_KEY);
      expect(await channelFeed(channelId)).toContain('Waiting open-channel post');
    });

    it('channel feed (invite-only channel): members see a waiting post only once it publishes', async () => {
      const channelId = `lk-inv-${Date.now().toString(36).slice(-6)}`;
      await post('/api/channels', { secret_key: MODERATOR_KEY, id: channelId, name: 'Invite privacy check', join_rule: 'invite' });
      const { token } = await post(`/api/channels/${channelId}/invite`, { secret_key: MODERATOR_KEY });
      await post(`/api/channels/${channelId}/join`, { secret_key: RECIPIENT_KEY, invite_token: token });
      const entryId = await write(modClient, 'Waiting invite-channel post', { to: [`#${channelId}`] });

      expect(await channelFeed(channelId, RECIPIENT_KEY)).not.toContain('Waiting invite-channel post');
      expect(await channelFeed(channelId, MODERATOR_KEY)).toContain('Waiting invite-channel post');

      await publish(entryId, MODERATOR_KEY);
      expect(await channelFeed(channelId, RECIPIENT_KEY)).toContain('Waiting invite-channel post');
    });

    it('review: a manual hold does not reveal the content to moderators', async () => {
      const entryId = await write(regularClient, 'Manually held text that review must hide');
      expect(await callTool(modClient, 'router_hold_entry', { entry_id: entryId, reason: 'test' })).toContain('held indefinitely');

      const review = await callTool(modClient, 'router_review_staged', {});
      expect(review).toContain(entryId);
      expect(review).toContain('content hidden');
      expect(review).not.toContain('review must hide');
    });

    it('review: moderators can read an automated hold, and releasing it keeps the author window', async () => {
      const entryId = await write(regularClient, `${AUTO_HOLD_MARKER} automated hold check`);

      const review = await callTool(modClient, 'router_review_staged', {});
      expect(review).toContain(entryId);
      expect(review).toContain('automated hold check');

      expect(await callTool(modClient, 'router_release_entry', { entry_id: entryId })).toContain('back on its original schedule');
      expect((await fetch(`${base()}/api/entry/${entryId}`)).status).toBe(404); // still waiting
      expect(await callTool(regularClient, 'router_delete_entry', { entry_id: entryId })).toContain('will not be published');
    });

    it("moderators cannot release someone else's ordinary waiting post", async () => {
      const entryId = await write(regularClient, 'Waiting entry a moderator must not force-publish');

      expect(await callTool(modClient, 'router_release_entry', { entry_id: entryId })).toContain('not held');
      expect((await fetch(`${base()}/api/entry/${entryId}`)).status).toBe(404); // still waiting
      expect(await callTool(regularClient, 'router_get_entry', { entry_id: entryId })).toContain('must not force-publish');
    });
  });
});
