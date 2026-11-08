import { mkdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // Node's mode bits alone do not restrict a Windows ACL.
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    execFileSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `${account}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
  } else await chmod(directory, 0o700);
}
