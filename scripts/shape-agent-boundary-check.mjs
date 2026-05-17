#!/usr/bin/env node

import { readFileSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { fileURLToPath } from 'url';

const file = process.argv[2] || 'agent/router_event_worker.mjs';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const path = isAbsolute(file) ? file : resolve(repoRoot, file);
const source = readFileSync(path, 'utf8');

function fail(message) {
  throw new Error(`${file}: ${message}`);
}

function assertIncludes(needle, message) {
  if (!source.includes(needle)) fail(message);
}

function assertBefore(before, after, message) {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  if (beforeIndex < 0) fail(`missing ${JSON.stringify(before)}`);
  if (afterIndex < 0) fail(`missing ${JSON.stringify(after)}`);
  if (beforeIndex > afterIndex) fail(message);
}

assertIncludes('function matrixHandlingEnabled()', 'missing Matrix handling feature flag helper');
assertIncludes('process.env.ROUTER_AGENT_HANDLES_MATRIX', 'Matrix handling must be controlled by ROUTER_AGENT_HANDLES_MATRIX');
assertIncludes("['1', 'true', 'yes', 'remote']", 'Matrix handling feature flag must require an explicit true value');
assertIncludes('const handleMatrixEvents = matrixHandlingEnabled();', 'event loop must read Matrix handling flag once at startup');

assertBefore(
  "if (data.platform === 'matrix' && !handleMatrixEvents)",
  'await runOnboardingChat(event);',
  'Matrix onboarding guard must run before the Hermes onboarding call',
);

assertBefore(
  'if (!handleMatrixEvents)',
  'await runAgentChat(event);',
  'Matrix mention guard must run before the Hermes mention call',
);

assertBefore(
  'if (!handleMatrixEvents)',
  'const messageId = matrixMessageId(event);',
  'Matrix mention duplicate tracking must stay behind the disabled-by-default boundary',
);

console.log(`[shape-agent-boundary] ${file} Matrix handling is disabled by default before Hermes calls`);
