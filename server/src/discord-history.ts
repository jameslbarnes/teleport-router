/** Recent messages of one Discord text channel, read from Discord when asked. Nothing is kept. */
export type DiscordChatMessage = {
  id: string;
  channelId: string;
  authorId: string;
  /** The name Discord shows for the author. Text typed by its owner; untrusted. */
  author: string;
  /** Bots, apps and webhooks. Their messages can repeat private notes, so callers leave them out. */
  automated: boolean;
  content: string;
  timestamp: number;
  url: string;
};
export type DiscordHistory = {channelName: string; messages: DiscordChatMessage[]};
export type DiscordHistoryReader = (guildId: string, channelId: string, limit?: number) => Promise<DiscordHistory>;
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);
const unavailable = () => new Error('Discord history unavailable');

/**
 * Newest first, ordinary messages and replies only, up to `limit` (at most 500), 100 at a time:
 * https://docs.discord.com/developers/resources/message#get-channel-messages
 * Discord has no search for bots, so a caller filters what this returns. Reading message text over
 * REST needs the bot's Message Content intent. Any unreadable answer fails the whole read.
 */
export function discordHistory(token: string | undefined, request: typeof fetch = fetch): DiscordHistoryReader {
  return async (guildId, channelId, limit = 300) => {
    if (!token || !snowflake(guildId) || !snowflake(channelId)) throw unavailable();
    const signal = AbortSignal.timeout(15000);
    async function get(path: string): Promise<any> {
      const response = await request(`https://discord.com/api/v10${path}`, {
        headers: {Authorization: `Bot ${token}`}, redirect: 'error', signal,
      });
      if (!response.ok) throw unavailable();
      return response.json();
    }
    const channel = await get(`/channels/${channelId}`);
    if (channel?.guild_id !== guildId || channel.id !== channelId || channel.type !== 0 || typeof channel.name !== 'string') throw unavailable();
    const wanted = Math.max(1, Math.min(500, Math.floor(limit)));
    const messages: DiscordChatMessage[] = [];
    let before = '';
    for (let page = 0; page < 5 && messages.length < wanted; page++) {
      const batch = await get(`/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ''}`);
      if (!Array.isArray(batch) || batch.length > 100) throw unavailable();
      for (const m of batch) {
        const at = Date.parse(m?.timestamp);
        if (!snowflake(m?.id) || !snowflake(m?.author?.id) || m.channel_id !== channelId || !Number.isFinite(at)) throw unavailable();
        // 0 is an ordinary message and 19 a reply. Joins, pins, boosts and command output are not conversation.
        if ((m.type !== 0 && m.type !== 19) || typeof m.content !== 'string' || !m.content.trim()) continue;
        const name = [m.author.global_name, m.author.username].find(n => typeof n === 'string' && n.trim());
        messages.push({id: m.id, channelId, authorId: m.author.id, author: String(name || 'Discord member').replace(/[\u0000-\u001f]/g, ' ').slice(0, 80),
          automated: m.author.bot === true || m.webhook_id != null || m.application_id != null,
          content: m.content.slice(0, 4000), timestamp: at, url: `https://discord.com/channels/${guildId}/${channelId}/${m.id}`});
      }
      if (batch.length < 100) break;
      before = batch[batch.length - 1].id;
    }
    return {channelName: channel.name.slice(0, 100), messages: messages.slice(0, wanted)};
  };
}
