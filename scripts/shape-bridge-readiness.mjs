#!/usr/bin/env node

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const requiredEnv = [
  'SHAPE_ROUTER_SECRET_KEY',
];

const optionalEnv = [
  'ANTHROPIC_API_KEY',
  'MATRIX_SERVER_URL',
  'MATRIX_HOMESERVER',
  'MATRIX_SERVER_NAME',
  'MATRIX_BOT_SECRET_KEY',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USER_ID',
  'MATRIX_DEVICE_ID',
  'MATRIX_CRYPTO_SECRET',
  'MATRIX_BOT_HANDLE',
  'MATRIX_SPACE_ROOM_ID',
  'MATRIX_REGISTRATION_TOKEN',
  'MATRIX_SIGNUP_URL',
  'PUBLIC_ROUTER_BASE_URL',
  'PUBLIC_ROUTER_SECRET_KEY',
  'SHAPE_PUBLIC_BOUNDARY_SENTINEL',
];

function log(message) {
  console.log(`[shape-readiness] ${message}`);
}

function present(name) {
  return Boolean(process.env[name]?.trim());
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: process.env,
      cwd: repoRoot,
      ...options,
    });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', error => {
      console.error(`[shape-readiness] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
  });
}

async function main() {
  log('checking environment names only; secret values are not printed');
  const missing = [];
  for (const name of requiredEnv) {
    if (present(name)) {
      log(`${name}=present`);
    } else {
      log(`${name}=missing`);
      missing.push(name);
    }
  }
  for (const name of optionalEnv) {
    log(`${name}=${present(name) ? 'present' : 'missing (optional)'}`);
  }
  if (!present('MATRIX_BOT_SECRET_KEY') && !present('MATRIX_ACCESS_TOKEN')) {
    missing.push('MATRIX_BOT_SECRET_KEY or MATRIX_ACCESS_TOKEN');
  }

  log('rendering compose files');
  const composeEnv = {
    ...process.env,
    GIT_SHA: process.env.GIT_SHA || 'ci',
    IMAGE_DIGEST: process.env.IMAGE_DIGEST || 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    AGENT_IMAGE_DIGEST: process.env.AGENT_IMAGE_DIGEST || 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  let failures = 0;
  failures += await run('docker', ['compose', '-f', 'docker-compose.template.yml', 'config'], {
    env: composeEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
  }) === 0 ? 0 : 1;
  failures += await run('docker', ['compose', '-f', 'docker-compose.deploy.yml', 'config'], {
    env: composeEnv,
    stdio: ['ignore', 'ignore', 'inherit'],
  }) === 0 ? 0 : 1;

  log('checking compose private/public boundary');
  failures += await run('node', ['scripts/shape-compose-boundary-check.mjs']) === 0 ? 0 : 1;

  log('checking public agent Matrix boundary');
  failures += await run('node', ['scripts/shape-agent-boundary-check.mjs']) === 0 ? 0 : 1;

  log('running private Router HTTP smoke');
  failures += await run('node', ['scripts/shape-router-smoke.mjs']) === 0 ? 0 : 1;

  log('running public Router boundary smoke');
  failures += await run('node', ['scripts/shape-public-boundary-smoke.mjs']) === 0 ? 0 : 1;

  const bridgePath = 'server/dist/shape-matrix-bridge.js';
  if (existsSync(resolve(repoRoot, bridgePath))) {
    if (present('SHAPE_ROUTER_SECRET_KEY')) {
      log('running private Router bridge preflight');
      failures += await run('node', [bridgePath, '--preflight']) === 0 ? 0 : 1;
    } else {
      log('skipping bridge preflight because SHAPE_ROUTER_SECRET_KEY is missing');
    }
  } else {
    log(`${bridgePath}=missing; run "cd server && npm run build" first`);
    failures++;
  }

  if (missing.length > 0) {
    log(`missing required env: ${missing.join(', ')}`);
    failures++;
  }

  if (failures > 0) {
    log(`readiness failed with ${failures} blocker${failures === 1 ? '' : 's'}`);
    process.exit(1);
  }

  log('readiness passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
