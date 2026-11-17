/**
 * Posts one message to a Discord text channel as the bot. Used by a private group's feed channel.
 * `notify` lists the Discord accounts this message may notify, when it tags them; nobody else is notified.
 */
export type DiscordSender = (channelId: string, content: string, notify?: string[]) => Promise<string>;
const snowflake = (v: unknown): v is string => typeof v === 'string' && /^\d{16,22}$/.test(v);

/**
 * https://docs.discord.com/developers/resources/message#create-message
 * Other people's text must not notify anyone or unfurl a link: only the accounts the caller names in
 * `notify` are notified, and only where the message tags them. @everyone, roles and anyone else tagged
 * in the text are not, and embeds are suppressed (flag 4). Returns the new message's ID; anything else is a failure.
 * https://docs.discord.com/developers/resources/message#allowed-mentions-object
 */
export function discordSender(token: string | undefined, request: typeof fetch = fetch): DiscordSender {
  return async (channelId, content, notify = []) => {
    if (!token || !snowflake(channelId) || !content || content.length > 2000
      || notify.length > 100 || !notify.every(snowflake)) throw new Error('Discord message not sent');
    const response = await request(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
      headers: {Authorization: `Bot ${token}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({content, allowed_mentions: notify.length ? {parse: [], users: notify} : {parse: []}, flags: 4}),
    });
    if (!response.ok) throw new Error('Discord message not sent');
    const message: any = await response.json();
    if (!snowflake(message?.id)) throw new Error('Discord message not sent');
    return message.id;
  };
}
