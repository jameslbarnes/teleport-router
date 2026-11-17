import {describe, it, expect} from 'vitest';
import {discordSender} from './discord-send.js';

describe('Posting a message to a Discord channel',()=>{
  it('shows a tag but lets no mention notify anyone, and shows no link previews',async()=>{
    const requests: {url: string; init: RequestInit}[] = [];
    const send = discordSender('bot-token', (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({url: String(url), init: init!});
      return new Response(JSON.stringify({id: '100000000000000200'}));
    }) as typeof fetch);
    const content = '**@alice** (<@100000000000000003>) · note text with @everyone and <@&100000000000000005>';
    expect(await send('100000000000000040', content)).toBe('100000000000000200');
    expect(requests[0].url).toBe('https://discord.com/api/v10/channels/100000000000000040/messages');
    // The tag stays in the text, so Discord shows the name; an empty parse list means it notifies nobody.
    expect(JSON.parse(String(requests[0].init.body))).toEqual({content, allowed_mentions: {parse: []}, flags: 4});
  });
});
