import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
await build({ entryPoints: [fileURLToPath(new URL('./src/setup.mjs', import.meta.url))],
  outfile: fileURLToPath(new URL('../onboarding-assets/setup.js', import.meta.url)),
  bundle: true, format: 'esm', platform: 'browser', target: ['es2022'], minify: true,
  logLevel: 'info', legalComments: 'external' });
