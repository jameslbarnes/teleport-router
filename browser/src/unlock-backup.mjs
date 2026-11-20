import { decryptBackup } from './recovery.mjs';

/** Unlock the encrypted account file locally; the caller never sends its password or storage key. */
export async function unlockOldStorage(handle, routerKey, file, password) {
  const raw = file ? await file.text() : localStorage.getItem('router_recovery:' + handle);
  if (!raw || raw.length > 32000) throw Error('Choose the encrypted Router recovery file for this account.');
  const backup = await decryptBackup(JSON.parse(raw), password);
  if (backup.handle !== handle || backup.routerKey !== routerKey || backup.origin !== location.origin)
    throw Error('The recovery file belongs to a different Router account.');
  return backup;
}
