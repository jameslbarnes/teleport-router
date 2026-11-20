// One-shot production migration. The command accepts no key paths from callers and has no listener.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { checkRouterPins, currentRouterKeys, IDENTITY_PATH, RECORD_PATH } from '../dist/tinycloud-identity.js';
import { openRecoveredKeys, sealRecoveredKeys } from '../dist/recovered-identity.js';

const run = promisify(execFile);
const record = '/router-recovery/identity.v1';
const env = { TINYCLOUD_IDENTITY_PIN: '/pins/tinycloud-router-did' };
let stage = 10;
const stages = { 10: 'existing pins', 11: 'current enclave keys', 12: 'existing recovery record',
  13: 'original identity derivation', 14: 'original encryption derivation', 15: 'original key checks', 16: 'durable sealed record' };

async function previousKey(path, purpose) {
  const args = ['key', path, '--api', 'v0', '--root-epoch', '0', '--app-epoch', '0', '--json'];
  if (purpose) args.push('--purpose', purpose);
  // The executable's stdout goes only to this process. Its stderr, stdout and thrown errors must never be logged.
  const { stdout } = await run('/usr/local/bin/dstack-key-recovery', args,
    { encoding: 'utf8', timeout: 100000, maxBuffer: 64 * 1024, env: { PATH:'/usr/local/bin:/usr/bin:/bin', DSTACK_CCEL_FILE:'/ccel.bin' } });
  const result = JSON.parse(stdout);
  if (result.api !== 'v0' || result.root_epoch !== 0 || result.app_epoch !== 0 || typeof result.key !== 'string' ||
      !/^(?:0x)?[0-9a-f]{64}$/i.test(result.key)) throw Error('Invalid historical key response');
  return Buffer.from(result.key.replace(/^0x/i,''), 'hex');
}

async function recover() {
  // Both pins must already exist on the old disk. This mount is read-only.
  await Promise.all([env.TINYCLOUD_IDENTITY_PIN, env.TINYCLOUD_IDENTITY_PIN + '.encryption-v1'].map(p => readFile(p)));
  stage = 11;
  const current = await currentRouterKeys('/var/run/dstack-filtered/dstack.sock');
  const verifyRecord = async () => {
    const original = openRecoveredKeys(await readFile(record), current);
    try { await checkRouterPins(original, env, false); } finally { original.identity.fill(0); original.encryption.fill(0); }
  };
  stage = 12;
  try { await verifyRecord(); return; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  stage = 13;
  const identity = await previousKey(IDENTITY_PATH, 'secp256k1');
  stage = 14;
  const encryption = await previousKey(RECORD_PATH, '');
  try {
    const original = { identity, encryption };
    stage = 15;
    await checkRouterPins(original, env, false);
    stage = 16;
    const temporary = record + '.' + randomUUID();
    const file = await open(temporary, 'wx', 0o600);
    try {
      try { await file.writeFile(sealRecoveredKeys(original, current)); await file.sync(); }
      finally { await file.close(); }
      // Atomic publication without replacing a record installed by an earlier run.
      try { await link(temporary, record); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const dir = await open(dirname(record), 'r');
      try { await dir.sync(); } finally { await dir.close(); }
      await verifyRecord();
    } finally { await unlink(temporary); }
  } finally { identity.fill(0); encryption.fill(0); }
}

try {
  await recover();
  console.log('Both original Router keys matched their saved checks and the sealed record was verified.');
} catch {
  console.error('Router recovery stopped at ' + stages[stage] + '.');
  process.exitCode = stage;
}
