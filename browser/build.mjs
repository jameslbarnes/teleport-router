import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// The page loads setup.js. The storage library is far larger than everything else, and only the
// "connect storage" step uses it, so it is split into its own file and fetched when that step runs.
const outdir = fileURLToPath(new URL('../onboarding-assets/', import.meta.url));
await rm(outdir, { recursive: true, force: true });
await build({ entryPoints: { setup: fileURLToPath(new URL('./src/setup.mjs', import.meta.url)) },
  outdir, entryNames: '[name]', chunkNames: 'chunks/[name]-[hash]', splitting: true,
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  logLevel: 'info', legalComments: 'external' });
