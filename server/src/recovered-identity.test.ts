import { expect, it } from 'vitest';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkRouterPins, TinyCloudKeyMismatch } from './tinycloud-identity.js';
import { sealRecoveredKeys, openRecoveredKeys } from './recovered-identity.js';

const pair = (value: number) => ({ identity: Buffer.alloc(32, value), encryption: Buffer.alloc(32, value + 1) });

it('seals the original pair to both current hardware keys and authenticates every byte', () => {
  const original = pair(4), current = pair(12);
  const record = sealRecoveredKeys(original, current);
  expect(record.includes(original.identity)).toBe(false);
  expect(record.includes(original.encryption)).toBe(false);
  expect(openRecoveredKeys(record, current)).toEqual(original);
  expect(sealRecoveredKeys(original, current).equals(record)).toBe(false);
  for (const bad of [{ ...current, identity: original.identity }, { ...current, encryption: original.encryption }])
    expect(() => openRecoveredKeys(record, bad)).toThrow();
  for (const i of [0, 8, 31, 91]) {
    const tampered = Buffer.from(record); tampered[i] ^= 1;
    expect(() => openRecoveredKeys(tampered, current)).toThrow();
  }
});

it('requires both original on-disk checks and never writes either pin during recovery', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'router-original-pins-'));
  const pin = join(dir, 'did'), env = { TINYCLOUD_IDENTITY_PIN: pin };
  const original = pair(6);
  try {
    await expect(checkRouterPins(original, env, false)).rejects.toThrow(TinyCloudKeyMismatch);
    await checkRouterPins(original, env, true);
    const encryptionPin = await readFile(pin + '.encryption-v1');
    for (const wrong of [{ ...original, identity: pair(8).identity }, { ...original, encryption: pair(8).encryption }])
      await expect(checkRouterPins(wrong, env, false)).rejects.toThrow(TinyCloudKeyMismatch);
    await unlink(pin + '.encryption-v1');
    await expect(checkRouterPins(original, env, false)).rejects.toThrow(TinyCloudKeyMismatch);
    await expect(readFile(pin + '.encryption-v1')).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(pin + '.encryption-v1', encryptionPin);
    await expect(checkRouterPins(original, env, false)).resolves.toBeUndefined();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
