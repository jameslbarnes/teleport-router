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
