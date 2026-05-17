import { existsSync, unlinkSync } from 'fs';
import { ClientEvent, EventType, KnownMembership, RelationType, RoomEvent, RoomMemberEvent } from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatrixPlatform, ROUTER_CHANNEL_STATE, ROUTER_SPARK_EVENT, buildRouterDiscoBallAvatarPng, deriveMatrixBotPassword, isMatrixMention } from './matrix.js';
import { getEventsSince, resetEvents } from '../events.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isMatrixMention', () => {
  const botUserId = '@router:mtrx.shaperotator.xyz';
  const botHandle = 'router';

  it('treats DMs as mentions', () => {
    expect(
      isMatrixMention({
        isDM: true,
        text: 'hello',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects structured Matrix mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'hey router',
        content: {
          'm.mentions': {
            user_ids: [botUserId],
          },
        },
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects formatted-body Matrix mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'hey router',
        content: {
          formatted_body: '<a href="https://matrix.to/#/%40router%3Amtrx.shaperotator.xyz">router</a>',
        },
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('detects plain-text @mentions', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: '@router can you weigh in?',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(true);
  });

  it('ignores ordinary messages without a mention', () => {
    expect(
      isMatrixMention({
        isDM: false,
        text: 'does anyone have thoughts?',
        content: {},
        botUserId,
        botHandle,
      }),
    ).toBe(false);
  });
});

describe('Router disco ball avatar', () => {
  it('builds a PNG avatar for the Matrix bot profile', () => {
    const png = buildRouterDiscoBallAvatarPng();
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.length).toBeGreaterThan(1024);
  });
});

describe('MatrixPlatform auth mode selection', () => {
  it('uses access-token mode when both access token and bot secret are configured', () => {
    expect(deriveMatrixBotPassword({
      serverName: 'mtrx.example.test',
      botSecretKey: 'stale-password-secret',
      accessToken: 'provisioned-access-token',
    })).toBeNull();
  });

  it('derives a password only when no access token is configured', () => {
    expect(deriveMatrixBotPassword({
      serverName: 'mtrx.example.test',
      botSecretKey: 'password-secret',
    })).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('MatrixPlatform identity resolution', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('resolves linked Matrix user IDs before falling back to the local convention', async () => {
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) =>
        name === 'matrix' && handle === 'james' ? '@specularist:matrix.org' : null,
    });

    await expect(platform.resolvePlatformId('james')).resolves.toBe('@specularist:matrix.org');
    await expect(platform.resolvePlatformId('alice')).resolves.toBe('@alice:mtrx.example.test');
  });

  it('resolves Router handles from linked Matrix accounts before parsing MXIDs', async () => {
    const platform = createPlatform({
      resolveLinkedRouterHandle: async (name, userId) =>
        name === 'matrix' && userId === '@specularist:matrix.org' ? 'james' : null,
    });

    await expect(platform.resolveRouterHandle('@specularist:matrix.org')).resolves.toBe('james');
    await expect(platform.resolveRouterHandle('@alice:mtrx.example.test')).resolves.toBe('alice');
  });

  it('validates externally provisioned Matrix access tokens through whoami', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      user_id: '@shape-router-bridge:mtrx.example.test',
      device_id: 'DEVICE',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const platform = createPlatform({
      botSecretKey: undefined,
      accessToken: 'access-token',
      botHandle: 'shape-router-bridge',
    });

    await expect((platform as any).credentialsFromAccessToken('access-token')).resolves.toEqual({
      access_token: 'access-token',
      user_id: '@shape-router-bridge:mtrx.example.test',
      device_id: 'DEVICE',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mtrx.example.test/_matrix/client/v3/account/whoami',
      { headers: { Authorization: 'Bearer access-token' } },
    );
    vi.unstubAllGlobals();
  });
});

describe('MatrixPlatform channel rooms', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('keeps existing alias-backed rooms out of the public Matrix room directory', async () => {
    const getRoomIdForAlias = vi.fn().mockResolvedValue({ room_id: '!books:mtrx.example.test' });
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform();

    (platform as any).client = {
      getRoomIdForAlias,
      setRoomDirectoryVisibility,
      sendStateEvent,
    };

    await expect(platform.ensureChannelRoom('books', 'Books')).resolves.toBe('!books:mtrx.example.test');
    expect(getRoomIdForAlias).toHaveBeenCalledWith('#books:mtrx.example.test');
    expect(setRoomDirectoryVisibility).toHaveBeenCalledWith('!books:mtrx.example.test', 'private');
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!books:mtrx.example.test',
      'm.room.join_rules',
      { join_rule: 'invite' },
      '',
    );
  });

  it('attaches existing alias-backed rooms to the configured Matrix space', async () => {
    const getRoomIdForAlias = vi.fn().mockResolvedValue({ room_id: '!books:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getRoomIdForAlias,
      joinRoom,
      setRoomDirectoryVisibility,
      sendStateEvent,
    };

    await expect(platform.ensureChannelRoom('books', 'Books')).resolves.toBe('!books:mtrx.example.test');
    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!books:mtrx.example.test',
      'm.room.join_rules',
      {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: '!space:mtrx.example.test' }],
      },
      '',
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!books:mtrx.example.test',
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!books:mtrx.example.test',
      'm.space.parent',
      { via: ['mtrx.example.test'], canonical: true },
      '!space:mtrx.example.test',
    );
  });

  it('creates new channel rooms as private restricted rooms in the configured Matrix space', async () => {
    const getRoomIdForAlias = vi.fn().mockRejectedValue(new Error('not found'));
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!books-created:mtrx.example.test' });
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getRoomIdForAlias,
      createRoom,
      setRoomDirectoryVisibility,
      sendStateEvent,
      joinRoom: vi.fn().mockResolvedValue({}),
    };

    await expect(platform.ensureChannelRoom('books', 'Books', 'Book discussion')).resolves.toBe('!books-created:mtrx.example.test');
    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Books',
      topic: 'Book discussion',
      room_alias_name: 'books',
      visibility: 'private',
      preset: 'private_chat',
      initial_state: expect.arrayContaining([
        expect.objectContaining({
          type: 'm.room.join_rules',
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: '!space:mtrx.example.test' }],
          },
        }),
        expect.objectContaining({
          type: 'm.room.guest_access',
          content: { guest_access: 'forbidden' },
        }),
      ]),
    }));
    expect(setRoomDirectoryVisibility).toHaveBeenCalledWith('!books-created:mtrx.example.test', 'private');
  });

  it('attaches newly created rooms to the configured Matrix space', async () => {
    const getRoomIdForAlias = vi.fn().mockRejectedValue(new Error('not found'));
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!books-created:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const setRoomDirectoryVisibility = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getRoomIdForAlias,
      createRoom,
      joinRoom,
      setRoomDirectoryVisibility,
      sendStateEvent,
    };

    await expect(platform.ensureChannelRoom('books', 'Books', 'Book discussion')).resolves.toBe('!books-created:mtrx.example.test');
    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!books-created:mtrx.example.test',
    );
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!books-created:mtrx.example.test',
      'm.space.parent',
      { via: ['mtrx.example.test'], canonical: true },
      '!space:mtrx.example.test',
    );
  });

  it('attaches private created rooms to the configured Matrix space when requested', async () => {
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!spark-room:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$wake' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      createRoom,
      joinRoom,
      sendStateEvent,
      sendMessage,
    };

    await expect(platform.createRoom('@alice ↔ @bob', {
      type: 'group',
      invite: ['alice', 'bob'],
      topic: 'Test spark',
      encrypted: true,
      attachToSpace: true,
    })).resolves.toEqual(expect.objectContaining({
      id: '!spark-room:mtrx.example.test',
    }));

    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      1,
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!spark-room:mtrx.example.test',
    );
    expect(sendStateEvent).toHaveBeenNthCalledWith(
      2,
      '!spark-room:mtrx.example.test',
      'm.space.parent',
      { via: ['mtrx.example.test'], canonical: true },
      '!space:mtrx.example.test',
    );
  });

  it('creates generic channel rooms as restricted children of the configured Matrix space', async () => {
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!channel-room:mtrx.example.test' });
    const joinRoom = vi.fn().mockResolvedValue({});
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      createRoom,
      joinRoom,
      sendStateEvent,
    };

    await expect(platform.createRoom('Digest', {
      type: 'channel',
      encrypted: false,
    })).resolves.toEqual(expect.objectContaining({
      id: '!channel-room:mtrx.example.test',
    }));

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Digest',
      preset: 'private_chat',
      initial_state: expect.arrayContaining([
        expect.objectContaining({
          type: 'm.room.join_rules',
          content: {
            join_rule: 'restricted',
            allow: [{ type: 'm.room_membership', room_id: '!space:mtrx.example.test' }],
          },
        }),
      ]),
    }));
    expect(joinRoom).toHaveBeenCalledWith('!space:mtrx.example.test');
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!space:mtrx.example.test',
      'm.space.child',
      { via: ['mtrx.example.test'], suggested: true },
      '!channel-room:mtrx.example.test',
    );
  });
});

describe('MatrixPlatform DMs', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  const fakeRoom = (roomId: string, opts: {
    members?: string[];
    membership?: KnownMembership;
    explicitName?: string;
    lastActive?: number;
    routerChannel?: boolean;
    routerSpark?: { sourceHandle: string; targetHandle: string };
  } = {}) => {
    const members = opts.members || ['@router:mtrx.example.test', '@james:matrix.org'];
    return {
      roomId,
      getMyMembership: () => opts.membership || KnownMembership.Join,
      getJoinedMembers: () => members.map(userId => ({ userId })),
      getJoinedMemberCount: () => members.length,
      getMember: (userId: string) => members.includes(userId)
        ? { userId, membership: KnownMembership.Join }
        : null,
      getLastActiveTimestamp: () => opts.lastActive || 0,
      currentState: {
        getStateEvents: (type: string) => {
          if (type === EventType.RoomName && opts.explicitName) {
            return { getContent: () => ({ name: opts.explicitName }) };
          }
          if (type === ROUTER_CHANNEL_STATE && opts.routerChannel) {
            return { getContent: () => ({ channel_id: 'fun-facts' }) };
          }
          if (type === ROUTER_SPARK_EVENT && opts.routerSpark) {
            return { getContent: () => ({
              source_handle: opts.routerSpark?.sourceHandle,
              target_handle: opts.routerSpark?.targetHandle,
            }) };
          }
          return null;
        },
      },
    };
  };

  it('passes Matrix user IDs through when creating direct rooms', async () => {
    const createRoom = vi.fn().mockResolvedValue({ room_id: '!direct-created:mtrx.example.test' });
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$wake' });
    const platform = createPlatform();

    (platform as any).client = {
      createRoom,
      sendMessage,
    };

    await expect(platform.createRoom('', {
      type: 'dm',
      invite: ['@james:matrix.org'],
      encrypted: true,
    })).resolves.toEqual(expect.objectContaining({
      id: '!direct-created:mtrx.example.test',
    }));

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      invite: ['@james:matrix.org'],
      is_direct: true,
      preset: 'trusted_private_chat',
    }));
    expect(sendMessage).toHaveBeenCalledWith('!direct-created:mtrx.example.test', expect.objectContaining({
      body: 'Connected.',
    }));
  });

  it('reuses rooms explicitly tracked in m.direct', async () => {
    const clientSendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const getAccountData = vi.fn().mockReturnValue({
      getContent: () => ({
        '@james:matrix.org': ['!direct-room:mtrx.example.test'],
      }),
    });
    const getRoom = vi.fn().mockReturnValue({
      roomId: '!direct-room:mtrx.example.test',
      getMyMembership: () => KnownMembership.Join,
    });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });

    (platform as any).client = {
      getAccountData,
      getRoom,
      sendMessage: clientSendMessage,
    };

    await expect(platform.sendDM('@james:matrix.org', 'digest check')).resolves.toBe('$event');
    expect(getRoom).toHaveBeenCalledWith('!direct-room:mtrx.example.test');
    expect(clientSendMessage).toHaveBeenCalledWith('!direct-room:mtrx.example.test', expect.objectContaining({
      body: 'digest check',
    }));
  });

  it('prefers an existing user-created DM over the bot-created empty direct room', async () => {
    const clientSendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const setAccountData = vi.fn().mockResolvedValue({});
    const platform = createPlatform();

    (platform as any).client = {
      getAccountData: vi.fn().mockReturnValue({
        getContent: () => ({
          '@james:matrix.org': ['!empty-room:mtrx.example.test'],
        }),
      }),
      getRooms: vi.fn().mockReturnValue([
        fakeRoom('!empty-room:mtrx.example.test', { lastActive: 200 }),
        fakeRoom('!router-dm:mtrx.example.test', { lastActive: 100 }),
      ]),
      getRoom: vi.fn(),
      setAccountData,
      sendMessage: clientSendMessage,
    };

    await expect(platform.sendDM('@james:matrix.org', 'digest check')).resolves.toBe('$event');
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      '@james:matrix.org': ['!router-dm:mtrx.example.test', '!empty-room:mtrx.example.test'],
    });
    expect(clientSendMessage).toHaveBeenCalledWith('!router-dm:mtrx.example.test', expect.objectContaining({
      body: 'digest check',
    }));
  });

  it('creates a fresh DM instead of reusing arbitrary two-person rooms', async () => {
    const clientSendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const setAccountData = vi.fn().mockResolvedValue({});
    const platform = createPlatform();

    (platform as any).client = {
      getAccountData: vi.fn().mockReturnValue(undefined),
      getRooms: vi.fn().mockReturnValue([
        fakeRoom('!fun-facts:mtrx.example.test', {
          explicitName: 'fun-facts',
          routerChannel: true,
        }),
      ]),
      getRoom: vi.fn(),
      setAccountData,
      sendMessage: clientSendMessage,
    };

    vi.spyOn(platform, 'createRoom').mockResolvedValue({
      id: '!fresh-dm:mtrx.example.test',
      type: 'dm',
      platform: 'matrix',
    });
    vi.spyOn(platform, 'inviteToRoom').mockResolvedValue();

    await expect(platform.sendDM('@james:matrix.org', 'digest check')).resolves.toBe('$event');
    expect(platform.createRoom).toHaveBeenCalledWith('', expect.objectContaining({
      type: 'dm',
      invite: ['@james:matrix.org'],
      encrypted: true,
    }));
    expect(platform.inviteToRoom).not.toHaveBeenCalled();
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      '@james:matrix.org': ['!fresh-dm:mtrx.example.test'],
    });
    expect(clientSendMessage).toHaveBeenCalledWith('!fresh-dm:mtrx.example.test', expect.objectContaining({
      body: 'digest check',
    }));
  });

  it('ignores stale m.direct room ids when the bot is no longer joined', async () => {
    const clientSendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const setAccountData = vi.fn().mockResolvedValue({});
    const platform = createPlatform();

    (platform as any).client = {
      getAccountData: vi.fn().mockReturnValue({
        getContent: () => ({
          '@james:matrix.org': ['!stale-dm:mtrx.example.test'],
        }),
      }),
      getRoom: vi.fn().mockReturnValue({
        roomId: '!stale-dm:mtrx.example.test',
        getMyMembership: () => KnownMembership.Leave,
      }),
      setAccountData,
      sendMessage: clientSendMessage,
    };

    vi.spyOn(platform, 'createRoom').mockResolvedValue({
      id: '!replacement-dm:mtrx.example.test',
      type: 'dm',
      platform: 'matrix',
    });
    vi.spyOn(platform, 'inviteToRoom').mockResolvedValue();

    await expect(platform.sendDM('@james:matrix.org', 'digest check')).resolves.toBe('$event');
    expect(platform.createRoom).toHaveBeenCalledTimes(1);
    expect(platform.createRoom).toHaveBeenCalledWith('', expect.objectContaining({
      type: 'dm',
      invite: ['@james:matrix.org'],
      encrypted: true,
    }));
    expect(platform.inviteToRoom).not.toHaveBeenCalled();
    expect(setAccountData).toHaveBeenCalledWith(EventType.Direct, {
      '@james:matrix.org': ['!replacement-dm:mtrx.example.test', '!stale-dm:mtrx.example.test'],
    });
    expect(clientSendMessage).toHaveBeenCalledWith('!replacement-dm:mtrx.example.test', expect.objectContaining({
      body: 'digest check',
    }));
  });

  it('does not treat Router-managed spark rooms as DMs while an invite is pending', () => {
    const platform = createPlatform();
    const room = fakeRoom('!spark:mtrx.example.test', {
      members: ['@router:mtrx.example.test', '@socrates1024:matrix.org'],
      routerSpark: { sourceHandle: 'socrates1024', targetHandle: 'ggg' },
    });

    (platform as any).client = {
      getAccountData: vi.fn().mockReturnValue(undefined),
    };

    expect((platform as any).isDirectMessageRoom('@socrates1024:matrix.org', '!spark:mtrx.example.test', room)).toBe(false);
  });

  it('joins rooms that were already invited during initial sync', async () => {
    vi.useFakeTimers();
    try {
      const joinRoom = vi.fn().mockResolvedValue({});
      const platform = createPlatform();
      (platform as any).client = {
        getRooms: vi.fn().mockReturnValue([
          fakeRoom('!invited:mtrx.example.test', { membership: KnownMembership.Invite }),
          fakeRoom('!joined:mtrx.example.test', { membership: KnownMembership.Join }),
        ]),
        joinRoom,
      };

      await (platform as any).joinPendingInvitedRooms('test');

      expect(joinRoom).toHaveBeenCalledTimes(1);
      expect(joinRoom).toHaveBeenCalledWith('!invited:mtrx.example.test');
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-joins invite rooms from my-membership updates', async () => {
    vi.useFakeTimers();
    try {
      const handlers = new Map<string, (...args: any[]) => void>();
      const joinRoom = vi.fn().mockResolvedValue({});
      const platform = createPlatform();
      (platform as any).client = {
        on: vi.fn((eventName: string, handler: (...args: any[]) => void) => {
          handlers.set(eventName, handler);
        }),
        joinRoom,
      };

      (platform as any).setupEventListeners();
      handlers.get(RoomEvent.MyMembership)?.(
        fakeRoom('!direct-invite:mtrx.example.test', { membership: KnownMembership.Invite }),
        KnownMembership.Invite,
      );

      expect(joinRoom).toHaveBeenCalledWith('!direct-invite:mtrx.example.test');
      expect((platform as any).client.on).toHaveBeenCalledWith(ClientEvent.Room, expect.any(Function));
      await Promise.resolve();
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates repeated invite join attempts for the same room', async () => {
    vi.useFakeTimers();
    try {
      const joinRoom = vi.fn().mockResolvedValue({});
      const platform = createPlatform();
      (platform as any).client = { joinRoom };

      await (platform as any).joinInvitedRoom('!dupe:mtrx.example.test', 'first');
      await (platform as any).joinInvitedRoom('!dupe:mtrx.example.test', 'second');

      expect(joinRoom).toHaveBeenCalledTimes(1);
      vi.clearAllTimers();
    } finally {
      vi.useRealTimers();
    }
  });

  it('queues one onboarding event when a user joins the configured Matrix space', () => {
    resetEvents();
    const previousStatePath = process.env.MATRIX_ONBOARDING_STATE_PATH;
    const statePath = `/tmp/router-matrix-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    process.env.MATRIX_ONBOARDING_STATE_PATH = statePath;

    try {
      const handlers = new Map<any, (...args: any[]) => void>();
      const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });
      (platform as any).botUserId = '@router:mtrx.example.test';
      (platform as any).client = {
        on: vi.fn((eventName: any, handler: (...args: any[]) => void) => {
          handlers.set(eventName, handler);
        }),
      };

      (platform as any).setupEventListeners();
      const membershipHandler = handlers.get(RoomMemberEvent.Membership);

      membershipHandler?.(
        { getRoomId: () => '!space:mtrx.example.test' },
        {
          userId: '@alice:matrix.org',
          roomId: '!space:mtrx.example.test',
          membership: KnownMembership.Join,
          name: 'Alice',
        },
      );
      membershipHandler?.(
        { getRoomId: () => '!space:mtrx.example.test' },
        {
          userId: '@alice:matrix.org',
          roomId: '!space:mtrx.example.test',
          membership: KnownMembership.Join,
          name: 'Alice',
        },
      );

      const events = getEventsSince(0);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'platform_onboarding',
        data: {
          platform: 'matrix',
          platform_user_id: '@alice:matrix.org',
          display_name: 'Alice',
          space_room_id: '!space:mtrx.example.test',
          reason: 'matrix_space_join',
        },
      });
    } finally {
      if (existsSync(statePath)) unlinkSync(statePath);
      if (previousStatePath === undefined) delete process.env.MATRIX_ONBOARDING_STATE_PATH;
      else process.env.MATRIX_ONBOARDING_STATE_PATH = previousStatePath;
    }
  });

  it('does not queue onboarding for other rooms or the bot account', () => {
    resetEvents();
    const previousStatePath = process.env.MATRIX_ONBOARDING_STATE_PATH;
    const statePath = `/tmp/router-matrix-onboarding-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
    process.env.MATRIX_ONBOARDING_STATE_PATH = statePath;

    try {
      const handlers = new Map<any, (...args: any[]) => void>();
      const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });
      (platform as any).botUserId = '@router:mtrx.example.test';
      (platform as any).client = {
        on: vi.fn((eventName: any, handler: (...args: any[]) => void) => {
          handlers.set(eventName, handler);
        }),
      };

      (platform as any).setupEventListeners();
      const membershipHandler = handlers.get(RoomMemberEvent.Membership);

      membershipHandler?.(
        { getRoomId: () => '!elsewhere:mtrx.example.test' },
        {
          userId: '@alice:matrix.org',
          roomId: '!elsewhere:mtrx.example.test',
          membership: KnownMembership.Join,
        },
      );
      membershipHandler?.(
        { getRoomId: () => '!space:mtrx.example.test' },
        {
          userId: '@router:mtrx.example.test',
          roomId: '!space:mtrx.example.test',
          membership: KnownMembership.Join,
        },
      );

      expect(getEventsSince(0)).toHaveLength(0);
    } finally {
      if (existsSync(statePath)) unlinkSync(statePath);
      if (previousStatePath === undefined) delete process.env.MATRIX_ONBOARDING_STATE_PATH;
      else process.env.MATRIX_ONBOARDING_STATE_PATH = previousStatePath;
    }
  });
});

describe('MatrixPlatform history queries', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    spaceRoomId: '!space:mtrx.example.test',
    ...overrides,
  });

  const fakeEvent = (overrides: {
    id: string;
    sender: string;
    text: string;
    timestamp: number;
    type?: string;
  }) => ({
    getType: () => overrides.type || EventType.RoomMessage,
    getSender: () => overrides.sender,
    getContent: () => ({ body: overrides.text }),
    getTs: () => overrides.timestamp,
    getId: () => overrides.id,
  });

  const fakeHistoryRoom = (roomId: string, opts: {
    name?: string;
    alias?: string;
    members?: string[];
    inSpace?: boolean;
    events?: Array<ReturnType<typeof fakeEvent>>;
  } = {}) => {
    const members = opts.members || ['@router:mtrx.example.test', '@james:matrix.org', '@alice:mtrx.example.test'];
    return {
      roomId,
      name: opts.name,
      getCanonicalAlias: () => opts.alias || null,
      getMyMembership: () => KnownMembership.Join,
      getJoinedMembers: () => members.map(userId => ({ userId })),
      getJoinedMemberCount: () => members.length,
      getMember: (userId: string) => members.includes(userId)
        ? { userId, membership: KnownMembership.Join }
        : null,
      getLiveTimeline: () => ({
        getEvents: () => opts.events || [],
      }),
      currentState: {
        getStateEvents: (type: string, stateKey: string) => {
          if (type === EventType.SpaceParent && stateKey === '!space:mtrx.example.test' && opts.inSpace) {
            return { getContent: () => ({ canonical: true }) };
          }
          if (type === 'm.room.canonical_alias' && opts.alias) {
            return { getContent: () => ({ alias: opts.alias }) };
          }
          return null;
        },
      },
    };
  };

  it('searches joined Shape Rotator space rooms and excludes unrelated rooms', async () => {
    const platform = createPlatform({
      resolveLinkedRouterHandle: async (_platform, userId) =>
        userId === '@alice:mtrx.example.test' ? 'alice' : null,
    });
    const now = Date.now();
    const inSpaceRoom = fakeHistoryRoom('!books:mtrx.example.test', {
      name: 'Books',
      alias: '#books:mtrx.example.test',
      inSpace: true,
      events: [
        fakeEvent({ id: '$1', sender: '@alice:mtrx.example.test', text: 'Matrix encryption came up here.', timestamp: now - 1000 }),
      ],
    });
    const unrelatedRoom = fakeHistoryRoom('!elsewhere:mtrx.example.test', {
      name: 'Elsewhere',
      inSpace: false,
      events: [
        fakeEvent({ id: '$2', sender: '@alice:mtrx.example.test', text: 'Matrix encryption elsewhere.', timestamp: now - 1000 }),
      ],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([inSpaceRoom, unrelatedRoom]),
      getRoom: vi.fn().mockReturnValue(null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      query: 'encryption',
      since: now - 60_000,
      viewerUserId: '@james:matrix.org',
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      roomId: '!books:mtrx.example.test',
      roomAlias: '#books:mtrx.example.test',
      senderHandle: 'alice',
      text: 'Matrix encryption came up here.',
    });
  });

  it('does not expose Shape Rotator space rooms to linked accounts outside the space', async () => {
    const platform = createPlatform();
    const now = Date.now();
    const inSpaceRoom = fakeHistoryRoom('!books:mtrx.example.test', {
      name: 'Books',
      inSpace: true,
      members: ['@router:mtrx.example.test', '@alice:mtrx.example.test'],
      events: [
        fakeEvent({ id: '$1', sender: '@alice:mtrx.example.test', text: 'Matrix encryption came up here.', timestamp: now - 1000 }),
      ],
    });
    const spaceRoom = fakeHistoryRoom('!space:mtrx.example.test', {
      members: ['@router:mtrx.example.test', '@member:mtrx.example.test'],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([inSpaceRoom, spaceRoom]),
      getRoom: vi.fn((roomId: string) => roomId === '!space:mtrx.example.test' ? spaceRoom : null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      query: 'encryption',
      since: now - 60_000,
      viewerUserId: '@outsider:mtrx.example.test',
      limit: 10,
    });

    expect(results).toHaveLength(0);
  });

  it('allows linked accounts in the Shape Rotator space to search child rooms they can join', async () => {
    const platform = createPlatform();
    const now = Date.now();
    const inSpaceRoom = fakeHistoryRoom('!books:mtrx.example.test', {
      name: 'Books',
      inSpace: true,
      members: ['@router:mtrx.example.test', '@alice:mtrx.example.test'],
      events: [
        fakeEvent({ id: '$1', sender: '@alice:mtrx.example.test', text: 'Matrix encryption came up here.', timestamp: now - 1000 }),
      ],
    });
    const spaceRoom = fakeHistoryRoom('!space:mtrx.example.test', {
      members: ['@router:mtrx.example.test', '@james:matrix.org'],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([inSpaceRoom, spaceRoom]),
      getRoom: vi.fn((roomId: string) => roomId === '!space:mtrx.example.test' ? spaceRoom : null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      query: 'encryption',
      since: now - 60_000,
      viewerUserId: '@james:matrix.org',
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      roomId: '!books:mtrx.example.test',
      text: 'Matrix encryption came up here.',
    });
  });

  it('allows Router bot scope to search joined non-DM rooms outside the configured space', async () => {
    const platform = createPlatform();
    const now = Date.now();
    const joinedRoom = fakeHistoryRoom('!outside:mtrx.example.test', {
      name: 'Outside',
      members: ['@router:mtrx.example.test', '@alice:mtrx.example.test', '@bob:mtrx.example.test'],
      events: [
        fakeEvent({ id: '$outside', sender: '@alice:mtrx.example.test', text: 'Encryption outside the space.', timestamp: now - 1000 }),
      ],
    });
    const dmRoom = fakeHistoryRoom('!dm-visible:mtrx.example.test', {
      name: 'James DM',
      members: ['@router:mtrx.example.test', '@james:matrix.org'],
      events: [
        fakeEvent({ id: '$dm', sender: '@james:matrix.org', text: 'Encryption in a DM.', timestamp: now - 1000 }),
      ],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([joinedRoom, dmRoom]),
      getRoom: vi.fn().mockReturnValue(null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      query: 'encryption',
      since: now - 60_000,
      botScope: true,
      includeDMs: false,
      spaceOnly: false,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      roomId: '!outside:mtrx.example.test',
      text: 'Encryption outside the space.',
    });
  });

  it('allows Router bot scope to read a specific current DM room only when requested', async () => {
    const platform = createPlatform();
    const now = Date.now();
    const dmRoom = fakeHistoryRoom('!dm-current:mtrx.example.test', {
      name: 'James DM',
      members: ['@router:mtrx.example.test', '@james:matrix.org'],
      events: [
        fakeEvent({ id: '$dm', sender: '@james:matrix.org', text: 'Summarize this DM context.', timestamp: now - 1000 }),
      ],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([dmRoom]),
      getRoom: vi.fn().mockReturnValue(null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      roomIds: ['!dm-current:mtrx.example.test'],
      since: now - 60_000,
      botScope: true,
      includeDMs: true,
      spaceOnly: false,
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      roomId: '!dm-current:mtrx.example.test',
      isDM: true,
      text: 'Summarize this DM context.',
    });
  });

  it('only includes DMs when the linked Matrix user is in the room', async () => {
    const platform = createPlatform();
    const now = Date.now();
    const visibleDm = fakeHistoryRoom('!dm-visible:mtrx.example.test', {
      members: ['@router:mtrx.example.test', '@james:matrix.org'],
      events: [
        fakeEvent({ id: '$visible', sender: '@james:matrix.org', text: 'Encryption in my DM.', timestamp: now - 1000 }),
      ],
    });
    const hiddenDm = fakeHistoryRoom('!dm-hidden:mtrx.example.test', {
      members: ['@router:mtrx.example.test', '@alice:mtrx.example.test'],
      events: [
        fakeEvent({ id: '$hidden', sender: '@alice:mtrx.example.test', text: 'Encryption in another DM.', timestamp: now - 1000 }),
      ],
    });

    (platform as any).client = {
      getRooms: vi.fn().mockReturnValue([visibleDm, hiddenDm]),
      getRoom: vi.fn().mockReturnValue(null),
      getAccountData: vi.fn().mockReturnValue(undefined),
      scrollback: vi.fn().mockResolvedValue(undefined),
    };

    const results = await platform.queryRecentMessages({
      query: 'encryption',
      includeDMs: true,
      viewerUserId: '@james:matrix.org',
      limit: 10,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      roomId: '!dm-visible:mtrx.example.test',
      isDM: true,
      text: 'Encryption in my DM.',
    });
  });
});

describe('MatrixPlatform agent trigger reactions', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  const fakeIncomingEvent = (overrides: {
    id: string;
    text: string;
    sender?: string;
    roomId?: string;
    timestamp?: number;
    content?: Record<string, any>;
  }) => ({
    getType: () => EventType.RoomMessage,
    getSender: () => overrides.sender || '@alice:mtrx.example.test',
    getRoomId: () => overrides.roomId || '!room:mtrx.example.test',
    getId: () => overrides.id,
    getContent: () => ({ body: overrides.text, ...(overrides.content || {}) }),
    getTs: () => overrides.timestamp ?? Date.now(),
  });

  const fakeRoom = (members = ['@router:mtrx.example.test', '@alice:mtrx.example.test', '@bob:mtrx.example.test']) => ({
    roomId: '!room:mtrx.example.test',
    getJoinedMemberCount: () => members.length,
    getJoinedMembers: () => members.map(userId => ({ userId })),
    getMember: (userId: string) => members.includes(userId)
      ? { userId, membership: KnownMembership.Join }
      : null,
    currentState: {
      getStateEvents: () => null,
    },
  });

  it('reacts to Matrix messages that trigger the agent', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ event_id: '$reaction' });
    const platform = createPlatform();
    (platform as any).botUserId = '@router:mtrx.example.test';
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue(fakeRoom()),
      getAccountData: vi.fn().mockReturnValue(undefined),
      sendEvent,
    };

    (platform as any).handleIncomingMessageEvent(fakeIncomingEvent({
      id: '$mention',
      text: '@router can you check this?',
    }));

    await vi.waitFor(() => {
      expect(sendEvent).toHaveBeenCalledWith('!room:mtrx.example.test', EventType.Reaction, {
        'm.relates_to': {
          rel_type: RelationType.Annotation,
          event_id: '$mention',
          key: '🪩',
        },
      });
    });
  });

  it('queues structured mentions in space-child rooms as non-DM platform mentions', async () => {
    resetEvents();
    const sendEvent = vi.fn().mockResolvedValue({ event_id: '$reaction' });
    const platform = createPlatform({ spaceRoomId: '!space:mtrx.example.test' });
    (platform as any).botUserId = '@router:mtrx.example.test';
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue({
        ...fakeRoom(['@router:mtrx.example.test', '@alice:mtrx.example.test']),
        currentState: {
          getStateEvents: vi.fn((eventType: string, stateKey: string) =>
            eventType === EventType.SpaceParent && stateKey === '!space:mtrx.example.test'
              ? { getContent: () => ({ via: ['mtrx.example.test'] }) }
              : null,
          ),
        },
      }),
      getAccountData: vi.fn().mockReturnValue(undefined),
      sendEvent,
    };

    (platform as any).handleIncomingMessageEvent(fakeIncomingEvent({
      id: '$structured-mention',
      text: '@router search shape-matrix-live-smoke',
      content: {
        'm.mentions': { user_ids: ['@router:mtrx.example.test'] },
      },
    }));

    await vi.waitFor(() => {
      expect(sendEvent).toHaveBeenCalled();
    });

    const events = getEventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'platform_mention',
      data: {
        platform: 'matrix',
        room_id: '!room:mtrx.example.test',
        message_id: '$structured-mention',
        text: '@router search shape-matrix-live-smoke',
        is_dm: false,
      },
    });
  });

  it('does not react to ordinary Matrix messages that do not trigger the agent', async () => {
    const sendEvent = vi.fn().mockResolvedValue({ event_id: '$reaction' });
    const platform = createPlatform();
    (platform as any).botUserId = '@router:mtrx.example.test';
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue(fakeRoom()),
      getAccountData: vi.fn().mockReturnValue(undefined),
      sendEvent,
    };

    (platform as any).handleIncomingMessageEvent(fakeIncomingEvent({
      id: '$ordinary',
      text: 'just noting this here',
    }));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sendEvent).not.toHaveBeenCalled();
  });

  it('ignores Matrix messages older than the configured startup cutoff', async () => {
    resetEvents();
    const sendEvent = vi.fn().mockResolvedValue({ event_id: '$reaction' });
    const platform = createPlatform({ ignoreMessagesBefore: 10_000 });
    (platform as any).botUserId = '@router:mtrx.example.test';
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue(fakeRoom()),
      getAccountData: vi.fn().mockReturnValue(undefined),
      sendEvent,
    };

    (platform as any).handleIncomingMessageEvent(fakeIncomingEvent({
      id: '$old-mention',
      text: '@router replayed old sync message',
      timestamp: 9_000,
    }));

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(sendEvent).not.toHaveBeenCalled();
    expect(getEventsSince(0)).toHaveLength(0);
    expect((platform as any).processedMessageEvents.has('$old-mention')).toBe(true);
  });

  it('includes pending entry IDs when users reply to pending review messages', () => {
    resetEvents();
    const platform = createPlatform();
    (platform as any).botUserId = '@router:mtrx.example.test';
    (platform as any).pendingReviewEventMap.set('$pending-review', 'entry-1');
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue(fakeRoom(['@router:mtrx.example.test', '@alice:mtrx.example.test'])),
      getAccountData: vi.fn().mockReturnValue(undefined),
      setAccountData: vi.fn().mockResolvedValue({}),
      sendEvent: vi.fn().mockResolvedValue({ event_id: '$ack' }),
    };

    (platform as any).handleIncomingMessageEvent(fakeIncomingEvent({
      id: '$reply',
      text: 'publish',
      content: {
        'm.relates_to': {
          'm.in_reply_to': { event_id: '$pending-review' },
        },
      },
    }));

    const events = getEventsSince(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'platform_mention',
      data: {
        platform: 'matrix',
        pending_entry_id: 'entry-1',
        text: 'publish',
        message_id: '$reply',
        sender_id: '@alice:mtrx.example.test',
      },
    });
  });
});

describe('MatrixPlatform spark rooms', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('reads and validates the pair stored in Router spark room state', async () => {
    const platform = createPlatform();
    (platform as any).client = {
      getRoom: vi.fn().mockReturnValue({
        currentState: {
          getStateEvents: vi.fn((eventType: string, _stateKey: string) =>
            eventType === ROUTER_SPARK_EVENT
              ? { getContent: () => ({ source_handle: '@Alice', target_handle: 'BOB' }) }
              : null,
          ),
        },
      }),
    };

    await expect(platform.getSparkRoomPair('!spark:mtrx.example.test')).resolves.toEqual({
      sourceHandle: 'alice',
      targetHandle: 'bob',
    });
    await expect(platform.isSparkRoomForPair('!spark:mtrx.example.test', 'bob', 'alice')).resolves.toBe(true);
    await expect(platform.isSparkRoomForPair('!spark:mtrx.example.test', 'bob', 'charlie')).resolves.toBe(false);
  });
});

describe('MatrixPlatform message formatting', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    ...overrides,
  });

  it('renders Markdown as Matrix formatted HTML for regular sends', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) =>
        name === 'matrix' && handle === 'socrates1024' ? '@socrates1024:matrix.org' : null,
    });
    (platform as any).client = { sendMessage };

    await expect(platform.sendMessage(
      '!room:mtrx.example.test',
      '# For you\n\n- **Bold** [link](https://example.com) for @socrates1024\n\n<script>alert(1)</script>',
      { replyTo: '$parent' },
    )).resolves.toBe('$event');

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      body: expect.stringContaining('@socrates1024:matrix.org'),
      format: 'org.matrix.custom.html',
      formatted_body: expect.stringContaining('<h1>For you</h1>'),
      'm.relates_to': {
        'm.in_reply_to': {
          event_id: '$parent',
        },
      },
    }));
    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('<li><strong>Bold</strong> <a href="https://example.com">link</a> for <a href="https://matrix.to/#/%40socrates1024%3Amatrix.org">@socrates1024:matrix.org</a></li>'),
    }));
    expect(sendMessage.mock.calls[0][1].formatted_body).not.toContain('<script>');
  });

  it('can send plain text without formatted HTML when requested', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform();
    (platform as any).client = { sendMessage };

    await platform.sendMessage('!room:mtrx.example.test', '**literal**', { format: 'plain' });

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', {
      msgtype: 'm.text',
      body: '**literal**',
    });
  });

  it('uses the shared Markdown renderer for visible spark context messages', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const sendStateEvent = vi.fn().mockResolvedValue({ event_id: '$state' });
    const platform = createPlatform();
    (platform as any).client = { sendMessage, sendStateEvent };

    await expect(platform.postSparkContext('!room:mtrx.example.test', {
      sourceHandle: 'alice',
      targetHandle: 'james',
      reason: 'because **this matters**',
    })).resolves.toBe('$event');

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      format: 'org.matrix.custom.html',
      formatted_body: expect.stringContaining('<strong>🔗 Connected:</strong> because <strong>this matters</strong>'),
    }));
  });
});

describe('MatrixPlatform post rendering', () => {
  const createPlatform = (overrides: Partial<ConstructorParameters<typeof MatrixPlatform>[0]> = {}) => new MatrixPlatform({
    serverUrl: 'https://mtrx.example.test',
    serverName: 'mtrx.example.test',
    botSecretKey: 'test-secret',
    botHandle: 'router',
    baseUrl: 'https://router.example.test',
    ...overrides,
  });

  it('renders linked Matrix IDs for authors and inline handles in Matrix posts', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) => {
        if (name !== 'matrix') return null;
        if (handle === 'james') return '@specularist:matrix.org';
        if (handle === 'socrates1024') return '@socrates1024:matrix.org';
        return null;
      },
    });

    (platform as any).client = { sendMessage };

    await expect(platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-1',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: 'Looping in @socrates1024 on this one.',
      timestamp: Date.now(),
    })).resolves.toBe('$event');

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      author_handle: 'james',
      author_platform_id: '@specularist:matrix.org',
      body: expect.stringContaining('@specularist:matrix.org:\n\nLooping in @socrates1024:matrix.org on this one.'),
      formatted_body: expect.stringContaining('https://matrix.to/#/%40specularist%3Amatrix.org'),
    }));
    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('https://matrix.to/#/%40socrates1024%3Amatrix.org'),
    }));
  });

  it('renders Markdown in Matrix entry posts while preserving linked handles', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) =>
        name === 'matrix' && handle === 'socrates1024' ? '@socrates1024:matrix.org' : null,
    });

    (platform as any).client = { sendMessage };

    await platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-markdown',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: '# Heading\n\n- **item** for @socrates1024',
      timestamp: Date.now(),
    });

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('<h1>Heading</h1>'),
    }));
    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('<p>@james:</p><h1>Heading</h1>'),
    }));
    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      formatted_body: expect.stringContaining('<li><strong>item</strong> for <a href="https://matrix.to/#/%40socrates1024%3Amatrix.org">@socrates1024:matrix.org</a></li>'),
    }));
  });

  it('does not truncate Matrix entry posts at the old 500 character preview limit', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async () => null,
    });
    const longContent = [
      'This entry starts normally.',
      'x'.repeat(700),
      'The tail should still render with **bold tail text**.',
    ].join('\n\n');

    (platform as any).client = { sendMessage };

    await platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-long',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: longContent,
      timestamp: Date.now(),
    });

    const message = sendMessage.mock.calls[0][1];
    expect(message.content_display_truncated).toBe(false);
    expect(message.body).toContain('The tail should still render');
    expect(message.body).not.toContain('[truncated - read full entry]');
    expect(message.formatted_body).toContain('The tail should still render');
    expect(message.formatted_body).toContain('<strong>bold tail text</strong>');
  });

  it('renders linked Matrix IDs in editorial hooks as well as regular entry bodies', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async (name, handle) =>
        name === 'matrix' && handle === 'socrates1024' ? '@socrates1024:matrix.org' : null,
    });

    (platform as any).client = { sendMessage };

    await platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-hook',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: 'body text',
      timestamp: Date.now(),
    }, 'Ask @socrates1024 to review this.');

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      body: expect.stringContaining('@socrates1024:matrix.org'),
      formatted_body: expect.stringContaining('<a href="https://matrix.to/#/%40socrates1024%3Amatrix.org">@socrates1024:matrix.org</a>'),
    }));
  });

  it('leaves Router handles untouched when no linked Matrix ID exists', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ event_id: '$event' });
    const platform = createPlatform({
      resolveLinkedPlatformId: async () => null,
    });

    (platform as any).client = { sendMessage };

    await platform.postEntry('!room:mtrx.example.test', {
      id: 'entry-2',
      handle: 'james',
      pseudonym: 'Solitary Feather#123',
      content: 'Asking @someone-else to weigh in.',
      timestamp: Date.now(),
    });

    expect(sendMessage).toHaveBeenCalledWith('!room:mtrx.example.test', expect.objectContaining({
      author_platform_id: undefined,
      body: expect.stringContaining('@james:\n\nAsking @someone-else to weigh in.'),
      formatted_body: expect.stringContaining('@james'),
    }));
  });
});
