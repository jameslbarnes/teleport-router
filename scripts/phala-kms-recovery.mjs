// The temporary compose is deliberately different from the normal subhost grantor's accepted template.
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as wait } from 'node:timers/promises';

const run = promisify(execFile);
const [command, arg, output] = process.argv.slice(2);
if (command === 'compose') {
  const normal = (await readFile(arg, 'utf8')).replaceAll('\r\n', '\n');
  const image = normal.match(/^  router:\n    image: (docker\.io\/generalsemantics\/teleport-router:[0-9a-f]{7,40}@sha256:[0-9a-f]{64})$/m)?.[1];
  const marker = '  # BEGIN subhost:';
  const record = 'TINYCLOUD_RECOVERED_KEYS=/router-recovery/identity.v1';
  if (!image || !normal.includes(marker) || normal.includes('  kms-recovery:') || !normal.includes(record))
    throw Error('Unexpected production Router compose');
  const service = (await readFile(new URL('./kms-recovery-service.yml', import.meta.url), 'utf8')).replaceAll('\r\n','\n').replace('__ROUTER_IMAGE__', image);
  // Keep the public server read-only throughout this phase, including if it restarts.
  const maintenance = normal.replace(record, 'TINYCLOUD_RECOVERED_KEYS=/router-recovery/deferred')
    .replace(marker, service + marker).replace('\nvolumes:\n', '\nnetworks:\n  kms-recovery-egress:\n\nvolumes:\n');
  await writeFile(output, maintenance, { flag: 'wx', mode: 0o600 });
} else if (command === 'wait') {
  const deadline = Date.now() + 420000;
  const expectedImage = process.env.GITHUB_SHA?.slice(0, 7);
  if (!arg || !expectedImage) throw Error('Missing CVM or release identity');
  let done = false;
  while (Date.now() < deadline) {
    let composition;
    try {
      const { stdout } = await run('phala', ['api', '/cvms/' + arg + '/composition'], { timeout: 18000, maxBuffer: 2*1024*1024 });
      composition = JSON.parse(stdout);
    } catch { /* control plane may still be restarting */ }
    const compose = composition?.docker_compose_file || '';
    const container = composition?.containers?.find(c => {
      const names = Array.isArray(c.names) ? c.names : [c.names ?? c.name ?? ''];
      return names.some(n => /(?:^|[/-])kms-recovery-1$/.test(n));
    });
    if (compose.includes('teleport-router:' + expectedImage + '@') && compose.includes('  kms-recovery:') && container) {
      const exit = /Exited\s*\((\d+)\)/i.exec(container.status || '');
      if (exit) {
        const code = Number(exit[1]);
        if (code !== 0) throw Error('One-shot recovery stopped with stage code ' + code);
        console.log('The one-shot recovery verified both original pins and read back the sealed keys.');
        done = true;
        break;
      }
    }
    console.log('Waiting for the one-shot recovery inside the CVM.');
    await wait(10000);
  }
  if (!done) throw Error('Timed out confirming the one-shot recovery exit status');
} else { throw Error('Expected compose or wait'); }
