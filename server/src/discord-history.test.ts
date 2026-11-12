import {describe, it, expect} from 'vitest';
import {discordHistory} from './discord-history.js';

const GUILD = '100000000000000001', CHANNEL = '100000000000000002';
const message = (n: number, extra: Record<string, unknown> = {}) => ({id: String(200000000000000000n + BigInt(n)), channel_id: CHANNEL, type: 0,
  content: `message ${n}`, timestamp: new Date(1_800_000_000_000 + n * 1000).toISOString(),
  author: {id: '100000000000000003', username: 'ada', global_name: 'Ada'}, ...extra});

function discord(pages: unknown[][], channel: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const request = (async (url: string, init: any) => {
    calls.push(url.replace('https://discord.com/api/v10', ''));
    expect(init.headers.Authorization).toBe('Bot synthetic');
    const body = url.endsWith(`/channels/${CHANNEL}`) ? {id: CHANNEL, guild_id: GUILD, type: 0, name: 'general', ...channel} : pages.shift();
    return {ok: body !== undefined, json: async () => body};
  }) as unknown as typeof fetch;
  return {read: discordHistory('synthetic', request), calls};
}

describe('Reading a Discord channel\'s recent messages', () => {
  it('returns ordinary messages and replies newest first, with a link, and marks automated authors', async () => {
    const d = discord([[message(3, {type: 19}), message(2, {author: {id: '100000000000000090', username: 'router', bot: true}}),
      message(1, {type: 7}), message(0, {content: '   '}), message(-1, {webhook_id: '100000000000000050'})]]);
    const result = await d.read(GUILD, CHANNEL);
    expect(result.channelName).toBe('general');
    expect(result.messages.map(m => [m.content, m.automated])).toEqual([['message 3', false], ['message 2', true], ['message -1', true]]);
    expect(result.messages[0]).toMatchObject({author: 'Ada', authorId: '100000000000000003', channelId: CHANNEL,
      url: `https://discord.com/channels/${GUILD}/${CHANNEL}/${result.messages[0].id}`, timestamp: 1_800_000_003_000});
  });
  it('pages back with the oldest ID until the limit, and stops when Discord runs out', async () => {
    const first = Array.from({length: 100}, (_, i) => message(300 - i)), second = Array.from({length: 40}, (_, i) => message(200 - i));
    const d = discord([first, second]);
    const result = await d.read(GUILD, CHANNEL, 120);
    expect(result.messages).toHaveLength(120);
    expect(d.calls[2]).toBe(`/channels/${CHANNEL}/messages?limit=100&before=${first[99].id}`);
    expect(d.calls).toHaveLength(3);
  });
  it('fails the whole read on another server\'s channel, a non-text channel, a refusal or a malformed message', async () => {
    await expect(discord([[message(1)]], {guild_id: '100000000000000099'}).read(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discord([[message(1)]], {type: 5}).read(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discord([]).read(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discord([[message(1, {channel_id: '100000000000000077'})]]).read(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discord([[message(1, {timestamp: 'never'})]]).read(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discordHistory(undefined)(GUILD, CHANNEL)).rejects.toThrow('unavailable');
    await expect(discord([[message(1)]]).read(GUILD, 'general')).rejects.toThrow('unavailable');
  });
});
