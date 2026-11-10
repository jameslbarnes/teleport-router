import {describe,it,expect} from 'vitest';
import {discordAudience} from './discord-audience.js';

const guild='100000000000000001', channel='100000000000000002', owner='100000000000000003', bot='100000000000000004';
function fixture(overrides: Record<string,unknown> = {}) {
  const calls: string[]=[];
  const bodies: Record<string,unknown> = {
    '/users/@me':{id:bot,bot:true}, [`/guilds/${guild}`]:{id:guild,owner_id:owner},
    [`/channels/${channel}`]:{id:channel,guild_id:guild,type:0},
    [`/guilds/${guild}/members?limit=1000&after=0`]:[{user:{id:owner}},{user:{id:bot}}], ...overrides,
  };
  const request = (async(url: string, init: RequestInit) => {
    const path=url.replace('https://discord.com/api/v10','');calls.push(path);
    expect(init.redirect).toBe('error'); expect(init.signal).toBeTruthy();
    expect((init.headers as any).Authorization).toBe('Bot synthetic');
    return new Response(JSON.stringify(bodies[path]), {status:path in bodies?200:403});
  }) as typeof fetch;
  return {read:discordAudience('synthetic',request),calls,bodies};
}
describe('Fresh whole-server Discord audience',()=>{
  it('includes every member, owner and bots, without relying on channel caches',async()=>{
    const f=fixture();expect(await f.read(guild,channel)).toEqual({botId:bot,memberIds:[owner,bot]});
    f.bodies[`/guilds/${guild}/members?limit=1000&after=0`]=[{user:{id:owner}},{user:{id:bot}},{user:{id:'100000000000000005'}}];
    expect((await f.read(guild,channel)).memberIds).toHaveLength(3);
  });
  it('paginates instead of mistaking the first 1000 members for the whole audience',async()=>{
    const first=Array.from({length:1000},(_,i)=>({user:{id:String(BigInt(owner)+BigInt(i))}}));
    const last=first.at(-1)!.user.id;
    const f=fixture({[`/guilds/${guild}/members?limit=1000&after=0`]:first,
      [`/guilds/${guild}/members?limit=1000&after=${last}`]:[{user:{id:String(BigInt(last)+1n)}}]});
    expect((await f.read(guild,channel)).memberIds).toHaveLength(1001);
  });
  it('fails closed for inaccessible or incomplete membership, wrong guild, threads and announcements',async()=>{
    for(const body of [[], [{user:{id:owner}}], {error:'forbidden'}, [{user:{id:owner}},{user:{id:owner}}]])
      await expect(fixture({[`/guilds/${guild}/members?limit=1000&after=0`]:body}).read(guild,channel)).rejects.toThrow();
    for(const type of [1,5,10,11,12,15])
      await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:'100000000000000009',type:0}}).read(guild,channel)).rejects.toThrow();
  });
  it('never sends a credential to a caller-selected URL or works without its own credential',async()=>{
    const f=fixture();await expect(f.read('https://elsewhere.test',channel)).rejects.toThrow();expect(f.calls).toHaveLength(0);
    await expect(discordAudience(undefined)(guild,channel)).rejects.toThrow();
  });
});
