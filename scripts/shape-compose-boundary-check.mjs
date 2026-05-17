#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const checkImage = process.env.SHAPE_COMPOSE_CHECK_IMAGE === '1' || args.includes('--check-image');
const pullImage = process.env.SHAPE_COMPOSE_PULL_IMAGE === '1' || args.includes('--pull-image');
const files = args.filter(arg => arg !== '--check-image' && arg !== '--pull-image').filter(Boolean);
const composeFiles = files.length > 0
  ? files
  : ['docker-compose.template.yml', 'docker-compose.deploy.yml'];

const privateShapeUrl = 'https://shaperotator.teleport.computer';
const matrixUrl = 'https://mtrx.shaperotator.xyz';
const matrixSpace = '!4FL8uL5OEYLATG1VH4wC2CD3pfIV6BMFId9VT7rmm-g';

function log(message) {
  console.log(`[shape-compose-boundary] ${message}`);
}

function fail(file, message) {
  throw new Error(`${file}: ${message}`);
}

function composeConfig(file) {
  const env = {
    ...process.env,
    GIT_SHA: process.env.GIT_SHA || 'ci',
    IMAGE_DIGEST: process.env.IMAGE_DIGEST || 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    AGENT_IMAGE_DIGEST: process.env.AGENT_IMAGE_DIGEST || 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  };
  const result = spawnSync('docker', ['compose', '-f', file, 'config', '--format', 'json'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`${file}: docker compose config failed\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${file}: failed to parse docker compose JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function envOf(service) {
  return service?.environment && typeof service.environment === 'object'
    ? service.environment
    : {};
}

function commandOf(service) {
  const command = service?.command;
  return Array.isArray(command) ? command.join(' ') : String(command || '');
}

function hasNamedVolume(service, source, target) {
  const volumes = Array.isArray(service?.volumes) ? service.volumes : [];
  return volumes.some(volume => volume?.source === source && volume?.target === target);
}

function runDocker(file, args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    fail(file, `docker ${args.join(' ')} failed\n${result.stderr || result.stdout}`);
  }
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

function verifyBridgeImage(file, bridge) {
  if (!checkImage) return;
  const image = bridge.image;
  if (!image) fail(file, 'shape-matrix-bridge missing image');
  if (/sha256:a{64}/.test(image) || /:ci@/.test(image)) {
    fail(file, 'shape-matrix-bridge image still contains CI placeholder values; set real GIT_SHA/IMAGE_DIGEST or pass a generated deploy compose');
  }

  if (pullImage) {
    log(`pulling ${image}`);
    runDocker(file, ['pull', image], { stdio: 'inherit' });
  } else {
    runDocker(file, ['image', 'inspect', image]);
  }

  runDocker(file, [
    'run',
    '--rm',
    '--entrypoint',
    'node',
    image,
    '-e',
    'const fs=require("fs"); const p="/app/server/dist/shape-matrix-bridge.js"; if (!fs.existsSync(p)) { console.error(`${p} missing`); process.exit(1); }',
  ]);
  log(`${file} image contains dist/shape-matrix-bridge.js`);
}

function verifyAgentImage(file, routerAgent) {
  if (!checkImage || !routerAgent) return;
  const image = routerAgent.image;
  if (!image) fail(file, 'router-agent missing image');

  if (pullImage) {
    log(`pulling ${image}`);
    runDocker(file, ['pull', image], { stdio: 'inherit' });
  } else {
    runDocker(file, ['image', 'inspect', image]);
  }

  runDocker(file, [
    'run',
    '--rm',
    '--entrypoint',
    'node',
    image,
    '-e',
    [
      'const fs=require("fs");',
      'const p="/app/router_event_worker.mjs";',
      'const src=fs.readFileSync(p,"utf8");',
      'const pairs=[',
      '["function matrixHandlingEnabled()","await runAgentChat(event);"],',
      '["if (data.platform === \'matrix\' && !handleMatrixEvents)","await runOnboardingChat(event);"],',
      '["if (!handleMatrixEvents)","await runAgentChat(event);"]',
      '];',
      'for (const [before,after] of pairs) {',
      'const bi=src.indexOf(before); const ai=src.indexOf(after);',
      'if (bi<0 || ai<0 || bi>ai) { console.error(`${p} missing ordered Matrix boundary guard ${before} before ${after}`); process.exit(1); }',
      '}',
    ].join(' '),
  ]);
  log(`${file} router-agent image contains ordered Matrix boundary guard`);
}

function assertNoLatestImages(file, services) {
  if (!checkImage) return;
  for (const [name, service] of Object.entries(services)) {
    const image = service?.image;
    if (typeof image !== 'string') continue;
    if (image === 'latest' || image.endsWith(':latest')) {
      fail(file, `${name} image must not use :latest when --check-image is enabled`);
    }
  }
}

function assertNoEnv(file, serviceName, env, matchers) {
  for (const key of Object.keys(env)) {
    for (const matcher of matchers) {
      const matched = typeof matcher === 'string' ? key === matcher : matcher.test(key);
      if (matched) fail(file, `${serviceName} must not receive ${key}`);
    }
  }
}

function assertEnv(file, serviceName, env, key, expected) {
  if (!(key in env)) fail(file, `${serviceName} missing ${key}`);
  if (expected !== undefined && env[key] !== expected) {
    fail(file, `${serviceName} ${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(env[key])}`);
  }
}

function checkFile(file) {
  const config = composeConfig(file);
  const services = config.services || {};
  const router = services.router;
  const routerAgent = services['router-agent'];
  const bridge = services['shape-matrix-bridge'];
  if (!router) fail(file, 'missing router service');
  if (!bridge) fail(file, 'missing shape-matrix-bridge service');
  assertNoLatestImages(file, services);

  const routerEnv = envOf(router);
  assertNoEnv(file, 'router', routerEnv, [
    /^MATRIX_/,
    /^SHAPE_MATRIX_/,
    'SHAPE_ROUTER_BASE_URL',
    'SHAPE_ROUTER_SECRET_KEY',
    'ROUTER_AGENT_HANDLES_MATRIX',
  ]);

  if (routerAgent) {
    const routerAgentEnv = envOf(routerAgent);
    assertNoEnv(file, 'router-agent', routerAgentEnv, [
      /^MATRIX_/,
      /^SHAPE_MATRIX_/,
      'SHAPE_ROUTER_BASE_URL',
      'SHAPE_ROUTER_SECRET_KEY',
      'ROUTER_AGENT_HANDLES_MATRIX',
    ]);
    assertEnv(file, 'router-agent', routerAgentEnv, 'ROUTER_ENABLE_GATEWAY', '0');
  }

  const bridgeEnv = envOf(bridge);
  if (!commandOf(bridge).includes('dist/shape-matrix-bridge.js')) {
    fail(file, 'shape-matrix-bridge command must run dist/shape-matrix-bridge.js');
  }
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'SHAPE_ROUTER_BASE_URL', privateShapeUrl);
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'SHAPE_ROUTER_SECRET_KEY');
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'SHAPE_MATRIX_BRIDGE_TAGS', 'shape-rotator,matrix');
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'SHAPE_MATRIX_ENABLE_ONBOARDING', '0');
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'MATRIX_SERVER_URL', matrixUrl);
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'MATRIX_SERVER_NAME', 'mtrx.shaperotator.xyz');
  assertEnv(file, 'shape-matrix-bridge', bridgeEnv, 'MATRIX_SPACE_ROOM_ID', matrixSpace);
  assertNoEnv(file, 'shape-matrix-bridge', bridgeEnv, [
    'MATRIX_FRESH_CRYPTO',
    'MATRIX_FRESH_CRYPTO_ONCE_MARKER',
  ]);
  if (!hasNamedVolume(bridge, 'shape-matrix-bridge-data', '/data')) {
    fail(file, 'shape-matrix-bridge must mount shape-matrix-bridge-data at /data');
  }

  verifyBridgeImage(file, bridge);
  verifyAgentImage(file, routerAgent);
  log(`${file} boundary ok`);
}

for (const file of composeFiles) {
  checkFile(file);
}
