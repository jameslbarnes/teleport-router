import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptBackup } from '../../browser/src/recovery.mjs';
import { sealAgentGrant } from '../../browser/src/pair-seal.mjs';
import { prepareAgentTraces, traceAgentKeys } from '../../browser/src/trace-agent-keys.mjs';
import { publicKeyOf, sealFull, verifiedAgentKey } from '../../plugins/teleport-router/scripts/trace-lib.mjs';
import {
  createPendingAgent, ensureUploadRules, loadAgentGrant, loadPendingAgent, openAgentGrant,
  readHexKeyFile, resolveRouterKey, saveAgentGrant, saveOwnerKeys, saveUploadRules, unlockRecoveryFile,
} from './trace-owner-auth.mjs';

const work = mkdtempSync(join(tmpdir(), 'router-trace-owner-auth-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

test('unlockRecoveryFile decrypts a Router recovery file and rejects wrong password', async () => {
  const backup = {
    format: 'router-account',
    version: 1,
    handle: 'alice_test',
    routerKey: randomBytes(32).toString('base64url'),
    tinycloudKey: `0x${randomBytes(32).toString('hex')}`,
    origin: 'https://router.teleport.computer',
  };
  const password = 'correct horse battery staple';
  const envelope = await encryptBackup(backup, password);
  const file = join(work, 'recovery.json');
  writeFileSync(file, JSON.stringify(envelope, null, 2));

  const unlocked = await unlockRecoveryFile(file, password);
  assert.equal(unlocked.handle, backup.handle);
  assert.equal(unlocked.routerKey, backup.routerKey);
  assert.equal(unlocked.tinycloudKey, backup.tinycloudKey);

  await assert.rejects(() => unlockRecoveryFile(file, 'wrong password here'), /did not open/);
});

test('resolveRouterKey prefers explicit key file, then env, then recovery file', () => {
  const keyFile = join(work, 'router.key');
  writeFileSync(keyFile, 'from-file\n');
  assert.equal(resolveRouterKey({ routerKeyFile: keyFile, env: { ROUTER_KEY: 'from-env' }, recovery: { routerKey: 'from-rec' } }), 'from-file');
  assert.equal(resolveRouterKey({ env: { ROUTER_KEY: 'from-env', CLAUDE_PLUGIN_OPTION_ROUTER_KEY: 'from-plugin' }, recovery: { routerKey: 'from-rec' } }), 'from-env');
  assert.equal(resolveRouterKey({ env: { CLAUDE_PLUGIN_OPTION_ROUTER_KEY: 'from-plugin' }, recovery: { routerKey: 'from-rec' } }), 'from-plugin');
  assert.equal(resolveRouterKey({ env: {}, recovery: { routerKey: 'from-rec' } }), 'from-rec');
  const saved = saveOwnerKeys({ dir: join(work, 'saved-keys'), routerKey: 'from-setup', ownerKey: `0x${'cd'.repeat(32)}` });
  assert.equal(resolveRouterKey({ env: {}, defaultRouterKeyFile: saved.routerFile }), 'from-setup');
  assert.equal(resolveRouterKey({ env: {} }), null);
});

test('readHexKeyFile validates 0x + 64 hex chars', () => {
  const good = join(work, 'good.key');
  const hex = `0x${'ab'.repeat(32)}`;
  writeFileSync(good, `${hex}\n`);
  assert.equal(readHexKeyFile(good, m => { throw new Error(m); }), hex);

  const bad = join(work, 'bad.key');
  writeFileSync(bad, 'not-a-key');
  assert.throws(() => readHexKeyFile(bad, m => { throw new Error(m); }), /0x and 64 hex/);
});

test('ensureUploadRules initializes missing file interactively or with --init-rules and preserves pointers flag', async () => {
  const missing = join(work, 'sub', 'rules.json');
  const refused = await ensureUploadRules(missing, { interactive: false, initRules: false });
  assert.equal(refused.ready, false);
  assert.match(refused.reason, /rules\.json/);

  const created = await ensureUploadRules(missing, { interactive: false, initRules: true });
  assert.equal(created.ready, true);
  assert.equal(created.created, true);
  assert.deepEqual(JSON.parse(readFileSync(missing, 'utf8')), { never_upload_tools: [] });

  // Preserves existing "pointers": false when adding never_upload_tools interactively.
  const pointersOnly = join(work, 'rules-pointers.json');
  writeFileSync(pointersOnly, JSON.stringify({ pointers: false }, null, 2));
  const prompted = await ensureUploadRules(pointersOnly, {
    interactive: true,
    ask: async () => 'mcp__diary__, mcp__health__',
  });
  assert.equal(prompted.ready, true);
  assert.equal(prompted.created, true);
  assert.deepEqual(JSON.parse(readFileSync(pointersOnly, 'utf8')), {
    pointers: false,
    never_upload_tools: ['mcp__diary__', 'mcp__health__'],
  });

  // Rejects prefixes shorter than 4 chars.
  const shortRule = join(work, 'rules-short.json');
  const bad = await ensureUploadRules(shortRule, {
    interactive: true,
    ask: async () => 'abc',
  });
  assert.equal(bad.ready, false);
  assert.match(bad.reason, /shorter than 4/);

  // saveUploadRules preserves pointers and deduplicates/sorts prefixes.
  const savedRules = saveUploadRules(pointersOnly, ['mcp__b_tool__', 'mcp__a_tool__', 'mcp__b_tool__']);
  assert.deepEqual(savedRules, { pointers: false, never_upload_tools: ['mcp__a_tool__', 'mcp__b_tool__'] });
});

test('sealAgentGrant (browser WebCrypto) round-trips with openAgentGrant (Node) and rejects AAD tampering', async () => {
  const dir = join(work, 'pair-dir');
  const pub = createPendingAgent(dir);
  const pending = loadPendingAgent(dir);
  assert.equal(pending.agentPublicKey, pub.agent_public_key);
  assert.match(pub.verify_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);

  const pairId = 'pair-123';
  const ownerDid = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
  const accountKey = '0x' + randomBytes(32).toString('hex');
  const accountPublicKey = publicKeyOf(accountKey);
  const space = 'tinycloud:pkh:eip155:1:0x1111111111111111111111111111111111111111:router';
  const salt = '0x' + '12'.repeat(32);
  const keys = await traceAgentKeys(accountKey, ownerDid, space, salt);
  assert(keys.traceKey !== accountKey);
  assert((await traceAgentKeys(accountKey, ownerDid, space, salt)).traceKey === keys.traceKey);
  assert((await traceAgentKeys(accountKey, ownerDid, space, '0x' + '34'.repeat(32))).traceKey !== keys.traceKey);
  assert.equal(verifiedAgentKey(keys.certificate, ownerDid, space, accountPublicKey), publicKeyOf(keys.traceKey));
  assert.throws(() => verifiedAgentKey(keys.certificate, ownerDid, space, pub.agent_public_key));
  assert.throws(() => verifiedAgentKey(keys.certificate, ownerDid, space + '-other', accountPublicKey));
  const payload = {
    v: 2,
    handle: 'alice',
    routerKey: 'router-secret-value',
    traceKey: keys.traceKey,
    accountPublicKey,
    delegation: 'serialized-delegation-blob',
    ownerDid,
    space,
    host: 'https://tee.node.tinycloud.xyz',
  };
  const sealed = await sealAgentGrant(payload, { pairId, ownerDid, agentPublicKey: pub.agent_public_key });
  const opened = openAgentGrant(sealed, { pairId, ownerDid, agentPrivateKey: pending.agentKey });
  assert.deepEqual(opened, payload);
  const context = { pairId, ownerDid, agentPublicKey: pub.agent_public_key };
  for (const rejected of [{ ...payload, v: 1 }, { ...payload, traceKey: accountKey }]) {
    const wire = await sealAgentGrant(rejected, context);
    assert.throws(() => openAgentGrant(wire, { pairId, ownerDid, agentPrivateKey: pending.agentKey }), /trace-only/);
  }

  // Wrong pairId or ownerDid fails GCM authentication.
  assert.throws(() => openAgentGrant(sealed, { pairId: 'other-pair', ownerDid, agentPrivateKey: pending.agentKey }));
  assert.throws(() => openAgentGrant(sealed, { pairId, ownerDid: 'did:pkh:eip155:1:0x2222222222222222222222222222222222222222', agentPrivateKey: pending.agentKey }));

  // An upgrade refuses the older file, then replaces it on successful pairing.
  writeFileSync(join(dir, 'agent-grant.json'), JSON.stringify({ v: 1, traceKey: accountKey }), { mode: 0o600 });
  assert.throws(() => loadAgentGrant(dir), /Delete this local authorization or pair again/);
  saveAgentGrant(dir, { ...opened, agentKey: pending.agentKey, agentDid: pending.agentDid });
  assert.equal(loadPendingAgent(dir), null);
  assert.equal(loadAgentGrant(dir).traceKey, payload.traceKey);
});

test('preparing older traces preserves what worked and reports individual failures on retry', async () => {
  const accountKey = '0x' + randomBytes(32).toString('hex');
  const ownerDid = 'did:pkh:eip155:1:0x1111111111111111111111111111111111111111';
  const keys = await traceAgentKeys(accountKey, ownerDid, 'fixture', '0x' + '12'.repeat(32));
  const records = new Map(), stored = new Map();
  for (const id of ['old', 'new']) {
    const { meta } = sealFull(Buffer.from(id), { ownerDid, entryId: id }, publicKeyOf(accountKey),
      id === 'new' ? keys.certificate.publicKey : undefined);
    records.set(id, { ownerDid, entryId: id, full: meta });
  }
  const api = async (path, input) => path === '/api/traces/list'
    ? { entry_ids: ['old', 'damaged', 'new'] } : records.get(input.entry_id);
  let writes = 0;
  const owner = { did: ownerDid, kv: {
    get: async path => stored.has(path) ? { ok: true, data: { data: stored.get(path) } }
      : { ok: false, error: { code: 'KV_NOT_FOUND', message: 'Key not found: ' + path } },
    put: async (path, value) => { writes++; stored.set(path, value); return { ok: true }; },
  } };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.deepEqual(await prepareAgentTraces(api, owner, accountKey, keys), ['damaged']);
    assert.equal(writes, 1);
  }
});
