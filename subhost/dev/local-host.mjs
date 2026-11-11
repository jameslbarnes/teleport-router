// Runs the host against fake-dstack.mjs and a real Docker daemon, on Linux.
// Run it in a node container that mounts Docker's socket and a work directory
// at the same path as on the Docker host, for example:
//
//   docker run --rm -p 8091:8091 -v /var/run/docker.sock:/var/run/docker.sock \
//     -v /tmp/subhost-e2e:/tmp/subhost-e2e -v "$PWD":/repo:ro -w /repo \
//     node:22-alpine node subhost/dev/local-host.mjs /tmp/subhost-e2e
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, main } from '../host.mjs';
import { probeSpec } from '../embed.mjs';
import { startFakeDstack } from './fake-dstack.mjs';

const work = process.argv[2] || '/tmp/subhost-e2e';
mkdirSync(join(work, 'base'), { recursive: true });
const repo = join(import.meta.dirname, '..', '..');
await startFakeDstack({ socketPath: join(work, 'dstack.sock'), template: readFileSync(join(repo, 'docker-compose.template.yml'), 'utf8') });
const host = await main({
  SUBHOST_DSTACK_SOCKET: join(work, 'dstack.sock'),
  SUBHOST_BASE: join(work, 'base'),
  SUBHOST_CONTAINER_NAME: 'subhost-probe-e2e',
  SUBHOST_PROBE_SPEC: Buffer.from(canonicalJson(probeSpec(repo))).toString('base64'),
});
console.log(`local host on port ${host.port}; Ctrl-C to stop`);
const stop = () => host.close().finally(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
