import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RouterEvent } from './events.js';
import type { MatrixHistoryMessage } from './platform/matrix.js';

const anthropicCreateMock = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: class Anthropic {
    messages = { create: anthropicCreateMock };
  },
}));

import {
  buildProvenanceContent,
  buildRoomSummary,
  firstWord,
  handleMention,
  hasSeenMessage,
  initializeRuntimeCursor,
  matrixBotSecretKey,
  matrixMessageLine,
  normalizeTag,
  relativeSinceMs,
  remember,
  rememberMessage,
  stripBotAddressing,
  type BridgeState,
} from './shape-matrix-bridge.js';

describe('Shape Matrix bridge helpers', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.MATRIX_ACCESS_TOKEN;
    delete process.env.MATRIX_BOT_HANDLE;
    delete process.env.MATRIX_BOT_SECRET_KEY;
    delete process.env.SHAPE_MATRIX_SUMMARY_WINDOW_MS;
    delete process.env.SHAPE_ROUTER_SECRET_KEY;
    delete process.env.SHAPE_ROUTER_BASE_URL;
    anthropicCreateMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('normalizes private Router tags without introducing invalid characters', () => {
    expect(normalizeTag(' #Shape Rotator! ')).toBe('shape-rotator');
    expect(normalizeTag('Matrix:Summary')).toBe('matrix:summary');
    expect(normalizeTag('---')).toBe('');
  });

  it('parses bridge commands and strips bot addressing', () => {
    process.env.MATRIX_BOT_HANDLE = 'router';
    expect(firstWord('/search router history')).toBe('search');
    expect(stripBotAddressing('@router search private notes')).toBe('search private notes');
    expect(stripBotAddressing('@alice:matrix.org @router help')).toBe('help');
    expect(stripBotAddressing('<@alice.smith:matrix.org> @router help')).toBe('help');

    process.env.MATRIX_BOT_HANDLE = 'router.bot';
    expect(stripBotAddressing('@router.bot search private notes')).toBe('search private notes');
  });

  it('prefers Matrix access-token mode over stale bot-secret env', () => {
    process.env.MATRIX_ACCESS_TOKEN = 'access-token';
    process.env.MATRIX_BOT_SECRET_KEY = 'stale-password-secret';
    expect(matrixBotSecretKey()).toBeUndefined();
  });

  it('parses summary windows from Matrix text', () => {
    expect(relativeSinceMs('summarize this room 15m')).toBe(15 * 60 * 1000);
    expect(relativeSinceMs('summarize this room 7d')).toBe(7 * 24 * 60 * 60 * 1000);
    expect(relativeSinceMs('summarize this week')).toBe(7 * 24 * 60 * 60 * 1000);
    process.env.SHAPE_MATRIX_SUMMARY_WINDOW_MS = '12345';
    expect(relativeSinceMs('summarize this room')).toBe(12345);
  });

  it('keeps a bounded duplicate-message memory for restart safety', () => {
    const state: BridgeState = { cursor: 0, initialized: true };
    expect(hasSeenMessage(state, '$a')).toBe(false);
    rememberMessage(state, '$a');
    expect(hasSeenMessage(state, '$a')).toBe(true);
    expect(remember(['a', 'b'], 'c', 2)).toEqual(['b', 'c']);
  });

  it('treats the event cursor as process-local after restart', () => {
    const state: BridgeState = {
      cursor: 100,
      initialized: true,
      handledMatrixMessageIds: ['$already-saved'],
    };

    const cursor = initializeRuntimeCursor(state, 0);

    expect(cursor).toBe(0);
    expect(state.cursor).toBe(0);
    expect(state.initialized).toBe(true);
    expect(state.handledMatrixMessageIds).toEqual(['$already-saved']);
  });

  it('renders Matrix provenance into saved private Router entries', () => {
    const event: RouterEvent = {
      id: 1,
      type: 'platform_mention',
      timestamp: 10,
      data: {
        platform: 'matrix',
        room_id: '!room:matrix.test',
        message_id: '$msg',
        sender_id: '@alice:matrix.test',
        sender_handle: 'alice',
        is_dm: false,
      },
    };

    const content = buildProvenanceContent(event, 'Decision: use private Router.');
    expect(content).toContain('Source: Matrix room');
    expect(content).toContain('Room ID: !room:matrix.test');
    expect(content).toContain('Matrix event: $msg');
    expect(content).toContain('Organizer: @alice');
    expect(content).toContain('Decision: use private Router.');
  });

  it('builds extractive room summaries when no Anthropic key is configured', async () => {
    const messages: MatrixHistoryMessage[] = [
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'We should save this in private Router.',
        timestamp: Date.parse('2026-05-16T12:00:00Z'),
        isDM: false,
      },
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@bob:matrix.test',
        senderHandle: 'bob',
        text: 'Agreed, and the public board should only get the digest.',
        timestamp: Date.parse('2026-05-16T12:05:00Z'),
        isDM: false,
      },
    ];

    expect(matrixMessageLine(messages[0])).toContain('@alice: We should save this');
    const built = await buildRoomSummary([...messages].reverse(), 60 * 60 * 1000);
    expect(built.summary).toContain('Captured 2 Matrix messages from 2 participants');
    expect(built.content).toContain('Source: Matrix room "Shape General"');
    expect(built.content).toContain('Participants: @alice, @bob');
    expect(built.content.indexOf('@alice')).toBeLessThan(built.content.indexOf('@bob'));
    expect(built.content).toContain('public board should only get the digest');
  });

  it('keeps source Matrix messages in room summaries when Anthropic summaries are enabled', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
    anthropicCreateMock.mockResolvedValue({
      content: [{ type: 'text', text: 'LLM summary intentionally omits the smoke phrase.' }],
    });

    const messages: MatrixHistoryMessage[] = [
      {
        roomId: '!room:matrix.test',
        roomName: 'Shape General',
        senderId: '@alice:matrix.test',
        senderHandle: 'alice',
        text: 'shape-matrix-live-smoke source phrase must stay auditable.',
        timestamp: Date.parse('2026-05-16T12:00:00Z'),
        isDM: false,
      },
    ];

    const built = await buildRoomSummary(messages, 60 * 60 * 1000);

    expect(built.summary).toContain('Summarized 1 Matrix messages');
    expect(built.content).toContain('## Summary');
    expect(built.content).toContain('LLM summary intentionally omits the smoke phrase.');
    expect(built.content).toContain('## Source Messages');
    expect(built.content).toContain('shape-matrix-live-smoke source phrase must stay auditable.');
  });

  it('handles Matrix save commands by writing private Router entries with provenance', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      fetchCalls.push({
        url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-save', summary: 'saved', tags: ['matrix-note', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const sent: any[] = [];
    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async (...args: any[]) => {
        sent.push(args);
        return '$reply';
      }),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('save we decided to use private Router'));

    expect(fetchCalls[0].url).toBe('https://shape.test/api/entries?key=shape-key');
    expect(fetchCalls[0].body.tags).toEqual(['matrix-note', 'shape-rotator', 'matrix']);
    expect(fetchCalls[0].body.content).toContain('Source: Matrix room');
    expect(fetchCalls[0].body.content).toContain('Room ID: !room:matrix.test');
    expect(fetchCalls[0].body.content).toContain('Organizer: @alice');
    expect(sent[0][1]).toContain('Saved to private Shape Router');
    expect(sent[0][1]).toContain('https://shape.test/entry?id=entry-save');
  });

  it('handles Matrix DM save commands without touching the public Router', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-dm', summary: 'saved', tags: ['matrix-note', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('save DM-only note for private Router', true));

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe('https://shape.test/api/entries?key=shape-key');
    expect(fetchCalls[0].body.content).toContain('Source: Matrix DM');
    expect(fetchCalls[0].body.content).toContain('DM-only note for private Router');
    expect(fetchCalls[0].url).not.toContain('router.teleport.computer');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved to private Shape Router'),
      expect.anything(),
    );
  });

  it('summarizes Matrix DMs with DM history enabled', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entry: { id: 'entry-dm-summary', summary: 'summary', tags: ['matrix-summary', 'shape-rotator', 'matrix'], publishAt: null },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => [
        {
          roomId: '!room:matrix.test',
          roomName: 'Router DM',
          senderId: '@alice:matrix.test',
          senderHandle: 'alice',
          text: 'This private DM context should stay in Shape Router.',
          timestamp: Date.parse('2026-05-16T12:00:00Z'),
          isDM: true,
        },
      ]),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('summarize this room 30m', true));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: ['!room:matrix.test'],
      includeDMs: true,
      viewerUserId: '@alice:matrix.test',
    }));
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved Matrix room context to private Shape Router'),
      expect.anything(),
    );
  });

  it('answers Matrix searches from private Router HTTP fallback when MCP is unavailable', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      entries: [
        { id: 'entry-search', summary: 'Private Router migration notes', content: 'Contains the migration fallback detail.', tags: ['shape-rotator', 'matrix'] },
        { id: 'entry-other', summary: 'Unrelated note', tags: ['misc'] },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const matrix = {
      maxMessageLength: 65536,
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('search fallback'));

    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Private Shape Router search results'),
      expect.objectContaining({ replyTo: '$mention' }),
    );
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('[entry-search] Private Router migration notes'),
      expect.anything(),
    );
  });

  it('handles Matrix room summaries by reading Matrix context and writing private Router entries', async () => {
    process.env.SHAPE_ROUTER_BASE_URL = 'https://shape.test';
    process.env.SHAPE_ROUTER_SECRET_KEY = 'shape-key';

    const fetchCalls: Array<{ url: string; body?: any }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
      fetchCalls.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(JSON.stringify({
        entry: { id: 'entry-summary', summary: 'summary', tags: ['matrix-summary', 'shape-rotator', 'matrix'], publishAt: null },
      }), { status: 201, headers: { 'Content-Type': 'application/json' } });
    }));

    const matrix = {
      maxMessageLength: 65536,
      queryRecentMessages: vi.fn(async () => [
        {
          roomId: '!room:matrix.test',
          roomName: 'Shape General',
          senderId: '@alice:matrix.test',
          senderHandle: 'alice',
          text: 'Let us keep this private and broadcast only a digest.',
          timestamp: Date.parse('2026-05-16T12:00:00Z'),
          isDM: false,
        },
      ]),
      sendMessage: vi.fn(async () => '$reply'),
    };

    await handleMention(matrix as any, null, matrixMentionEvent('summarize this room 1h'));

    expect(matrix.queryRecentMessages).toHaveBeenCalledWith(expect.objectContaining({
      roomIds: ['!room:matrix.test'],
      includeDMs: false,
      viewerUserId: '@alice:matrix.test',
    }));
    expect(fetchCalls[0].body.tags).toEqual(['matrix-summary', 'shape-rotator', 'matrix']);
    expect(fetchCalls[0].body.content).toContain('Source: Matrix room "Shape General"');
    expect(fetchCalls[0].body.content).toContain('broadcast only a digest');
    expect(matrix.sendMessage).toHaveBeenCalledWith(
      '!room:matrix.test',
      expect.stringContaining('Saved Matrix room context to private Shape Router'),
      expect.anything(),
    );
  });
});

function matrixMentionEvent(text: string, isDM = false): RouterEvent {
  return {
    id: 1,
    type: 'platform_mention',
    timestamp: Date.now(),
    data: {
      platform: 'matrix',
      room_id: '!room:matrix.test',
      message_id: '$mention',
      sender_id: '@alice:matrix.test',
      sender_handle: 'alice',
      text,
      is_dm: isDM,
    },
  };
}
