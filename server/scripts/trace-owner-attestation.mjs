// Attestation defaults for trace-app-owner.mjs.
// In a repo checkout, these are read from subhost/ and docker-compose.template.yml.
// When bundled into the Router plugin (scripts/build-trace-owner.mjs), this module is replaced
// with the exact build-time values so the plugin needs no checkout.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runnerSpec, sandboxSpec } from '../../subhost/embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadAttestationDefaults(approvedFile) {
  return {
    runner: runnerSpec(ROOT),
    sandbox: sandboxSpec(ROOT),
    template: readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8'),
    approved: JSON.parse(readFileSync(approvedFile || join(ROOT, 'subhost/approved.json'), 'utf8')),
  };
}
