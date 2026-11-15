/** Posts one message to a Discord text channel as the bot. Used by a private group's feed channel. */
export type DiscordSender = (channelId: string, content: string) => Promise<string>;
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);

/**
 * https://docs.discord.com/developers/resources/message#create-message
 * Other people's text must not notify anyone or unfurl a link: no mentions are allowed and embeds are
 * suppressed (flag 4). Returns the new message's ID; anything else is a failure.
 */
export function discordSender(token: string | undefined, request: typeof fetch = fetch): DiscordSender {
  return async (channelId, content) => {
    if (!token || !snowflake(channelId) || !content || content.length > 2000) throw new Error('Discord message not sent');
    const response = await request(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {Authorization: `Bot ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({content, allowed_mentions: {parse: []}, flags: 4}),
    });
    if (!response.ok) throw new Error('Discord message not sent');
    const message: any = await response.json();
    if (!snowflake(message?.id)) throw new Error('Discord message not sent');
    return message.id;
  };
}
