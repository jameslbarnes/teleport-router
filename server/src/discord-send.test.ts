import {describe, it, expect} from 'vitest';
import {discordSender} from './discord-send.js';

describe('Posting a message to a Discord channel',()=>{
  function fake() {
    const requests: {url: string; init: RequestInit}[] = [];
    const send = discordSender('bot-token', (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({url: String(url), init: init!});
      return new Response(JSON.stringify({id: '100000000000000200'}));
    }) as typeof fetch);
    return {send, requests, body: (i: number) => JSON.parse(String(requests[i].init.body))};
  }
  const content = '**@alice** (<@100000000000000003>) · for <@100000000000000004>, @everyone and <@&100000000000000005>';

  it('notifies only the accounts it is asked to, and shows no link previews',async()=>{
    const {send, requests, body} = fake();
    expect(await send('100000000000000040', content, ['100000000000000003'])).toBe('100000000000000200');
    expect(requests[0].url).toBe('https://discord.com/api/v10/channels/100000000000000040/messages');
    // Every tag stays in the text, so Discord shows the names; only the author's tag notifies.
    expect(body(0)).toEqual({content, allowed_mentions: {parse: [], users: ['100000000000000003']}, flags: 4});
    await send('100000000000000040', content);
    expect(body(1)).toEqual({content, allowed_mentions: {parse: []}, flags: 4});
  });
  it('sends nothing when asked to notify something that is not a Discord account',async()=>{
    const {send, requests} = fake();
    for (const notify of [['everyone'], ['&100000000000000005'], ['100000000000000003', 'roles'], Array(101).fill('100000000000000003')])
      await expect(send('100000000000000040', content, notify)).rejects.toThrow('not sent');
    expect(requests).toHaveLength(0);
  });
});
