// Bundles the insights enclave program into one file, so its image holds that file and nothing of Router.
//
//   node scripts/bundle-insights-enclave.mjs [out-dir]     (from server/; default out-dir: dist-insights-enclave)
//
// Prints the bundle's SHA-256 and the source files that went into it. The list of our own sources must match
// ENCLAVE_SOURCES below, which is also what the image build copies and what the upgrade check watches; the
// build fails if the program starts importing anything else of Router's.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENCLAVE_SOURCES = ['src/author-records.ts', 'src/insights-enclave-server.ts', 'src/insights-enclave.ts', 'src/insights-program.ts',
  'src/insights-spec.ts', 'src/insights-weekly.ts', 'src/trace-envelope.ts'];

export async function bundleEnclave(outDir) {
  const server = join(dirname(fileURLToPath(import.meta.url)), '..');
  const outfile = join(resolve(outDir), 'insights-enclave.mjs');
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await build({
    absWorkingDir: server, entryPoints: ['src/insights-enclave-server.ts'], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    legalComments: 'none', charset: 'utf8', metafile: true, logLevel: 'warning',
    // Some dependencies are CommonJS and call require() for Node's own modules.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  });
  const inputs = Object.keys(result.metafile.inputs).map(p => p.replace(/\\/g, '/'));
  const ours = inputs.filter(p => !p.includes('node_modules/')).sort();
  if (JSON.stringify(ours) !== JSON.stringify(ENCLAVE_SOURCES))
    throw new Error(`The enclave program is built from ${ours.join(', ')}; expected exactly ${ENCLAVE_SOURCES.join(', ')}. Update ENCLAVE_SOURCES, insights-enclave/Dockerfile and insights-enclave/check-upgrade.mjs together.`);
  const packages = [...new Set(inputs.filter(p => p.includes('node_modules/')).map(p => /node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p.slice(p.lastIndexOf('node_modules/')))?.[1]))].sort();
  const sha256 = createHash('sha256').update(readFileSync(outfile)).digest('hex');
  writeFileSync(outfile + '.sha256', sha256 + '\n');
  return { outfile, sha256, bytes: readFileSync(outfile).length, sources: ours, packages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = await bundleEnclave(process.argv[2] || 'dist-insights-enclave');
  console.log(JSON.stringify(out, null, 2));
}
