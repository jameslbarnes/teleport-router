#!/usr/bin/env node

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const smokeWorkdir = process.env.SHAPE_MATRIX_SMOKE_WORKDIR || '/tmp/shape-matrix-live-smoke';
const senderCredsPath = process.env.MATRIX_SMOKE_SENDER_CREDS_PATH || `${smokeWorkdir}/sender-credentials.json`;
const serverImageTag = process.env.SHAPE_DEPLOY_GATE_SERVER_IMAGE || 'teleport-router-shape-bridge:deploy-gate';
const agentImageTag = process.env.SHAPE_DEPLOY_GATE_AGENT_IMAGE || 'teleport-router-agent-shape-boundary:deploy-gate';

function log(message) {
  console.log(`[shape-deploy-gate] ${message}`);
}

function present(name) {
  return Boolean(process.env[name]?.trim());
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('close', code => resolve(code ?? 1));
    child.on('error', error => {
      console.error(`[shape-deploy-gate] failed to start ${command}: ${error.message}`);
      resolve(1);
    });
  });
}

function checkEnv() {
  const missing = [];
  if (!present('SHAPE_ROUTER_SECRET_KEY')) missing.push('SHAPE_ROUTER_SECRET_KEY');
  if (!present('MATRIX_BOT_SECRET_KEY') && !present('MATRIX_ACCESS_TOKEN')) {
    missing.push('MATRIX_BOT_SECRET_KEY or MATRIX_ACCESS_TOKEN');
  }

  const hasSenderAccessToken = present('MATRIX_SMOKE_SENDER_ACCESS_TOKEN') && present('MATRIX_SMOKE_SENDER_USER_ID');
  const hasReusableSenderCreds = existsSync(senderCredsPath);
  if (!present('MATRIX_SMOKE_SIGNUP_CODE') && !hasSenderAccessToken && !hasReusableSenderCreds) {
    missing.push('MATRIX_SMOKE_SIGNUP_CODE or MATRIX_SMOKE_SENDER_ACCESS_TOKEN/MATRIX_SMOKE_SENDER_USER_ID');
  }

  log('checking environment names only; secret values are not printed');
  for (const name of [
    'SHAPE_ROUTER_SECRET_KEY',
    'MATRIX_BOT_SECRET_KEY',
    'MATRIX_ACCESS_TOKEN',
    'MATRIX_USER_ID',
    'MATRIX_BOT_HANDLE',
    'MATRIX_SMOKE_SIGNUP_CODE',
    'MATRIX_SMOKE_SENDER_ACCESS_TOKEN',
    'MATRIX_SMOKE_SENDER_USER_ID',
  ]) {
    log(`${name}=${present(name) ? 'present' : 'missing'}`);
  }
  if (hasReusableSenderCreds) log(`MATRIX_SMOKE_SENDER_CREDS_PATH=present at ${senderCredsPath}`);

  if (missing.length > 0) {
    for (const name of missing) log(`missing required env: ${name}`);
    return false;
  }
  return true;
}

async function main() {
  if (!checkEnv()) process.exit(1);

  const runningBridgeMode = process.env.SHAPE_MATRIX_SMOKE_RUNNING_BRIDGE === '1';
  log(`live Matrix smoke mode=${runningBridgeMode ? 'already-running bridge' : 'local bridge process'}`);

  const steps = [
    ['node', ['--check', 'scripts/shape-router-smoke.mjs']],
    ['node', ['--check', 'scripts/shape-public-boundary-smoke.mjs']],
    ['node', ['--check', 'scripts/shape-compose-boundary-check.mjs']],
    ['node', ['--check', 'scripts/shape-bridge-readiness.mjs']],
    ['node', ['--check', 'scripts/shape-matrix-live-smoke.mjs']],
    ['node', ['--check', 'scripts/shape-deploy-gate.mjs']],
    ['node', ['--check', 'scripts/shape-agent-boundary-check.mjs']],
    ['node', ['scripts/shape-agent-boundary-check.mjs']],
    ['npm', ['--prefix', 'server', 'test']],
    ['npm', ['--prefix', 'server', 'run', 'build']],
    ['docker', ['build', '-t', serverImageTag, '.']],
    ['docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      serverImageTag,
      '-e',
      'const fs=require("fs"); const p="/app/server/dist/shape-matrix-bridge.js"; if (!fs.existsSync(p)) { console.error(`${p} missing`); process.exit(1); } console.log("bridge-present");',
    ]],
    ['docker', ['build', '-t', agentImageTag, './agent', '-f', 'agent/Dockerfile']],
    ['docker', [
      'run',
      '--rm',
      '--entrypoint',
      'node',
      agentImageTag,
      '-e',
      `const fs=require("fs"); const p="/app/router_event_worker.mjs"; const src=fs.readFileSync(p,"utf8"); const pairs=[["function matrixHandlingEnabled()","await runAgentChat(event);"],["if (data.platform === 'matrix' && !handleMatrixEvents)","await runOnboardingChat(event);"],["if (!handleMatrixEvents)","await runAgentChat(event);"]]; for (const [before,after] of pairs) { const bi=src.indexOf(before); const ai=src.indexOf(after); if (bi<0 || ai<0 || bi>ai) { console.error(p+" missing ordered Matrix boundary guard "+before+" before "+after); process.exit(1); } } console.log("agent-boundary-guard-present");`,
    ]],
    ['npm', ['--prefix', 'server', 'run', 'shape:readiness']],
    ['npm', ['--prefix', 'server', 'run', 'shape:matrix-live-smoke']],
  ];

  for (const [command, args] of steps) {
    log(`running ${command} ${args.join(' ')}`);
    const code = await run(command, args);
    if (code !== 0) {
      log(`failed: ${command} ${args.join(' ')}`);
      process.exit(code);
    }
  }

  log('deploy gate passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
