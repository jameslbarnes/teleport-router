import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const file = process.argv[2] || 'docker-compose.template.yml';
const env = { ...process.env, GIT_SHA: 'ci',
  IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, AGENT_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
  DISCORD_IMAGE_DIGEST: `sha256:${'c'.repeat(64)}` };
const config = JSON.parse(execFileSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], { env, encoding: 'utf8' }));
const bot = config.services['discord-bot'];
assert.match(bot.image, /teleport-router-discord:.*@sha256:[a-f0-9]{64}$/);
assert.equal(bot.user, '10000:10000');
assert.equal(bot.read_only, true);
assert.equal(bot.mem_limit, 512 * 1024 * 1024);
assert.equal(Number(bot.cpus), 0.5);
assert.equal(bot.memswap_limit, bot.mem_limit);
assert.equal(bot.ports, undefined);
assert.equal(bot.privileged, undefined);
assert.deepEqual(bot.cap_drop, ['ALL']);
assert.deepEqual(bot.volumes.map(v => [v.source, v.target]), [['discord-data', '/data']]);
const allowed = ['DISCORD_BOT_TOKEN', 'DISCORD_MODEL_API_KEY', 'DISCORD_PUBLIC_ROUTER_KEY', 'DISCORD_PRIVATE_ROUTER_KEY', 'DISCORD_INITIAL_LINKS_B64'];
assert.deepEqual(Object.keys(bot.environment).sort(), allowed.sort());
for (const [name, service] of Object.entries(config.services)) {
  if (name === 'discord-bot') continue;
  assert(!service.volumes?.some(v => v.source === 'discord-data'), `${name} must not mount Discord state`);
  assert(!Object.keys(service.environment || {}).some(key => allowed.includes(key)), `${name} must not receive Discord credentials`);
}
console.log('Discord has its own image, volume, credentials and resource limits; no inbound ports or host sockets.');
