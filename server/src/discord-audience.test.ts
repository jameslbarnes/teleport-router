import {describe,it,expect} from 'vitest';
import {discordAudience} from './discord-audience.js';

const guild='100000000000000001', channel='100000000000000002', owner='100000000000000003', bot='100000000000000004';
const newcomer='100000000000000005', linked='100000000000000006', admin='100000000000000007';
const memberRole='100000000000000020', botRole='100000000000000021', adminRole='100000000000000022';
const VIEW='1024', ADMIN='8';
const members=`/guilds/${guild}/members?limit=1000&after=0`;
/** A gated server: @everyone is denied the channel, the member role and the bot's role are allowed. */
function fixture(overrides: Record<string,unknown> = {}) {
  const calls: string[]=[];
  const bodies: Record<string,unknown> = {
    '/users/@me':{id:bot,bot:true},
    [`/guilds/${guild}`]:{id:guild,owner_id:owner,roles:[{id:guild,permissions:VIEW},{id:memberRole,permissions:'0'},
      {id:botRole,permissions:'0'},{id:adminRole,permissions:ADMIN}]},
    [`/channels/${channel}`]:{id:channel,guild_id:guild,type:0,permission_overwrites:[
      {id:guild,type:0,allow:'0',deny:VIEW},{id:memberRole,type:0,allow:VIEW,deny:'0'},{id:botRole,type:0,allow:VIEW,deny:'0'}]},
    [members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]}], ...overrides,
  };
  const request = (async(url: string, init: RequestInit) => {
    const path=url.replace('https://discord.com/api/v10','');calls.push(path);
    expect(init.redirect).toBe('error'); expect(init.signal).toBeTruthy();
    expect((init.headers as any).Authorization).toBe('Bot synthetic');
    return new Response(JSON.stringify(bodies[path]), {status:path in bodies?200:403});
  }) as typeof fetch;
  return {read:discordAudience('synthetic',request),calls,bodies};
}
describe('Fresh Discord audience of one channel',()=>{
  it('counts the people who can see the channel, not everyone in the server',async()=>{
    const f=fixture({[members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]},
      {user:{id:newcomer},roles:[]},{user:{id:linked},roles:[memberRole]},{user:{id:admin},roles:[adminRole]}]});
    // The owner and an administrator see every channel; the newcomer with no role does not.
    expect(await f.read(guild,channel)).toEqual({botId:bot,viewerIds:[owner,bot,linked,admin],open:false});
  });
  it('applies overwrites in the order Discord does: @everyone, then roles (allow wins), then the member',async()=>{
    const hidden='100000000000000023';
    const f=fixture({
      [`/guilds/${guild}`]:{id:guild,owner_id:owner,roles:[{id:guild,permissions:VIEW},{id:memberRole,permissions:'0'},
        {id:botRole,permissions:'0'},{id:hidden,permissions:'0'}]},
      [`/channels/${channel}`]:{id:channel,guild_id:guild,type:0,permission_overwrites:[
        {id:guild,type:0,allow:'0',deny:VIEW},{id:memberRole,type:0,allow:VIEW,deny:'0'},{id:botRole,type:0,allow:VIEW,deny:'0'},
        {id:hidden,type:0,allow:'0',deny:VIEW},{id:newcomer,type:1,allow:VIEW,deny:'0'},{id:linked,type:1,allow:'0',deny:VIEW}]},
      [members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]},
        {user:{id:newcomer},roles:[]},                    // own overwrite lets them in
        {user:{id:linked},roles:[memberRole]},            // own overwrite keeps them out
        {user:{id:admin},roles:[memberRole,hidden]}]});   // one role allows, one denies: allow wins
    expect((await f.read(guild,channel)).viewerIds).toEqual([owner,bot,newcomer,admin]);
  });
  it('reports a channel that anyone joining would see',async()=>{
    const f=fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type:0,permission_overwrites:[]},
      [members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]},{user:{id:newcomer},roles:[]}]});
    expect(await f.read(guild,channel)).toEqual({botId:bot,viewerIds:[owner,bot,newcomer],open:true});
  });
  it('paginates instead of mistaking the first 1000 members for the whole server',async()=>{
    const first=[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]},
      ...Array.from({length:998},(_,i)=>({user:{id:String(BigInt(bot)+BigInt(i+1))},roles:[memberRole]}))];
    const last=first.at(-1)!.user.id;
    const f=fixture({[members]:first,
      [`/guilds/${guild}/members?limit=1000&after=${last}`]:[{user:{id:String(BigInt(last)+1n)},roles:[memberRole]}]});
    expect((await f.read(guild,channel)).viewerIds).toHaveLength(1001);
  });
  it('fails closed for inaccessible or incomplete membership, wrong guild, threads and announcements',async()=>{
    for(const body of [[], [{user:{id:owner},roles:[]}], {error:'forbidden'}, [{user:{id:owner},roles:[]},{user:{id:owner},roles:[]}]])
      await expect(fixture({[members]:body}).read(guild,channel)).rejects.toThrow();
    for(const type of [1,5,10,11,12,15])
      await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type,permission_overwrites:[]}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:'100000000000000009',type:0,permission_overwrites:[]}}).read(guild,channel)).rejects.toThrow();
  });
  it('fails closed when roles or overwrites cannot be read in full, or the bot cannot see the channel',async()=>{
    await expect(fixture({[`/guilds/${guild}`]:{id:guild,owner_id:owner}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type:0}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[members]:[{user:{id:owner}},{user:{id:bot},roles:[botRole]}]}).read(guild,channel)).rejects.toThrow();
    // A member holds a role the server did not list.
    await expect(fixture({[members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[botRole]},
      {user:{id:linked},roles:['100000000000000099']}]}).read(guild,channel)).rejects.toThrow();
    // An overwrite of an unknown kind, or with unreadable permissions.
    await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type:0,permission_overwrites:[{id:guild,type:2,allow:'0',deny:'0'}]}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[`/channels/${channel}`]:{id:channel,guild_id:guild,type:0,permission_overwrites:[{id:guild,type:0,allow:1024,deny:'0'}]}}).read(guild,channel)).rejects.toThrow();
    await expect(fixture({[members]:[{user:{id:owner},roles:[]},{user:{id:bot},roles:[]}]}).read(guild,channel)).rejects.toThrow();
  });
  it('never sends a credential to a caller-selected URL or works without its own credential',async()=>{
    const f=fixture();await expect(f.read('https://elsewhere.test',channel)).rejects.toThrow();expect(f.calls).toHaveLength(0);
    await expect(discordAudience(undefined)(guild,channel)).rejects.toThrow();
  });
});
