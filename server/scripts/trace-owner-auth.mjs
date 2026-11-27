// Key resolution, browser-authorized agent grants, encrypted recovery-file unlocking, and rules.json
// setup for trace-app-owner.mjs. Private keys stay local and are never passed on argv or printed.
import { createDecipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computeAddress, SigningKey } from 'ethers';
import { decryptBackup } from '../../browser/src/recovery.mjs';

const unb64 = (value, exactBytes) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('Invalid base64url field in sealed agent grant.');
  const out = Buffer.from(value, 'base64url');
  if (out.toString('base64url') !== value || (exactBytes !== undefined && out.length !== exactBytes)) {
    throw new Error('Malformed field in sealed agent grant.');
  }
  return out;
};

/** Read a 32-byte 0x-prefixed hex private key from a file. */
export function readHexKeyFile(file, fail) {
  const k = readFileSync(file, 'utf8').trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) fail(`${file} must hold 0x and 64 hex characters.`);
  return k;
}

/**
 * Resolve the Router account key from explicit flags, environment (including Claude Code plugin config),
 * an authorized local agent grant, an unlocked recovery file, or the default key file created by `setup`.
 */
export function resolveRouterKey({ routerKeyFile, env = process.env, agentGrant = null, recovery = null, defaultRouterKeyFile = null } = {}) {
  if (routerKeyFile) return readFileSync(routerKeyFile, 'utf8').trim();
  const fromEnv = (env.ROUTER_KEY || env.CLAUDE_PLUGIN_OPTION_ROUTER_KEY || '').trim();
  if (fromEnv) return fromEnv;
  if (agentGrant?.routerKey) return String(agentGrant.routerKey).trim();
  if (recovery?.routerKey) return String(recovery.routerKey).trim();
  if (defaultRouterKeyFile && existsSync(defaultRouterKeyFile)) {
    const saved = readFileSync(defaultRouterKeyFile, 'utf8').trim();
    if (saved) return saved;
  }
  return null;
}

/** Save unlocked keys from `setup` with owner-only permissions. */
export function saveOwnerKeys({ dir, routerKey, ownerKey }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const routerFile = join(dir, 'router.key');
  const ownerFile = join(dir, 'owner.key');
  writeFileSync(routerFile, `${routerKey.trim()}\n`, { mode: 0o600 });
  writeFileSync(ownerFile, `${ownerKey.trim()}\n`, { mode: 0o600 });
  return { routerFile, ownerFile };
}

export function verifyCodeFor(publicKey) {
  const hex = createHash('sha256').update(String(publicKey).toLowerCase(), 'utf8').digest('hex').slice(0, 8).toUpperCase();
  return `${hex.slice(0, 4)}-${hex.slice(4)}`;
}

/** Generate a fresh local agent secp256k1 keypair and persist it as pending until browser pairing completes. */
export function createPendingAgent(dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const agentKey = '0x' + randomBytes(32).toString('hex');
  const agentPublicKey = new SigningKey(agentKey).compressedPublicKey;
  const agentDid = 'did:pkh:eip155:1:' + computeAddress(agentPublicKey);
  const verifyCode = verifyCodeFor(agentPublicKey);
  const file = join(dir, 'agent-pending.json');
  writeFileSync(file, JSON.stringify({
    v: 1, agentKey, agentPublicKey, agentDid, verifyCode, createdAt: new Date().toISOString(),
  }, null, 2) + '\n', { mode: 0o600 });
  return { key_version: 2, agent_public_key: agentPublicKey, agent_did: agentDid, verify_code: verifyCode };
}

export function loadPendingAgent(dir) {
  const file = join(dir, 'agent-pending.json');
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.v !== 1 || !/^0x[0-9a-fA-F]{64}$/.test(parsed.agentKey || '')) throw new Error('Pending agent key file is malformed.');
  return parsed;
}

export function saveAgentGrant(dir, grant) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, 'agent-grant.json');
  const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    writeFileSync(temp, JSON.stringify(grant, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, file);
  } finally { rmSync(temp, { force: true }); }
  const pending = join(dir, 'agent-pending.json');
  if (existsSync(pending)) rmSync(pending, { force: true });
  return file;
}

export function loadAgentGrant(dir) {
  const file = join(dir, 'agent-grant.json');
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (parsed?.v === 1)
    throw new Error(`Older pairing saved an account private key in ${file}. Delete this local authorization or pair again to replace it. Keep your encrypted recovery backup. Any previous copies of that private key still work.`);
  requireTraceOnlyGrant(parsed);
  if (!/^0x[0-9a-fA-F]{64}$/.test(parsed.agentKey || '')
      || typeof parsed.delegation !== 'string' || !parsed.ownerDid || !parsed.space || !parsed.host) {
    throw new Error(`Saved agent authorization in ${file} is malformed. Re-authorize your agent.`);
  }
  return parsed;
}

function requireTraceOnlyGrant(data) {
  if (data?.v !== 2) throw new Error('This authorization predates trace-only keys. Pair this machine again in your browser.');
  if (!/^0x(?:02|03)[a-f0-9]{64}$/.test(data.accountPublicKey || '') || !/^0x[a-f0-9]{64}$/.test(data.traceKey || ''))
    throw new Error('Missing trace-only key or account public key.');
  const tracePublic = new SigningKey(data.traceKey).compressedPublicKey;
  if (tracePublic === data.accountPublicKey || ('did:pkh:eip155:1:' + computeAddress(tracePublic)).toLowerCase() === String(data.ownerDid).toLowerCase())
    throw new Error('The authorization contains an account key in place of a trace-only key.');
}

/** Open the browser-sealed agent authorization payload using the local agent's private key. */
export function openAgentGrant(sealed, { pairId, ownerDid, agentPrivateKey }) {
  if (!sealed || typeof sealed !== 'object') throw new Error('Missing sealed agent grant.');
  if (!/^0x(?:02|03)[0-9a-fA-F]{64}$/.test(sealed.ephemeralPublicKey || '')) throw new Error('Invalid ephemeral key in sealed agent grant.');
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(agentPrivateKey.replace(/^0x/, ''), 'hex'));
  const agentPublicKey = '0x' + ecdh.getPublicKey('hex', 'compressed');
  const aad = Buffer.from(JSON.stringify([
    'teleport-router/trace-agent-pair/v1',
    String(pairId),
    String(ownerDid).toLowerCase(),
    agentPublicKey,
  ]), 'utf8');
  const secret = ecdh.computeSecret(Buffer.from(sealed.ephemeralPublicKey.slice(2), 'hex'));
  const aesKey = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(32), aad, 32));
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, unb64(sealed.nonce, 12), { authTagLength: 16 });
    decipher.setAAD(aad);
    decipher.setAuthTag(unb64(sealed.tag, 16));
    const plain = Buffer.concat([decipher.update(unb64(sealed.ciphertext)), decipher.final()]).toString('utf8');
    const data = JSON.parse(plain);
    requireTraceOnlyGrant(data);
    if (typeof data.delegation !== 'string' || typeof data.routerKey !== 'string' || !data.routerKey
        || String(data.ownerDid || '').toLowerCase() !== String(ownerDid).toLowerCase()
        || typeof data.space !== 'string' || !data.space || typeof data.host !== 'string' || !data.host) {
      throw new Error('Decrypted agent authorization is incomplete or mismatched.');
    }
    return data;
  } finally {
    secret.fill(0);
    aesKey.fill(0);
  }
}

/** Unlock a Router encrypted recovery file (router-encrypted-backup v1) with the owner's password. */
export async function unlockRecoveryFile(filePath, password) {
  let raw;
  try { raw = readFileSync(filePath, 'utf8'); }
  catch (err) { throw new Error(`Could not read recovery file ${filePath}: ${err.message}`); }
  let envelope;
  try { envelope = JSON.parse(raw); }
  catch { throw new Error(`Recovery file ${filePath} is not valid JSON.`); }
  return decryptBackup(envelope, password);
}

/** Prompt for a password on a TTY with echo suppressed. */
export async function promptPassword(prompt = 'Recovery password: ', { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) throw new Error('Cannot prompt for a recovery password without a terminal. Use --password-stdin when piping.');
  output.write(prompt);
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const cleanup = () => {
      input.removeListener('data', onData);
      input.setRawMode(!!wasRaw);
      input.pause();
    };
    const onData = chunk => {
      const str = chunk.toString('utf8');
      for (const ch of str) {
        if (ch === '\r' || ch === '\n') { cleanup(); output.write('\n'); resolve(buf); return; }
        if (ch === '\u0003') { cleanup(); output.write('\n'); reject(new Error('Cancelled.')); return; }
        if (ch === '\u007f' || ch === '\b') { if (buf.length > 0) buf = buf.slice(0, -1); continue; }
        if (ch >= ' ') buf += ch;
      }
    };
    input.on('data', onData);
  });
}

/** Read a single line (e.g. a password) from non-TTY stdin. */
export async function readLineFromStdin(input = process.stdin) {
  if (input.isTTY) throw new Error('--password-stdin expects the password on standard input, not a terminal.');
  let text = '';
  input.setEncoding('utf8');
  for await (const chunk of input) text += chunk;
  return text.replace(/\r?\n$/, '');
}

/** Save never_upload_tools to rulesPath, preserving existing fields such as "pointers". */
export function saveUploadRules(rulesPath, prefixes = []) {
  const list = [...new Set(prefixes.map(s => String(s).trim()).filter(Boolean))].sort();
  const bad = list.find(p => p.length < 4);
  if (bad) throw new Error(`Tool prefix "${bad}" is shorter than 4 characters.`);
  let existing = {};
  if (existsSync(rulesPath)) {
    existing = JSON.parse(readFileSync(rulesPath, 'utf8'));
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new Error(`${rulesPath} must hold a JSON object.`);
    }
  }
  const next = { ...existing, never_upload_tools: list };
  mkdirSync(dirname(rulesPath), { recursive: true, mode: 0o700 });
  writeFileSync(rulesPath, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  return next;
}

/**
 * Check whether rulesPath already has a valid `never_upload_tools` array.
 * If not, either initialize it (interactively or via --init-rules) or return { ready: false, reason }.
 */
export async function ensureUploadRules(rulesPath, { interactive = false, initRules = false, ask = null, say = () => {} } = {}) {
  let existing = {};
  let hasFile = existsSync(rulesPath);
  if (hasFile) {
    try { existing = JSON.parse(readFileSync(rulesPath, 'utf8')); }
    catch { return { ready: false, reason: `${rulesPath} is not valid JSON. Fix it before uploading.` }; }
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      return { ready: false, reason: `${rulesPath} must hold a JSON object such as { "never_upload_tools": [] }.` };
    }
    if (Array.isArray(existing.never_upload_tools)) return { ready: true, created: false, rules: existing };
    if ('never_upload_tools' in existing) return { ready: false, reason: `In ${rulesPath}, "never_upload_tools" must be a JSON array.` };
  }

  let list = null;
  if (interactive && ask) {
    say('\nBefore your first trace upload, choose which tools (if any) must never leave your machine.');
    say('Enter comma-separated tool-name prefixes (at least 4 characters each, e.g. mcp__diary__), or press Enter for none.');
    const answer = (await ask('Never-upload tool prefixes [none]: ')).trim();
    list = answer ? answer.split(',').map(s => s.trim()).filter(Boolean) : [];
    const bad = list.find(p => p.length < 4);
    if (bad) return { ready: false, reason: `Tool prefix "${bad}" is shorter than 4 characters. Nothing was uploaded.` };
  } else if (initRules) {
    list = [];
  } else {
    return {
      ready: false,
      reason: `Before your first upload, ${hasFile ? 'add "never_upload_tools" to' : 'create'} ${rulesPath} (run \`rules\` with your excluded tool prefixes, or re-run with --init-rules).`,
    };
  }

  const next = saveUploadRules(rulesPath, list);
  say(`  ok  saved ${rulesPath} (${list.length ? `excluding: ${list.join(', ')}` : 'no excluded tools'})`);
  return { ready: true, created: true, rules: next };
}
