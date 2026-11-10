import { describe, it, expect } from 'vitest';
import { MemoryStorage, type Channel } from './storage.js';
import { groupOnboardingView, resolveOnboardingGroup } from './group-onboarding.js';

const channel: Channel = { id: 'reading-club', name: 'Reading club', description: 'Questions we want to explore together.', visibility: 'private', joinRule: 'invite', createdBy: 'alice', createdAt: 1, skills: [], subscribers: [{ handle: 'alice', role: 'admin', joinedAt: 1 }] };
const base = 'https://router.example';

describe('Group setup without changing membership or personal choices', () => {
  it('rejects missing membership, invalid group names and a token for another group', async () => {
    const storage = new MemoryStorage();
    await storage.createChannel(channel);
    await storage.createInvite({ token: 'invitation', channelId: channel.id, createdBy: 'alice', createdAt: 1, uses: 0 });
    await expect(resolveOnboardingGroup(storage, { groupId: channel.id, handle: 'outsider' })).rejects.toMatchObject({ status: 403 });
    await expect(resolveOnboardingGroup(storage, { groupId: '../other' })).rejects.toMatchObject({ status: 400 });
    await expect(resolveOnboardingGroup(storage, { groupId: 'another-club', inviteToken: 'invitation' })).rejects.toMatchObject({ status: 400 });
    const resolved = await resolveOnboardingGroup(storage, { inviteToken: 'invitation' });
    expect(resolved.member).toBe(false);
    expect((await storage.getInvite('invitation'))?.uses).toBe(0);
    expect((await storage.getChannel(channel.id))?.subscribers).toEqual(channel.subscribers);
  });

  it('does not revive expired, exhausted, missing or personal invitations', async () => {
    const storage = new MemoryStorage();
    await storage.createChannel(channel);
    const invite = { channelId: channel.id, createdBy: 'alice', createdAt: 1, uses: 0 };
    await storage.createInvite({ ...invite, token: 'expired', expiresAt: Date.now() - 1 });
    await storage.createInvite({ ...invite, token: 'used', maxUses: 1, uses: 1 });
    await storage.createInvite({ ...invite, token: 'personal', forHandle: 'bob' });
    for (const inviteToken of ['expired', 'used', 'missing']) await expect(resolveOnboardingGroup(storage, { inviteToken })).rejects.toMatchObject({ status: 410 });
    await expect(resolveOnboardingGroup(storage, { inviteToken: 'personal', handle: 'eve' })).rejects.toMatchObject({ status: 403 });
    await storage.removeSubscriber(channel.id, 'alice');
    await expect(resolveOnboardingGroup(storage, { groupId: channel.id, handle: 'alice' })).rejects.toMatchObject({ status: 403 });
  });

  it('describes the actual audience without exposing roster or storage grants', () => {
    const context = groupOnboardingView({ ...channel, store: { kind: 'tinycloud', prefix: 'groups/reading-club/', delegation: 'PRIVATE-GRANT' } }, true, base);
    expect(context.group.private).toBe(true);
    expect(context.group.audience).toContain('including people who join later');
    expect(context.suggested_rules).toMatchObject({ mode: 'automatic', audience: 'selected', destinations: ['#reading-club'] });
    expect(context.prompt).toContain('group_id: "reading-club"');
    expect(context.prompt).toContain('Keep any rules I already chose');
    expect(context.prompt).toContain('Joining a group does not connect my TinyCloud storage');
    expect(JSON.stringify(context)).not.toContain('PRIVATE-GRANT');
    expect(JSON.stringify(context)).not.toContain('alice');
    const open = groupOnboardingView({ ...channel, joinRule: 'open', visibility: 'public' }, true, base);
    expect(open.group.private).toBe(false);
    expect(open.group.audience).toContain('without joining');
    expect(open.suggested_rules.mode).toBe('review');
    expect(open.prompt).toContain('Use the existing review mode');
    expect(open.prompt).not.toContain('Use the existing automatic mode');
  });
});

describe('Invitation limits and removing a member', () => {
  it('gives every invitation an end date and a join limit, and rejects values outside the bounds', async () => {
    const { inviteLimits, INVITE_DEFAULT_HOURS, INVITE_DEFAULT_USES } = await import('./group-onboarding.js');
    expect(inviteLimits({}, 1000)).toEqual({ expiresAt: 1000 + INVITE_DEFAULT_HOURS * 3600_000, maxUses: INVITE_DEFAULT_USES });
    expect(inviteLimits({ expires_in_hours: 24, max_uses: 1 }, 0)).toEqual({ expiresAt: 86400_000, maxUses: 1 });
    for (const bad of [{ max_uses: 0 }, { max_uses: -1 }, { max_uses: 101 }, { max_uses: 1.5 }, { max_uses: '5' }, { expires_in_hours: 0 }, { expires_in_hours: 721 }, { expires_in_hours: Number.NaN }, { expires_in_hours: Infinity }]) {
      expect(() => inviteLimits(bad as never)).toThrowError(expect.objectContaining({ status: 400 }));
    }
  });

  it('lets only an admin remove an ordinary member, never themselves, another admin or the Discord connection', async () => {
    const { checkMemberRemoval } = await import('./group-onboarding.js');
    const group: Channel = { ...channel, discord: { guildId: '100000000000000001', scope: 'guild', botHandle: 'group_bot', version: 'v' },
      subscribers: [{ handle: 'alice', role: 'admin', joinedAt: 1 }, { handle: 'cora', role: 'admin', joinedAt: 1 },
        { handle: 'bob', role: 'member', joinedAt: 1 }, { handle: 'group_bot', role: 'member', joinedAt: 1 }] };
    expect(checkMemberRemoval(group, 'alice', '@Bob')).toBe('bob');
    expect(() => checkMemberRemoval(group, 'bob', 'alice')).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => checkMemberRemoval(group, 'outsider', 'bob')).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => checkMemberRemoval(group, 'alice', 'alice')).toThrowError(expect.objectContaining({ status: 400 }));
    expect(() => checkMemberRemoval(group, 'alice', 'cora')).toThrowError(expect.objectContaining({ status: 403 }));
    expect(() => checkMemberRemoval(group, 'alice', 'nobody')).toThrowError(expect.objectContaining({ status: 404 }));
    expect(() => checkMemberRemoval(group, 'alice', 'group_bot')).toThrowError(expect.objectContaining({ status: 409 }));
    expect(() => checkMemberRemoval(group, 'alice', undefined)).toThrowError(expect.objectContaining({ status: 404 }));
  });
});
