#!/usr/bin/env node
// Compiles contracts/MemberVeto.sol with the settings in hardhat.config.cjs
// and writes MemberVeto.build.json, the file upgrades.mjs deploys from.
//
// The build file is committed so that deploying does not depend on a compiler
// being present, and so that anyone can run this and compare. `npm test`
// fails when the committed file differs from a fresh compile.
//
//   node build-contract.mjs           write MemberVeto.build.json
//   node build-contract.mjs --check   exit 1 if it is missing or out of date

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
export const BUILD_FILE = join(here, "MemberVeto.build.json");

export function freshBuild() {
  const cli = join(here, "node_modules", "hardhat", "internal", "cli", "cli.js");
  const compile = spawnSync(process.execPath, [cli, "compile"], {
    cwd: here,
    encoding: "utf8",
    env: { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" },
  });
  if (compile.status !== 0) throw new Error(`hardhat compile failed:\n${compile.stdout}\n${compile.stderr}`);
  const artifact = JSON.parse(
    readFileSync(join(here, "test-artifacts", "contracts", "MemberVeto.sol", "MemberVeto.json"), "utf8"),
  );
  const config = require("./hardhat.config.cjs");
  const source = readFileSync(join(here, "contracts", "MemberVeto.sol"), "utf8").replace(/\r\n/g, "\n");
  return {
    contractName: "MemberVeto",
    source: "contracts/MemberVeto.sol",
    sourceSha256: createHash("sha256").update(source).digest("hex"),
    compiler: config.solidity,
    openZeppelinContracts: require("@openzeppelin/contracts/package.json").version,
    abi: artifact.abi,
    bytecode: artifact.bytecode,
  };
}

const text = (build) => JSON.stringify(build, null, 2) + "\n";

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  const fresh = text(freshBuild());
  if (process.argv.includes("--check")) {
    const committed = existsSync(BUILD_FILE) ? readFileSync(BUILD_FILE, "utf8").replace(/\r\n/g, "\n") : null;
    if (committed !== fresh) {
      process.stderr.write("MemberVeto.build.json is missing or does not match a fresh compile\n");
      process.exitCode = 1;
    } else {
      process.stdout.write("MemberVeto.build.json matches a fresh compile\n");
    }
  } else {
    writeFileSync(BUILD_FILE, fresh);
    process.stdout.write(`wrote ${BUILD_FILE}\n`);
  }
}
