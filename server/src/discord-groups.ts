/** Narrow, revocable Discord permissions. Bot credentials never stand in for an author's key. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashSecretKey, isValidSecretKey } from './identity.js';
import type { Channel, JournalEntry, Storage, User } from './storage.js';

export interface DiscordGroupBinding {
  guildId: string;
  /** Omitted on older bindings, which remain restricted to their one channel. */
  scope?: 'channel' | 'guild';
  channelId?: string;
  botHandle: string;
  version: string;
}
export interface DiscordGroupGrant extends DiscordGroupBinding {
  id: string;
  groupId: string;
  discordUserId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}
export class DiscordGroupError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const fail = (status: number, message: string): never => { throw new DiscordGroupError(status, message); };
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const sameHash = (a: string, b: string) => /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);
const member = (group: Channel, handle: string) => group.subscribers.some(s => s.handle === handle);
const privateGroup = (group: Channel) => (group.joinRule || (group.visibility === 'private' ? 'invite' : 'open')) === 'invite';
type Body = Record<string, unknown>;
type AuthorStatus = (handle: string) => Promise<{linked: boolean; available?: boolean}>;

export function discordGroups(storage: Storage, published: Storage, authorStatus: AuthorStatus,
  { baseUrl, now = Date.now }: {baseUrl: string; now?: () => number}) {
  const pending = new Map<string, {handle: string; groupId: string; discordUserId: string; binding: DiscordGroupBinding; expiresAt: number}>();
  const locks = new Map<string, Promise<unknown>>();
  async function exclusive<T>(key: string, action: () => Promise<T>): Promise<T> {
    const prior = locks.get(key) || Promise.resolve();
    const current = prior.catch(() => {}).then(action);
    locks.set(key, current);
    try { return await current; } finally { if (locks.get(key) === current) locks.delete(key); }
  }
  async function caller(authorization: string | undefined) {
    const key = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
    if (!key || !isValidSecretKey(key)) return fail(401, 'Router authentication required.');
    const user = await storage.getUserByKeyHash(hashSecretKey(key));
    if (!user) return fail(401, 'Router authentication required.');
    return user;
  }
  async function groupFor(groupId: unknown) {
    if (typeof groupId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,28}[a-z0-9]$/.test(groupId))
      return fail(400, 'A valid private Router group is required.');
    const group = await storage.getChannel(groupId);
    if (!group || !privateGroup(group)) return fail(403, 'Private group access unavailable.');
    return group;
  }
  function sameDestination(a: Omit<DiscordGroupBinding, 'version'>, b: Omit<DiscordGroupBinding, 'version'>) {
    return a.guildId === b.guildId && (a.scope ?? 'channel') === (b.scope ?? 'channel')
      && a.channelId === b.channelId && a.botHandle === b.botHandle;
  }
  function sameBinding(a: DiscordGroupBinding, b: DiscordGroupBinding) {
    return sameDestination(a, b) && a.version === b.version;
  }
  function checkContext(body: Body, binding: DiscordGroupBinding, discordUserId?: string) {
    const scope = binding.scope ?? 'channel';
    if (body.guildId !== binding.guildId || (scope !== 'guild' && body.channelId !== binding.channelId)
      || !['channel', 'guild'].includes(scope) || !snowflake(body.channelId)
      || (scope === 'guild' && binding.channelId !== undefined)
      || !snowflake(body.discordUserId) || (discordUserId && body.discordUserId !== discordUserId))
      fail(403, 'This permission does not cover this Discord account or channel.');
  }
  const view = (entry: JournalEntry) => ({id: entry.id, handle: entry.handle, pseudonym: entry.pseudonym,
    content: entry.content, timestamp: entry.timestamp, url: `${baseUrl}/e/${encodeURIComponent(entry.id)}`});

  async function authorize(bot: User, body: Body) {
    const token = typeof body.grant === 'string' ? body.grant : '';
    const match = token.match(/^rdg1\.([a-z0-9_]{3,15})\.([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return fail(403, 'Link this Discord account to the private Router group first.');
    const owner = await storage.getUser(match[1]);
    const grant = owner?.discordGrants?.find(g => g.id === match[2]);
    if (!owner || !grant || grant.revokedAt || grant.expiresAt <= now() || !sameHash(grant.tokenHash, digest(token))
      || grant.botHandle !== bot.handle) return fail(403, 'This Discord permission is no longer active.');
    checkContext(body, grant, grant.discordUserId);
    const group = await groupFor(grant.groupId);
    if (!group.discord || !sameBinding(grant, group.discord) || !member(group, owner.handle) || !member(group, bot.handle))
      return fail(403, 'Private group access unavailable.');
    if (!owner.linkedAccounts?.some(a => a.platform === 'discord' && a.platformUserId === grant.discordUserId && a.verified === true))
      return fail(403, 'The Discord account link is no longer active.');
    return {owner, grant, group};
  }

  async function serve(path: string, authorization: string | undefined, body: Body): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'JSON object required.');
    const user = await caller(authorization);
    if (path === '/api/discord/bind') {
      return exclusive('links', async () => {
        const group = await groupFor(body.groupId);
        if (!group.subscribers.some(s => s.handle === user.handle && s.role === 'admin')) return fail(403, 'Group admin required.');
        const scope = body.scope ?? 'channel';
        if (!snowflake(body.guildId) || (scope !== 'channel' && scope !== 'guild') || typeof body.botHandle !== 'string'
          || (scope === 'channel' && !snowflake(body.channelId)) || (scope === 'guild' && body.channelId !== undefined))
          return fail(400, 'Provide a Discord server, Router bot identity, and either channel scope with a channel ID or guild scope without one.');
        const bot = await storage.getUser(body.botHandle);
        if (!bot) return fail(400, 'Register the separate private-command bot identity first.');
        const prior = group.discord;
        const destination: Omit<DiscordGroupBinding, 'version'> = {guildId: body.guildId, scope: scope as 'channel' | 'guild',
          ...(scope === 'channel' ? {channelId: body.channelId as string} : {}), botHandle: bot.handle};
        const binding: DiscordGroupBinding = {...destination,
          version: prior && sameDestination(prior, destination)
            ? prior.version : randomBytes(16).toString('hex')};
        // The admin explicitly grants this service identity membership, without a cross-platform invitation.
        if (!member(group, bot.handle)) await storage.addSubscriber(group.id, bot.handle, 'member');
        await storage.updateChannel(group.id, {discord: binding});
        return {groupId: group.id, ...binding};
      });
    }
    if (path === '/api/discord/link/start') {
      const group = await groupFor(body.groupId);
      if (!group.discord || !member(group, user.handle) || !member(group, group.discord.botHandle))
        return fail(403, 'Join the configured private group first.');
      if (!snowflake(body.discordUserId)) return fail(400, 'Your Discord user ID is required.');
      const status = await authorStatus(user.handle);
      if (!status.linked || !status.available) return fail(409, 'Link and enable your TinyCloud storage before linking Discord.');
      for (const [key, value] of pending) if (value.expiresAt <= now() || value.handle === user.handle) pending.delete(key);
      if (pending.size >= 1000) return fail(429, 'Please retry linking later.');
      const code = `RD-LINK-${randomBytes(24).toString('base64url')}`;
      const expiresAt = now() + 10 * 60_000;
      pending.set(digest(code), {handle: user.handle, groupId: group.id, discordUserId: body.discordUserId,
        binding: {...group.discord}, expiresAt});
      return {code, expiresAt, groupId: group.id, discordUserId: body.discordUserId};
    }
    if (path === '/api/discord/link/complete') {
      return exclusive('links', async () => {
        const key = digest(typeof body.code === 'string' ? body.code : '');
        const challenge = pending.get(key);
        if (!challenge || challenge.expiresAt <= now()) return fail(403, 'That linking code is invalid, expired or already used.');
        if (challenge.binding.botHandle !== user.handle) return fail(403, 'Wrong bot for this linking code.');
        checkContext(body, challenge.binding, challenge.discordUserId);
        const group = await groupFor(challenge.groupId);
        const owner = await storage.getUser(challenge.handle);
        if (!owner || !group.discord || !sameBinding(challenge.binding, group.discord)
          || !member(group, owner.handle) || !member(group, user.handle)) return fail(403, 'Private group access unavailable.');
        const status = await authorStatus(owner.handle);
        if (!status.linked || !status.available) return fail(409, 'Your TinyCloud storage is unavailable.');
        const all = await storage.getAllUsers();
        if (all.some(u => u.handle !== owner.handle && u.linkedAccounts?.some(a => a.platform === 'discord'
          && a.platformUserId === challenge.discordUserId && a.verified === true)))
          return fail(409, 'This Discord account is already linked to another Router identity.');
        if (owner.linkedAccounts?.some(a => a.platform === 'discord' && a.verified === true && a.platformUserId !== challenge.discordUserId))
          return fail(409, 'This Router identity is already linked to another Discord account.');
        const id = randomBytes(12).toString('hex');
        const token = `rdg1.${owner.handle}.${id}.${randomBytes(32).toString('base64url')}`;
        const grant: DiscordGroupGrant = {...challenge.binding, id, groupId: group.id, discordUserId: challenge.discordUserId,
          tokenHash: digest(token), createdAt: now(), expiresAt: now() + 30 * 86400_000};
        const grants = (owner.discordGrants || []).filter(g => g.expiresAt > now() && !g.revokedAt
          && !(g.groupId === group.id && g.botHandle === user.handle));
        if (grants.length >= 25) return fail(409, 'Too many active Discord group permissions.');
        const linkedAccounts = (owner.linkedAccounts || []).filter(a => !(a.platform === 'discord' && a.platformUserId === grant.discordUserId));
        linkedAccounts.push({platform: 'discord', platformUserId: grant.discordUserId, verified: true, linkedAt: now()});
        await storage.updateUser(owner.handle, {linkedAccounts, discordGrants: [...grants, grant]});
        pending.delete(key);
        return {grant: token, handle: owner.handle, groupId: group.id, expiresAt: grant.expiresAt};
      });
    }
    if (path === '/api/discord/grants/revoke') {
      return exclusive('links', async () => {
        const owner = (await storage.getUser(user.handle))!;
        if (typeof body.grantId !== 'string' || !owner.discordGrants?.some(g => g.id === body.grantId))
          return fail(404, 'Permission not found.');
        await storage.updateUser(user.handle, {discordGrants: owner.discordGrants.map(g => g.id === body.grantId ? {...g, revokedAt: now()} : g)});
        return {revoked: true};
      });
    }
    if (path !== '/api/discord/operate') return fail(404, 'Not found.');
    const {owner, group, grant} = await authorize(user, body);
    if (body.action === 'status') return {handle: owner.handle, groupId: group.id, expiresAt: grant.expiresAt,
      storage: await authorStatus(owner.handle)};
    if (body.action === 'unlink') {
      return exclusive('links', async () => {
        const current = (await storage.getUser(owner.handle))!;
        await storage.updateUser(owner.handle, {discordGrants: current.discordGrants!.map(g => g.id === grant.id ? {...g, revokedAt: now()} : g)});
        return {revoked: true};
      });
    }
    if (body.action === 'save') {
      if (Object.keys(body).some(k => !['action','grant','guildId','channelId','discordUserId','interactionId','content'].includes(k)))
        return fail(400, 'Unexpected save fields. Author and audience are fixed by your permission.');
      if (typeof body.content !== 'string' || !body.content.trim() || body.content.length > 12000 || !snowflake(body.interactionId))
        return fail(400, 'Provide a note of 1-12000 characters and a Discord interaction ID.');
      const content = body.content.trim();
      const id = `discord-${digest(`${group.id}\0${owner.handle}\0${grant.guildId}\0${body.channelId}\0${body.interactionId}`).slice(0,40)}`;
      return exclusive(`save:${id}`, async () => {
        // Recheck after waiting for an earlier write; revoked/removed permissions cannot queue new writes.
        const current = await authorize(user, body);
        const status = await authorStatus(current.owner.handle);
        if (!status.linked || !status.available || !current.owner.tinycloud) return fail(503, 'Your TinyCloud storage is unavailable. Nothing was saved.');
        const previous = await published.getEntry(id);
        if (previous) {
          if (previous.handle !== owner.handle || previous.content !== content || previous.to?.length !== 1 || previous.to[0] !== `#${group.id}`)
            return fail(409, 'This Discord interaction already saved a different note.');
          return {saved: true, duplicate: true, groupId: group.id, entry: view(previous)};
        }
        let saved: JournalEntry;
        try {
          saved = await published.addEntry({id, pseudonym: current.owner.tinycloud.pseudonym, handle: owner.handle,
            content, client: 'code', timestamp: now(), to: [`#${group.id}`], visibility: 'private', humanVisible: true,
            aiOnly: false, isReflection: content.length >= 500} as JournalEntry);
        } catch { return fail(503, 'Storage did not confirm the save. Retry this interaction before assuming the note is saved.'); }
        return {saved: true, groupId: group.id, entry: view(saved)};
      });
    }
    if (body.action === 'read') {
      if (typeof body.entryId !== 'string' || !/^[\w-]{1,160}$/.test(body.entryId)) return fail(400, 'Entry ID required.');
      const entry = await published.getEntry(body.entryId);
      if (!entry || !entry.to?.includes(`#${group.id}`)) return fail(404, 'Note unavailable in this group.');
      await authorize(user, body); // storage checks may outlive a membership or permission change
      return {entry: view(entry)};
    }
    if (body.action === 'search') {
      if (body.query !== undefined && (typeof body.query !== 'string' || body.query.length > 500)) return fail(400, 'Search text is too long.');
      const words = String(body.query || '').toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
      const entries = (await published.getChannelEntries(group.id, 500)).filter(e => e.to?.includes(`#${group.id}`))
        .filter(e => !words.length || words.some(w => e.content.toLowerCase().includes(w))).slice(0, 8);
      await authorize(user, body);
      return {groupId: group.id, entries: entries.map(view)};
    }
    return fail(400, 'Unknown private-group action.');
  }
  return {serve};
}
