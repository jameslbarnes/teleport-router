/** Narrow, revocable Discord permissions. Bot credentials never stand in for an author's key. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { hashSecretKey, isValidSecretKey } from './identity.js';
import { tokenize } from './storage.js';
import type { Channel, JournalEntry, Storage, User } from './storage.js';
import type { DiscordAudienceReader } from './discord-audience.js';
import type { PostingRules } from './posting-rules.js';

export interface DiscordGroupBinding {
  guildId: string;
  /** Omitted on older bindings, which remain restricted to their one channel. */
  scope?: 'channel' | 'guild';
  channelId?: string;
  botHandle: string;
  version: string;
  /** Shared replies are opt-in and checked against everyone who can currently see the channel. */
  conversationChannelIds?: string[];
}
export interface DiscordGroupGrant extends DiscordGroupBinding {
  id: string;
  groupId: string;
  discordUserId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
  deliveryPending?: boolean;
  discordUsername?: string;
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

/**
 * How far a person's own posting rules let a group's bot post for them in that group: without asking,
 * only after asking, or only when they ask. Someone with no rules yet is asked each time, and so is
 * someone whose automatic rules do not name this group.
 */
export function groupPostingMode(rules: PostingRules | undefined, groupId: string): 'automatic' | 'review' | 'manual' {
  if (!rules) return 'review';
  if (rules.mode !== 'automatic') return rules.mode;
  return rules.audience === 'selected' && rules.destinations.includes(`#${groupId}`) ? 'automatic' : 'review';
}
type AuthorStatus = (handle: string) => Promise<{linked: boolean; available?: boolean}>;
/** A permission lasts while it is used: 30 days after the last command, and never more than a year without relinking. */
export const GRANT_IDLE_MS = 30 * 86400_000, GRANT_MAX_MS = 365 * 86400_000, GRANT_RENEW_EVERY_MS = 86400_000;

/** Notes matching more of the question come first; ties keep the newest first. Common words alone never match. */
export function rankNotes<T extends {content: string}>(notes: T[], query: string): T[] {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];
  if (!words.length) return notes;
  const meaningful = words.filter(w => tokenize(w).length || /[^\x00-\x7f]/.test(w));
  const terms = meaningful.length ? meaningful : words;
  return notes.map((note, index) => { const text = note.content.toLowerCase();
      return {note, index, score: terms.filter(term => text.includes(term)).length}; })
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).map(x => x.note);
}

export function discordGroups(storage: Storage, published: Storage, authorStatus: AuthorStatus,
  { baseUrl, now = Date.now, audience }: {baseUrl: string; now?: () => number; audience?: DiscordAudienceReader}) {
  const pending = new Map<string, {handle: string; groupId: string; discordUserId: string; binding: DiscordGroupBinding; expiresAt: number}>();
  type Pair = { groupId: string; discordUserId: string; channelId: string; displayName: string; username: string;
    binding: DiscordGroupBinding; expiresAt: number; owner?: string; grantId?: string; connected?: boolean;
    result?: { grant: string; handle: string; groupId: string; expiresAt: number } };
  const pairs = new Map<string, Pair>();
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

  async function authorize(bot: User, body: Body, allowPending = false) {
    const token = typeof body.grant === 'string' ? body.grant : '';
    const match = token.match(/^rdg1\.([a-z0-9_]{3,15})\.([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/);
    if (!match) return fail(403, 'Link this Discord account to the private Router group first.');
    const owner = await storage.getUser(match[1]);
    const grant = owner?.discordGrants?.find(g => g.id === match[2]);
    if (!owner || !grant || grant.revokedAt || grant.expiresAt <= now() || !sameHash(grant.tokenHash, digest(token))
      || grant.botHandle !== bot.handle || (grant.deliveryPending && !allowPending)) return fail(403, 'This Discord permission is no longer active. Use /router-link to connect again.');
    checkContext(body, grant, grant.discordUserId);
    const group = await groupFor(grant.groupId);
    if (!group.discord || !sameBinding(grant, group.discord) || !member(group, owner.handle) || !member(group, bot.handle))
      return fail(403, 'Private group access unavailable.');
    if (!owner.linkedAccounts?.some(a => a.platform === 'discord' && a.platformUserId === grant.discordUserId && a.verified === true))
      return fail(403, 'The Discord account link is no longer active.');
    return {owner, grant, group};
  }

  async function conversationAccess(bot: User, body: Body) {
    const initial = await authorize(bot, body);
    if (!initial.group.discord?.conversationChannelIds?.includes(String(body.channelId)))
      return fail(403, 'Shared group replies are not enabled in this channel. Private /router-recall still works.');
    if (!audience) return fail(503, 'Router cannot check this Discord audience. Private /router-recall still works.');
    let viewers;
    try { viewers = await audience(initial.grant.guildId, String(body.channelId)); }
    catch { return fail(503, 'Router cannot check this Discord audience. Private /router-recall still works.'); }
    // Discord can take seconds. Reload Router membership and the binding afterwards.
    const auth = await authorize(bot, body), {group, grant} = auth;
    if (!group.discord?.conversationChannelIds?.includes(String(body.channelId)))
      return fail(403, 'Shared group replies are not enabled in this channel. Private /router-recall still works.');
    // A channel that anyone joining the server can see has no fixed audience: a newcomer could read the
    // reply before linking. The server must hide its group channels until a person has linked.
    if (viewers.open) return fail(403, 'I cannot use group notes here while this channel is visible to everyone who joins the Discord server. Private /router-recall still works.');
    if (!viewers.viewerIds.includes(grant.discordUserId)) return fail(403, 'The requesting Discord account cannot see this channel.');
    const linked = new Set<string>();
    for (const subscriber of group.subscribers) {
      const person = await storage.getUser(subscriber.handle);
      for (const permission of person?.discordGrants || []) {
        if (permission.groupId === group.id && !permission.revokedAt && !permission.deliveryPending
          && permission.expiresAt > now() && sameBinding(permission, group.discord)
          && person?.linkedAccounts?.some(a => a.platform === 'discord' && a.verified === true && a.platformUserId === permission.discordUserId))
          linked.add(permission.discordUserId);
      }
    }
    if (viewers.viewerIds.some(id => id !== viewers.botId && !linked.has(id)))
      return fail(403, 'I cannot use group notes here until everyone who can see this channel has linked their account and joined the Router group. Private /router-recall still works.');
    // No claims about who saw a reply, and no trust in a member list supplied by the bot process.
    return {...auth, audienceVersion: digest(JSON.stringify([grant.guildId, body.channelId, viewers.botId, viewers.viewerIds]))};
  }
  const conversationView = (entry: JournalEntry) => ({...view(entry), version: digest(JSON.stringify(view(entry)))});

  async function renewGrant(owner: User, grant: DiscordGroupGrant) {
    const renewed = Math.min(now() + GRANT_IDLE_MS, grant.createdAt + GRANT_MAX_MS);
    if (renewed - grant.expiresAt < GRANT_RENEW_EVERY_MS) return grant.expiresAt;
    return exclusive('links', async () => {
      const current = await storage.getUser(owner.handle);
      const active = current?.discordGrants?.find(g => g.id === grant.id && !g.revokedAt && g.expiresAt > now());
      if (!active) return fail(403, 'This Discord permission is no longer active. Use /router-link to connect again.');
      const expiresAt = Math.max(active.expiresAt, renewed);
      await storage.updateUser(owner.handle, {discordGrants: current!.discordGrants!.map(g => g.id === grant.id ? {...g, expiresAt} : g)});
      return expiresAt;
    });
  }

  /** Shared by the original one-use codes and browser pairing. Caller holds the links lock. */
  async function issueGrant(owner: User, group: Channel, binding: DiscordGroupBinding, discordUserId: string, pairing?: Pair) {
    if (!group.discord || !sameBinding(binding, group.discord) || !member(group, owner.handle) || !member(group, binding.botHandle))
      return fail(403, 'Private group access unavailable.');
    const status = await authorStatus(owner.handle);
    if (!status.linked || !status.available) return fail(409, 'Your TinyCloud storage is unavailable.');
    const all = await storage.getAllUsers();
    if (all.some(u => u.handle !== owner.handle && u.linkedAccounts?.some(a => a.platform === 'discord'
        && a.platformUserId === discordUserId && a.verified === true)))
      return fail(409, 'This Discord account is already linked to another Router identity.');
    if (owner.linkedAccounts?.some(a => a.platform === 'discord' && a.verified === true && a.platformUserId !== discordUserId))
      return fail(409, 'This Router identity is already linked to another Discord account.');
    const id = randomBytes(12).toString('hex');
    const token = `rdg1.${owner.handle}.${id}.${randomBytes(32).toString('base64url')}`;
    const grant: DiscordGroupGrant = {...binding, id, groupId: group.id, discordUserId,
      ...(pairing ? {deliveryPending: true, discordUsername: pairing.username} : {}),
      tokenHash: digest(token), createdAt: now(), expiresAt: now() + GRANT_IDLE_MS};
    const grants = (owner.discordGrants || []).filter(g => g.expiresAt > now() && !g.revokedAt
      && !(g.groupId === group.id && g.botHandle === binding.botHandle));
    if (grants.length >= 25) return fail(409, 'Too many active Discord group permissions.');
    const linkedAccounts = (owner.linkedAccounts || []).filter(a => !(a.platform === 'discord' && a.platformUserId === discordUserId));
    linkedAccounts.push({platform: 'discord', platformUserId: discordUserId, verified: true, linkedAt: now()});
    await storage.updateUser(owner.handle, {linkedAccounts, discordGrants: [...grants, grant]});
    return {grant: token, handle: owner.handle, groupId: group.id, expiresAt: grant.expiresAt};
  }
  async function revokeGrant(owner: User, grantId: string) {
    const discordGrants = owner.discordGrants!.map(g => g.id === grantId ? {...g, revokedAt: now()} : g);
    const linkedAccounts = (owner.linkedAccounts || []).filter(a => a.platform !== 'discord' ||
      discordGrants.some(g => g.discordUserId === a.platformUserId && !g.revokedAt && g.expiresAt > now()));
    await storage.updateUser(owner.handle, {discordGrants, linkedAccounts});
  }

  async function serve(path: string, authorization: string | undefined, body: Body): Promise<unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'JSON object required.');
    const user = await caller(authorization);
    if (path === '/api/discord/conversation/configure') {
      return exclusive('links', async () => {
        const group = await groupFor(body.groupId);
        if (!group.subscribers.some(s => s.handle === user.handle && s.role === 'admin')) return fail(403, 'Group admin required.');
        if (!group.discord || !Array.isArray(body.channelIds) || body.channelIds.length > 20
          || body.channelIds.some(id => !snowflake(id)) || new Set(body.channelIds).size !== body.channelIds.length
          || (group.discord.scope !== 'guild' && body.channelIds.some(id => id !== group.discord!.channelId)))
          return fail(400, 'Choose up to 20 text channels covered by the existing Discord connection.');
        await storage.updateChannel(group.id, {discord: {...group.discord, conversationChannelIds: body.channelIds as string[]}});
        return {groupId: group.id, channelIds: body.channelIds};
      });
    }
    if (path === '/api/discord/conversation/operate') {
      const {group, owner, grant, audienceVersion} = await conversationAccess(user, body);
      if (body.action === 'check') {
        await renewGrant(owner, grant);
        return {groupId: group.id, audienceVersion};
      }
      if (body.audienceVersion !== audienceVersion) return fail(409, 'The Discord audience changed. Please try again.');
      if (body.action === 'search') {
        if (typeof body.query !== 'string' || body.query.length > 500) return fail(400, 'Search text is too long.');
        const entries = rankNotes((await published.getChannelEntries(group.id, 500)).filter(e => e.to?.includes(`#${group.id}`)), body.query).slice(0, 6);
        const final = await conversationAccess(user, body);
        if (final.audienceVersion !== audienceVersion) return fail(409, 'The Discord audience changed. Please try again.');
        return {groupId: group.id, entries: entries.map(conversationView)};
      }
      if (body.action === 'read' || body.action === 'verify') {
        const refs = body.action === 'read' ? [{id: body.entryId}] : body.sources;
        if (!Array.isArray(refs) || refs.length > 30 || refs.some(r => !r || typeof r.id !== 'string' || !/^[\w-]{1,160}$/.test(r.id)
          || (body.action === 'verify' && (typeof r.version !== 'string' || !/^[a-f0-9]{64}$/.test(r.version)))))
          return fail(400, 'Provide valid source references.');
        const entries = [];
        for (const ref of refs) {
          const entry = await published.getEntry(ref.id);
          if (!entry || !entry.to?.includes(`#${group.id}`)) return fail(404, 'A source is no longer available in this group.');
          const current = conversationView(entry);
          if (body.action === 'verify' && current.version !== ref.version) return fail(409, 'A source changed. Please try again.');
          entries.push(current);
        }
        // Check the current audience and permissions after potentially slow storage reads.
        const final = await conversationAccess(user, body);
        if (final.audienceVersion !== audienceVersion) return fail(409, 'The Discord audience changed. Please try again.');
        return body.action === 'read' ? {entry: entries[0]} : {verified: true, audienceVersion};
      }
      return fail(400, 'Conversation access is read-only.');
    }
    if (path === '/api/discord/link/status') {
      const group = await groupFor(body.groupId);
      if (!member(group, user.handle)) return fail(403, 'Join this private group first.');
      const binding = group.discord;
      if (!binding || !member(group, binding.botHandle)) return {configured: false, linked: false};
      const grant = user.discordGrants?.find(g => g.groupId === group.id && !g.revokedAt && g.expiresAt > now() && sameBinding(g, binding)
        && user.linkedAccounts?.some(a => a.platform === 'discord' && a.verified && a.platformUserId === g.discordUserId));
      return {configured: true, linked: !!grant && !grant.deliveryPending, pending: !!grant?.deliveryPending,
        groupId: group.id, expiresAt: grant?.expiresAt, grantId: grant?.id, discordUserId: grant?.discordUserId, username: grant?.discordUsername,
        channelUrl: `https://discord.com/channels/${binding.guildId}${binding.channelId ? '/' + binding.channelId : ''}`};
    }
    if (path === '/api/discord/pair/start') {
      const group = await groupFor(body.groupId), binding = group.discord;
      if (!binding || binding.botHandle !== user.handle || !member(group, user.handle)) return fail(403, 'The configured group bot must start this connection.');
      checkContext(body, binding);
      for (const [id, p] of pairs) if (p.expiresAt <= now() || (p.binding.botHandle === user.handle && p.discordUserId === body.discordUserId)) pairs.delete(id);
      if (pairs.size >= 1000) return fail(429, 'Please retry linking later.');
      const pairing = `RD-PAIR-${randomBytes(24).toString('base64url')}`, expiresAt = now() + 10 * 60_000;
      pairs.set(digest(pairing), {groupId: group.id, discordUserId: body.discordUserId as string, channelId: body.channelId as string,
        username: typeof body.username === 'string' ? body.username.slice(0, 100).replace(/[\u0000-\u001f]/g, '') : '',
        displayName: typeof body.displayName === 'string' ? body.displayName.slice(0, 100).replace(/[\u0000-\u001f]/g, '') : '', binding: {...binding}, expiresAt});
      return {pairing, expiresAt, groupId: group.id, url: `${baseUrl}/group-setup?group=${encodeURIComponent(group.id)}#discord-pair=${pairing}`};
    }
    if (['/api/discord/pair/info', '/api/discord/pair/confirm', '/api/discord/pair/poll', '/api/discord/pair/ack'].includes(path)) {
      return exclusive('links', async () => {
        if (typeof body.pairing !== 'string' || !/^RD-PAIR-[A-Za-z0-9_-]{32}$/.test(body.pairing)) return fail(400, 'Open a fresh connection link from /router-link in Discord.');
        const pair = pairs.get(digest(body.pairing));
        if (!pair || pair.expiresAt <= now()) return fail(410, 'This connection link expired. Use /router-link in Discord again.');
        if (body.groupId !== pair.groupId) return fail(403, 'This connection belongs to another group.');
        const group = await groupFor(pair.groupId);
        if (!group.discord || !sameBinding(pair.binding, group.discord) || !member(group, pair.binding.botHandle)) return fail(403, 'The Discord connection changed. Start again.');
        if (path.endsWith('/poll') || path.endsWith('/ack')) {
          if (user.handle !== pair.binding.botHandle) return fail(403, 'Only the configured bot can finish this connection.');
          checkContext(body, pair.binding, pair.discordUserId);
          if (body.channelId !== pair.channelId) return fail(403, 'Return to the channel where you started linking.');
          const authorized = pair.result ? await authorize(user, {...body, grant: pair.result.grant}, true) : undefined;
          if (path.endsWith('/ack')) {
            if (!pair.result && !pair.connected) return fail(409, 'Confirm the connection in Router first.');
            if (authorized) await storage.updateUser(authorized.owner.handle, {discordGrants: authorized.owner.discordGrants!.map(g =>
              g.id === authorized.grant.id ? {...g, deliveryPending: false} : g)});
            pair.connected = true; pair.result = undefined;
          }
          return pair.result ? {status: 'approved', ...pair.result} : {status: pair.connected ? 'connected' : 'waiting'};
        }
        if (!member(group, user.handle) || (pair.owner && pair.owner !== user.handle)) return fail(403, 'This connection is unavailable to this Router account.');
        if (pair.owner) {
          const owner = await storage.getUser(pair.owner);
          if (!owner?.discordGrants?.some(g => g.id === pair.grantId && !g.revokedAt && g.expiresAt > now() && sameBinding(g, pair.binding)))
            return fail(410, 'This connection was withdrawn or replaced. Use /router-link again.');
        }
        if (path.endsWith('/confirm')) {
          if (body.confirmed !== true) return fail(400, 'Confirm which accounts you want to connect.');
          if (!pair.owner) {
            const owner = (await storage.getUser(user.handle))!;
            pair.result = await issueGrant(owner, group, pair.binding, pair.discordUserId, pair);
            pair.owner = user.handle;
            pair.grantId = pair.result.grant.split('.')[2];
          }
        }
        // The author sees the account and state, never the bot's scoped grant.
        return {status: pair.connected ? 'connected' : pair.owner ? 'approved' : 'waiting', groupId: pair.groupId,
          discordUserId: pair.discordUserId, username: pair.username, displayName: pair.displayName, expiresAt: pair.expiresAt};
      });
    }
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
            ? prior.version : randomBytes(16).toString('hex'),
          ...(prior && sameDestination(prior, destination) && prior.conversationChannelIds
            ? {conversationChannelIds: prior.conversationChannelIds} : {})};
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
        const result = await issueGrant(owner, group, challenge.binding, challenge.discordUserId);
        pending.delete(key);
        return result;
      });
    }
    if (path === '/api/discord/grants/revoke') {
      return exclusive('links', async () => {
        const owner = (await storage.getUser(user.handle))!;
        if (typeof body.grantId !== 'string' || !owner.discordGrants?.some(g => g.id === body.grantId))
          return fail(404, 'Permission not found.');
        await revokeGrant(owner, body.grantId);
        return {revoked: true};
      });
    }
    if (path !== '/api/discord/operate') return fail(404, 'Not found.');
    const {owner, group, grant} = await authorize(user, body);
    // "member" is the bot's periodic question "is this person still linked and in the group?". It is not
    // the person using their permission, so it does not extend it.
    // "rules" is the bot reading how this person wants posts made for them. Like "member", it is the bot's
    // question and not the person using their permission, so neither extends it.
    const expiresAt = body.action === 'unlink' || body.action === 'member' || body.action === 'rules' ? grant.expiresAt : await renewGrant(owner, grant);
    if (body.action === 'rules') {
      const rules = owner.postingRules;
      return {handle: owner.handle, groupId: group.id, mode: groupPostingMode(rules, group.id), revision: rules?.revision ?? 0,
        rules: rules ? {purpose: rules.purpose, share: rules.share, avoid: rules.avoid, style: rules.style, instructions: rules.instructions} : null};
    }
    if (body.action === 'delete') {
      // Only a note this permission could have written: saved from Discord, by this person, to this group alone.
      const entryId = body.entryId;
      if (typeof entryId !== 'string' || !/^discord-[a-f0-9]{40}$/.test(entryId)) return fail(400, 'Only a note saved from Discord can be deleted here.');
      return exclusive(`save:${entryId}`, async () => {
        const current = await authorize(user, body);
        const entry = await published.getEntry(entryId);
        if (!entry) return {deleted: true, groupId: group.id};
        if (entry.handle !== current.owner.handle || entry.to?.length !== 1 || entry.to[0] !== `#${group.id}`) return fail(404, 'Note unavailable in this group.');
        await published.deleteEntry(entry.id);
        return {deleted: true, groupId: group.id};
      });
    }
    if (body.action === 'member') return {handle: owner.handle, groupId: group.id, expiresAt};
    if (body.action === 'status') return {handle: owner.handle, groupId: group.id, expiresAt,
      storage: await authorStatus(owner.handle)};
    if (body.action === 'unlink') {
      return exclusive('links', async () => {
        const current = (await storage.getUser(owner.handle))!;
        await revokeGrant(current, grant.id);
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
      const entries = rankNotes((await published.getChannelEntries(group.id, 500)).filter(e => e.to?.includes(`#${group.id}`)),
        String(body.query || '')).slice(0, 8);
      await authorize(user, body);
      return {groupId: group.id, entries: entries.map(view)};
    }
    return fail(400, 'Unknown private-group action.');
  }
  return {serve};
}
