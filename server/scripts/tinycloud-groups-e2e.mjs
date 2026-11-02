// End-to-end check of groups stored on TinyCloud, against the real hosted node.
//
// Starts a local Router (memory storage, TINYCLOUD_GROUPS=tinycloud), creates an
// owner and a Router identity on TinyCloud with fresh throwaway keys, has the
// owner grant the Router one group's folder, posts a skill card, reads it as a
// member, confirms it sits in the owner's space, then revokes the grant and
// confirms the Router reports the revocation. Test data only; keys are random
// per run and never printed.
//
// Usage (from server/): node scripts/tinycloud-groups-e2e.mjs
//   KEEP_RUNNING=1  leave the Router up after the check (for a demo)
//   ROUTER_HOST=0.0.0.0 or a tailnet IP to listen on (default 127.0.0.1)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { TinyCloudNode, serializeDelegation } from '@tinycloud/node-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

const HOST = process.env.TINYCLOUD_HOST || 'https://tee.node.tinycloud.xyz';
const PORT = Number(process.env.PORT || 9000 + Math.floor(Math.random() * 900));
const LISTEN = process.env.ROUTER_HOST || '127.0.0.1';
const BASE = `http://${LISTEN === '0.0.0.0' ? '127.0.0.1' : LISTEN}:${PORT}`;
const GROUP = process.env.GROUP_ID || `skills-${Date.now().toString(36).slice(-5)}`;
const ACTIONS = ['tinycloud.kv/get', 'tinycloud.kv/put', 'tinycloud.kv/list', 'tinycloud.kv/del'];
const hexKey = () => '0x' + randomBytes(32).toString('hex');
const routerKey = () => randomBytes(32).toString('base64url'); // Router identity keys (not TinyCloud)

let failures = 0;
const check = (label, cond, detail = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) failures++;
};
const step = (s) => console.log(`\n== ${s}`);
const json = async (res) => { try { return await res.json(); } catch { return null; } };
const post = (path, body) => fetch(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function waitForRouter() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/entries`)).ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('Router did not start');
}

step('Start a local Router with TinyCloud groups');
const moderator = `mod${Date.now().toString(36).slice(-5)}`;
const server = spawn('npx', ['tsx', 'src/http.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT), LISTEN_HOST: LISTEN,
    STAGED_STORAGE: 'memory', STAGING_DELAY_MS: '3600000',
    MODERATOR_HANDLES: moderator,
    TINYCLOUD_GROUPS: 'tinycloud', TINYCLOUD_ROUTER_KEY: hexKey(), TINYCLOUD_HOST: HOST,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: true,
});
server.stderr.on('data', d => { const line = String(d).trim(); if (/error/i.test(line) && !/ExperimentalWarning/.test(line)) console.error(`[router] ${line.slice(0, 300)}`); });
const stop = () => { try { server.kill('SIGTERM'); } catch {} };
process.on('exit', stop);
await waitForRouter();

const routerInfo = await json(await fetch(`${BASE}/api/tinycloud/router`));
check('Router publishes the TinyCloud identity owners grant access to', !!routerInfo?.did, routerInfo?.did?.slice(0, 24));

step('Owner signs in to TinyCloud and grants the Router this group\'s folder only');
const owner = new TinyCloudNode({ privateKey: hexKey(), host: HOST, prefix: 'router-groups', autoCreateSpace: true });
await owner.signIn();
const folder = `groups/${GROUP}/`;
const grant = await owner.createDelegation({ delegateDID: routerInfo.did, path: folder, actions: ACTIONS, expiryMs: 24 * 3600 * 1000, includePublicSpace: false });
check('grant created', !!grant?.cid, `space ${String(grant?.spaceId).slice(-14)}, folder ${grant?.path}`);

step('Router identities: the owner (group admin) and a member');
const ownerKey = routerKey(), memberKey = routerKey();
const ownerHandle = `own${Date.now().toString(36).slice(-6)}`, memberHandle = `mem${Date.now().toString(36).slice(-6)}`;
for (const [secret_key, handle] of [[ownerKey, ownerHandle], [memberKey, memberHandle]]) {
  const r = await post('/api/identity/register', { secret_key, handle });
  check(`registered @${handle}`, r.ok, r.ok ? '' : await r.text());
}

step('Create the group on TinyCloud with the owner\'s grant');
const wrongFolder = await post('/api/channels', { secret_key: ownerKey, id: `${GROUP}x`, name: 'Wrong folder', storage: 'tinycloud', tinycloud_delegation: serializeDelegation(grant) });
check('a grant for a different folder is refused', wrongFolder.status === 400, (await json(wrongFolder))?.error);
const created = await post('/api/channels', { secret_key: ownerKey, id: GROUP, name: 'Skills cohort (demo)', storage: 'tinycloud', tinycloud_delegation: serializeDelegation(grant) });
const channel = await json(created);
check('group created', created.status === 201, channel?.error || `#${GROUP}, invite-only=${channel?.joinRule === 'invite'}`);

const invite = await json(await post(`/api/channels/${GROUP}/invite`, { secret_key: ownerKey }));
const joined = await post(`/api/channels/${GROUP}/join`, { secret_key: memberKey, invite_token: invite?.token });
check('member joined with an invite', joined.ok, joined.ok ? '' : (await json(joined))?.error);

step('Owner posts a skill card to the group and publishes it');
const card = [
  'Skill card: demo-placeholder v0.1 (not a real bundle)',
  'Bundle: sha256 0000…placeholder · shared from the owner\'s TinyCloud space',
  'Evidence from the owner\'s own bench: placeholder numbers for this dry run.',
].join('\n');
const mcp = new Client({ name: 'groups-e2e', version: '0' });
await mcp.connect(new SSEClientTransport(new URL(`${BASE}/mcp/sse?key=${ownerKey}`)));
const wrote = await mcp.callTool({ name: 'router_write_entry', arguments: { sensitivity_check: 'Test data only. I, Claude, certify I am completing this check before writing my entry.', client: 'code', entry: card, to: [`#${GROUP}`], search_keywords: ['demo'] } });
const entryId = (wrote.content?.[0]?.text || '').match(/Entry ID: (\S+)/)?.[1];
check('card staged (waiting, visible only to its author)', !!entryId);
const published = await json(await post(`/api/entries/${entryId}/publish?key=${ownerKey}`, {}));
const postId = published?.entry?.id;
check('card published into the group', !!postId, postId);

step('Member reads the group; the card lives in the owner\'s TinyCloud space');
const feed = await json(await fetch(`${BASE}/api/channels/${GROUP}/entries?secret_key=${memberKey}`));
check('member sees the card in the group feed', !!feed?.entries?.some(e => e.content === card));
const outsider = await fetch(`${BASE}/api/channels/${GROUP}/entries`);
check('non-members cannot read the group', outsider.status === 401, `HTTP ${outsider.status}`);
const publicFeed = await json(await fetch(`${BASE}/api/entries?limit=200`));
check('the card is not in the public feed', !publicFeed?.entries?.some(e => e.content === card));
const inSpace = await owner.kv.get(`${folder}posts/${postId}`);
const stored = inSpace?.ok ? (typeof inSpace.data?.data === 'string' ? inSpace.data.data : JSON.stringify(inSpace.data?.data ?? inSpace.data)) : '';
check('the post is stored in the owner\'s TinyCloud space', stored.includes('demo-placeholder'), inSpace?.ok ? `${folder}posts/${postId}` : inSpace?.error?.message);

// Demo mode: leave the Router up, write the member's view URL to DEMO_DIR/url.txt,
// revoke when DEMO_DIR/revoke appears, and stop when DEMO_DIR/stop appears (or after 2 hours).
const DEMO_DIR = process.env.DEMO_DIR;
const exists = async (p) => { try { await import('node:fs/promises').then(f => f.access(p)); return true; } catch { return false; } };
const waitFor = async (p, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (await exists(p)) return true; await new Promise(r => setTimeout(r, 1000)); } return false; };
if (DEMO_DIR) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir(DEMO_DIR, { recursive: true });
  // A throwaway member identity on a local test Router, so it is fine in a local file
  await writeFile(`${DEMO_DIR}/url.txt`, `${BASE}/?view=channel&id=${encodeURIComponent(GROUP)}&key=${encodeURIComponent(memberKey)}\n`, { mode: 0o600 });
  console.log(`\nDEMO: Router up at ${BASE}, group #${GROUP}. Member view URL written to ${DEMO_DIR}/url.txt. Waiting for ${DEMO_DIR}/revoke …`);
  await waitFor(`${DEMO_DIR}/revoke`, 2 * 3600 * 1000);
}

step('Owner revokes the Router\'s grant');
await owner.revokeDelegation(grant.cid);
const afterRevoke = await fetch(`${BASE}/api/channels/${GROUP}/entries?secret_key=${memberKey}`);
const revokedBody = await json(afterRevoke);
check('the Router reports the revocation instead of serving the card', afterRevoke.status === 410, revokedBody?.error);
const single = await fetch(`${BASE}/api/entry/${postId}?key=${memberKey}`);
check('the single post is gone from the Router\'s view', single.status === 404, `HTTP ${single.status}`);
const ownerStill = await owner.kv.get(`${folder}posts/${postId}`);
check('the owner still has the post in their own space', !!ownerStill?.ok);

if (DEMO_DIR) {
  console.log(`DEMO: revoked. The Router stays up so the member view shows it; waiting for ${DEMO_DIR}/stop …`);
  await waitFor(`${DEMO_DIR}/stop`, 2 * 3600 * 1000);
}

await mcp.close().catch(() => {});
stop();
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 300);
