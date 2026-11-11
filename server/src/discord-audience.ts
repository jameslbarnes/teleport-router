/** Fresh Discord audience for one text channel of a private group's server. No message content or cache. */
export type DiscordAudience = {
  botId: string;
  /** Everyone who can see the channel right now, bots included. */
  viewerIds: string[];
  /** True when a person who joins the server with no roles would see the channel. */
  open: boolean;
};
export type DiscordAudienceReader = (guildId: string, channelId: string) => Promise<DiscordAudience>;
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);
const VIEW_CHANNEL = 1n << 10n, ADMINISTRATOR = 1n << 3n;
const bits = (v: unknown): bigint => {
  if (typeof v !== 'string' || !/^\d{1,40}$/.test(v)) throw new Error('Discord audience unavailable');
  return BigInt(v);
};

/** Who can see a channel, worked out from the server's roles, the channel's permission overwrites and
 * each member's roles, in the order Discord applies them:
 * https://docs.discord.com/developers/topics/permissions#permission-overwrites
 * The owner and anyone with Administrator see every channel. List Guild Members requires GUILD_MEMBERS
 * and paginates at 1000: https://docs.discord.com/developers/resources/guild#list-guild-members
 * An unavailable, incomplete, oversized or unreadable answer blocks private reads; no stale-cache fallback.
 */
export function discordAudience(token: string | undefined, request: typeof fetch = fetch): DiscordAudienceReader {
  return async (guildId, channelId) => {
    if (!token || !snowflake(guildId) || !snowflake(channelId)) throw new Error('Discord audience unavailable');
    const signal = AbortSignal.timeout(12000);
    async function get(path: string): Promise<any> {
      const response = await request(`https://discord.com/api/v10${path}`, {
        headers: {Authorization: `Bot ${token}`}, redirect: 'error', signal,
      });
      if (!response.ok) throw new Error('Discord audience unavailable');
      return response.json();
    }
    const [me, guild, channel] = await Promise.all([
      get('/users/@me'), get(`/guilds/${guildId}`), get(`/channels/${channelId}`),
    ]);
    // Threads, announcements (which can be followed elsewhere), forums and DMs are not destinations.
    if (!snowflake(me.id) || me.bot !== true || guild.id !== guildId || !snowflake(guild.owner_id)
      || channel.guild_id !== guildId || channel.id !== channelId || channel.type !== 0
      || !Array.isArray(guild.roles) || !Array.isArray(channel.permission_overwrites))
      throw new Error('Discord audience unavailable');

    const rolePermissions = new Map<string, bigint>();
    for (const role of guild.roles) {
      if (!snowflake(role?.id) || rolePermissions.has(role.id)) throw new Error('Discord audience unavailable');
      rolePermissions.set(role.id, bits(role.permissions));
    }
    // The @everyone role has the server's own ID.
    if (!rolePermissions.has(guildId)) throw new Error('Discord audience unavailable');
    const roleOverwrites = new Map<string, {allow: bigint; deny: bigint}>();
    const memberOverwrites = new Map<string, {allow: bigint; deny: bigint}>();
    for (const o of channel.permission_overwrites) {
      const target = o?.type === 0 ? roleOverwrites : o?.type === 1 ? memberOverwrites : undefined;
      if (!target || !snowflake(o.id) || target.has(o.id)) throw new Error('Discord audience unavailable');
      target.set(o.id, {allow: bits(o.allow), deny: bits(o.deny)});
    }
    function canView(userId: string, roleIds: string[]): boolean {
      if (userId === guild.owner_id) return true;
      let permissions = rolePermissions.get(guildId)!;
      for (const id of roleIds) {
        const granted = rolePermissions.get(id);
        if (granted === undefined) throw new Error('Discord audience unavailable');
        permissions |= granted;
      }
      if (permissions & ADMINISTRATOR) return true;
      const everyone = roleOverwrites.get(guildId);
      if (everyone) permissions = (permissions & ~everyone.deny) | everyone.allow;
      let allow = 0n, deny = 0n;
      for (const id of roleIds) {
        const o = roleOverwrites.get(id);
        if (o) { allow |= o.allow; deny |= o.deny; }
      }
      permissions = (permissions & ~deny) | allow;
      const own = memberOverwrites.get(userId);
      if (own) permissions = (permissions & ~own.deny) | own.allow;
      return (permissions & VIEW_CHANNEL) !== 0n;
    }

    const all = new Set<string>(), viewers: string[] = [];
    let after = '0', complete = false;
    for (let page = 0; page < 10; page++) {
      const members = await get(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      if (!Array.isArray(members) || members.length > 1000) throw new Error('Discord audience unavailable');
      for (const member of members) {
        if (!snowflake(member?.user?.id) || BigInt(member.user.id) <= BigInt(after) || all.has(member.user.id)
          || !Array.isArray(member.roles) || member.roles.some((id: unknown) => !snowflake(id)))
          throw new Error('Discord audience unavailable');
        all.add(member.user.id);
        if (canView(member.user.id, member.roles)) viewers.push(member.user.id);
      }
      if (members.length < 1000) { complete = true; break; }
      after = members.reduce((max, m) => BigInt(m.user.id) > BigInt(max) ? m.user.id : max, after);
    }
    // The bot must itself see the channel it is about to answer in.
    if (!complete || !all.has(guild.owner_id) || !all.has(me.id) || !viewers.includes(me.id))
      throw new Error('Discord audience unavailable');
    // "0" stands for someone who joins a moment from now: no roles and no overwrite of their own.
    return {botId: me.id, viewerIds: viewers.sort(), open: canView('0', [])};
  };
}
