// Bundles server/scripts/trace-app-owner.mjs into plugins/teleport-router/scripts/trace-app-owner.mjs
// so that anyone with the Router plugin can review and approve trace-app runs without a git checkout
// or npm install. Embeds the pinned runner/sandbox specs, compose template and approved.json.
//
//   node scripts/build-trace-owner.mjs          build plugins/teleport-router/scripts/trace-app-owner.mjs
//   node scripts/build-trace-owner.mjs --check  fail if the committed bundle is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { runnerSpec, sandboxSpec } from '../subhost/embed.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'browser', 'package.json'));
const { build } = require('esbuild');

const ENTRY = join(ROOT, 'server', 'scripts', 'trace-app-owner.mjs');
const OUT = join(ROOT, 'plugins', 'teleport-router', 'scripts', 'trace-app-owner.mjs');
const WASM_SRC = join(ROOT, 'server', 'node_modules', '@tinycloud', 'node-sdk-wasm', 'dist', 'wasm', 'tinycloud_web_sdk_rs_bg.wasm');
const WASM_OUT = join(ROOT, 'plugins', 'teleport-router', 'scripts', 'tinycloud_web_sdk_rs_bg.wasm');

const embedded = {
  runner: runnerSpec(ROOT),
  sandbox: sandboxSpec(ROOT),
  template: readFileSync(join(ROOT, 'docker-compose.template.yml'), 'utf8').replace(/\r\n/g, '\n'),
  approved: JSON.parse(readFileSync(join(ROOT, 'subhost', 'approved.json'), 'utf8')),
};

const embeddedModuleSource = `
import { readFileSync } from 'node:fs';
const EMBEDDED = ${JSON.stringify(embedded)};
export function loadAttestationDefaults(approvedFile) {
  return {
    runner: EMBEDDED.runner,
    sandbox: EMBEDDED.sandbox,
    template: EMBEDDED.template,
    approved: approvedFile ? JSON.parse(readFileSync(approvedFile, 'utf8')) : EMBEDDED.approved,
  };
}
`;

const result = await build({
  entryPoints: [ENTRY],
  bundle: true,
  write: false,
  format: 'esm',
  platform: 'node',
  target: ['node20'],
  minify: true,
  legalComments: 'none',
  nodePaths: [join(ROOT, 'server', 'node_modules'), join(ROOT, 'browser', 'node_modules')],
  banner: {
    js: '#!/usr/bin/env node\n// Built from server/scripts/trace-app-owner.mjs by scripts/build-trace-owner.mjs. Do not edit by hand.\nimport { createRequire as __routerCreateRequire } from "node:module"; import { dirname as __routerDirname } from "node:path"; import { fileURLToPath as __routerFileURLToPath } from "node:url"; const require = __routerCreateRequire(import.meta.url); const __filename = __routerFileURLToPath(import.meta.url); const __dirname = __routerDirname(__filename);',
  },
  plugins: [
    {
      name: 'embed-attestation-defaults',
      setup(b) {
        b.onResolve({ filter: /^\.\/trace-owner-attestation\.mjs$/ }, () => ({ path: 'trace-owner-attestation', namespace: 'embedded' }));
        b.onLoad({ filter: /.*/, namespace: 'embedded' }, () => ({ contents: embeddedModuleSource, loader: 'js' }));
      },
    },
  ],
});

const built = result.outputFiles[0].text.replace(/\r\n/g, '\n');
const wasmBuilt = readFileSync(WASM_SRC);

if (process.argv.includes('--check')) {
  let current = '';
  let wasmCurrent = Buffer.alloc(0);
  try { current = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'); } catch {}
  try { wasmCurrent = readFileSync(WASM_OUT); } catch {}
  if (current !== built || !wasmCurrent.equals(wasmBuilt)) {
    console.error('plugins/teleport-router/scripts/trace-app-owner.mjs (or its wasm) is out of date: run `node scripts/build-trace-owner.mjs`');
    process.exit(1);
  }
  console.log(`plugins/teleport-router/scripts/trace-app-owner.mjs is up to date (${built.length} bytes + ${wasmBuilt.length} bytes wasm)`);
} else {
  writeFileSync(OUT, built, { mode: 0o755 });
  writeFileSync(WASM_OUT, wasmBuilt);
  console.log(`built plugins/teleport-router/scripts/trace-app-owner.mjs (${built.length} bytes + ${wasmBuilt.length} bytes wasm)`);
}
