/** Fresh Discord audience for a whole-server private group. No message content or cache. */
export type DiscordAudience = {botId: string; memberIds: string[]};
export type DiscordAudienceReader = (guildId: string, channelId: string) => Promise<DiscordAudience>;
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);

/** All guild members are a conservative superset of a text channel's viewers, including admins.
 * Discord's List Guild Members endpoint requires GUILD_MEMBERS and paginates at 1000:
 * https://docs.discord.com/developers/resources/guild#list-guild-members
 * An unavailable, incomplete or oversized list blocks private reads; no stale-cache fallback.
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
      || channel.guild_id !== guildId || channel.id !== channelId || channel.type !== 0)
      throw new Error('Discord audience unavailable');
    const ids = new Set<string>();
    let after = '0', complete = false;
    for (let page = 0; page < 10; page++) {
      const members = await get(`/guilds/${guildId}/members?limit=1000&after=${after}`);
      if (!Array.isArray(members) || members.length > 1000) throw new Error('Discord audience unavailable');
      for (const member of members) {
        if (!snowflake(member?.user?.id) || BigInt(member.user.id) <= BigInt(after) || ids.has(member.user.id))
          throw new Error('Discord audience unavailable');
        ids.add(member.user.id);
      }
      if (members.length < 1000) { complete = true; break; }
      after = members.reduce((max, m) => BigInt(m.user.id) > BigInt(max) ? m.user.id : max, after);
    }
    if (!complete || !ids.has(guild.owner_id) || !ids.has(me.id)) throw new Error('Discord audience unavailable');
    return {botId: me.id, memberIds: [...ids].sort()};
  };
}
