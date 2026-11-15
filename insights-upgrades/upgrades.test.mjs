// End-to-end test of upgrades.mjs against a local chain (hardhat node,
// chain id 31337). Run with: node --test upgrades.test.mjs
//
// The commands are run the way a person runs them: as `node upgrades.mjs …`
// child processes with the key in the environment. Independent checks then
// read the chain directly with ethers, and the "must fail" cases are also
// tried straight against the contract, so a pass does not rest on the
// script's own refusals.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ContractFactory,
  HDNodeWallet,
  Interface,
  JsonRpcProvider,
  Mnemonic,
  Network,
  Wallet,
  ZeroAddress,
  ZeroHash,
  parseEther,
} from "ethers";
import { APP_VERSIONS, ENTRY_POINT_V09, ROLES, TIMELOCK_ABI, decodeCall } from "./upgrades.mjs";
import { BUILD_FILE, freshBuild } from "./build-contract.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hardhatCli = join(here, "node_modules", "hardhat", "internal", "cli", "cli.js");
const CHAIN_ID = "31337";
const DELAY_SECONDS = 48 * 3600;

// Hardhat's published test mnemonic. These accounts exist only on the local chain.
const mnemonic = Mnemonic.fromPhrase("test test test test test test test test test test test junk");
const account = (index) => HDNodeWallet.fromMnemonic(mnemonic, `m/44'/60'/0'/0/${index}`);

const HASH_A = "0x" + "a1".repeat(32);
const HASH_B = "0x" + "b2".repeat(32);
const HASH_C = "0x" + "c3".repeat(32);

let node;
let rpc;
let provider;
let tmp;
let deployer, proposer, outsider, newMember;
let cancellerA, cancellerB; // { address, key }
let timelockAddress;
let timelock; // read-only ethers Contract
let app; // stand-in app owned by the timelock, reporting the basic interface
let epochApp; // stand-in app reporting the epoch interface

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Runs the CLI. Signing keys reach it only through `env`. */
function cli(args, env = {}) {
  const clean = { ...process.env };
  delete clean.INSIGHTS_DEPLOYER_KEY;
  delete clean.INSIGHTS_CANCEL_KEY;
  const result = spawnSync(process.execPath, [join(here, "upgrades.mjs"), ...args], {
    cwd: here,
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = null;
  }
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const chain = () => ["--rpc", rpc, "--chain-id", CHAIN_ID];
const asDeployer = () => ({ INSIGHTS_DEPLOYER_KEY: deployer.privateKey });
const asProposer = () => ({ INSIGHTS_DEPLOYER_KEY: proposer.privateKey });

async function advanceTime(seconds) {
  await provider.send("evm_increaseTime", [seconds]);
  await provider.send("evm_mine", []);
}

function readCancelKeyFile(path) {
  const text = readFileSync(path, "utf8");
  return {
    text,
    address: /^INSIGHTS_CANCEL_ADDRESS=(0x[0-9a-fA-F]{40})$/m.exec(text)[1],
    key: /^INSIGHTS_CANCEL_KEY=(0x[0-9a-f]{64})$/m.exec(text)[1],
  };
}

describe("insights upgrade timelock, end to end on a local chain", () => {
  before(async () => {
    const hardhatEnv = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: "true" };
    const compile = spawnSync(process.execPath, [hardhatCli, "compile"], { cwd: here, encoding: "utf8", env: hardhatEnv });
    assert.equal(compile.status, 0, `hardhat compile failed:\n${compile.stdout}\n${compile.stderr}`);

    const port = await freePort();
    rpc = `http://127.0.0.1:${port}`;
    node = spawn(process.execPath, [hardhatCli, "node", "--hostname", "127.0.0.1", "--port", String(port)], {
      cwd: here,
      stdio: "ignore",
      env: hardhatEnv,
    });
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        const response = await fetch(rpc, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        });
        if ((await response.json()).result === "0x7a69") break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error("the local chain did not start within 60 seconds");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    provider = new JsonRpcProvider(rpc, Network.from(31337), { staticNetwork: true, cacheTimeout: -1 });
    deployer = account(0).connect(provider);
    proposer = account(1).connect(provider);
    outsider = account(3).connect(provider);
    newMember = account(4).connect(provider);
    tmp = mkdtempSync(join(tmpdir(), "insights-upgrades-test-"));
    // The real ERC-4337 entry point, as deployed on Base, at its real address.
    const entryPointCode = readFileSync(join(here, "test-fixtures", "EntryPoint-v0.9.runtime.hex"), "utf8").trim();
    await provider.send("hardhat_setCode", [ENTRY_POINT_V09, entryPointCode]);
  });

  after(() => {
    provider?.destroy();
    node?.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("new-cancel-key writes the key to a file, prints only the address, and will not overwrite", () => {
    const made = [];
    for (const name of ["a.cancel-key", "b.cancel-key"]) {
      const path = join(tmp, name);
      const result = cli(["new-cancel-key", "--out", path]);
      assert.equal(result.code, 0, result.stderr);
      const file = readCancelKeyFile(path);
      assert.equal(result.json.address, file.address);
      assert.ok(!(result.stdout + result.stderr).includes(file.key.slice(2)), "the key must not be printed");
      assert.match(file.text, /WARNING/);
      assert.match(file.text, /cancel a pending upgrade/);
      made.push(file);
    }
    [cancellerA, cancellerB] = made;
    assert.notEqual(cancellerA.address, cancellerB.address);
    const again = cli(["new-cancel-key", "--out", join(tmp, "a.cancel-key")]);
    assert.equal(again.code, 1);
    assert.match(again.stderr, /refusing to overwrite/);
    assert.equal(readCancelKeyFile(join(tmp, "a.cancel-key")).key, cancellerA.key);
  });

  it("deploy-timelock refuses a wrong chain id, a short delay, a missing key and a key on the command line", async () => {
    const base = ["deploy-timelock", "--proposer", proposer.address, "--cancellers", `${cancellerA.address},${cancellerB.address}`];
    const blockBefore = await provider.getBlockNumber();

    const wrongChain = cli([...base, "--delay-hours", "48", "--rpc", rpc, "--chain-id", "8453"], asDeployer());
    assert.equal(wrongChain.code, 1);
    assert.match(wrongChain.stderr, /chain 31337, but --chain-id says 8453/);

    const noChain = cli([...base, "--delay-hours", "48", "--rpc", rpc], asDeployer());
    assert.equal(noChain.code, 2);
    assert.match(noChain.stderr, /--chain-id is required/);

    const short = cli([...base, "--delay-hours", "47", ...chain()], asDeployer());
    assert.equal(short.code, 1);
    assert.match(short.stderr, /under the 48-hour minimum/);

    const noKey = cli([...base, "--delay-hours", "48", ...chain()]);
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /INSIGHTS_DEPLOYER_KEY/);

    const keyInArgs = cli([...base, "--delay-hours", "48", ...chain(), "--key", deployer.privateKey]);
    assert.equal(keyInArgs.code, 2);
    assert.match(keyInArgs.stderr, /Unknown option '--key'/);

    assert.equal(await provider.getBlockNumber(), blockBefore, "nothing may have been sent");
  });

  it("deploy-timelock --dry-run prints the exact transactions and sends nothing", async () => {
    const blockBefore = await provider.getBlockNumber();
    const result = cli([
      "deploy-timelock", "--dry-run", "--delay-hours", "48", "--proposer", proposer.address,
      "--cancellers", `${cancellerA.address},${cancellerB.address}`, "--from", deployer.address, ...chain(),
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.dryRun, true);
    const txs = result.json.transactions;
    assert.equal(txs.length, 4); // deploy, two grants, renounce
    assert.equal(txs[0].to, null);
    const iface = new Interface(TIMELOCK_ABI);
    assert.deepEqual([...iface.decodeFunctionData("grantRole", txs[1].data)], [ROLES.CANCELLER_ROLE, cancellerA.address]);
    assert.deepEqual([...iface.decodeFunctionData("renounceRole", txs[3].data)], [ROLES.DEFAULT_ADMIN_ROLE, deployer.address]);
    assert.equal(txs[1].to, result.json.predictedTimelock);
    assert.equal(await provider.getBlockNumber(), blockBefore, "a dry run must not send anything");
    assert.equal(await provider.getCode(result.json.predictedTimelock), "0x");
  });

  it("deploy-timelock sets up the roles and leaves the deployer with nothing", async () => {
    const result = cli(
      ["deploy-timelock", "--delay-hours", "48", "--proposer", proposer.address,
        "--cancellers", `${cancellerA.address},${cancellerB.address}`, ...chain()],
      asDeployer(),
    );
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!(result.stdout + result.stderr).includes(deployer.privateKey.slice(2)), "the key must not be printed");
    assert.equal(result.json.verified, true);
    assert.ok(result.json.verification.every((check) => check.ok));
    timelockAddress = result.json.timelock;
    timelock = new Contract(timelockAddress, TIMELOCK_ABI, provider);

    // Independent reads, not the script's own summary.
    assert.equal(await timelock.getMinDelay(), BigInt(DELAY_SECONDS));
    assert.equal(await timelock.hasRole(ROLES.PROPOSER_ROLE, proposer.address), true);
    assert.equal(await timelock.hasRole(ROLES.EXECUTOR_ROLE, proposer.address), true);
    assert.equal(await timelock.hasRole(ROLES.EXECUTOR_ROLE, ZeroAddress), false);
    for (const canceller of [cancellerA, cancellerB]) {
      assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, canceller.address), true);
      assert.equal(await timelock.hasRole(ROLES.PROPOSER_ROLE, canceller.address), false);
      assert.equal(await timelock.hasRole(ROLES.EXECUTOR_ROLE, canceller.address), false);
      assert.equal(await timelock.hasRole(ROLES.DEFAULT_ADMIN_ROLE, canceller.address), false);
    }
    for (const role of Object.values(ROLES)) {
      assert.equal(await timelock.hasRole(role, deployer.address), false, "the deployer must hold no role");
    }
    assert.equal(await timelock.hasRole(ROLES.DEFAULT_ADMIN_ROLE, timelockAddress), true);
    for (const role of [ROLES.PROPOSER_ROLE, ROLES.EXECUTOR_ROLE, ROLES.CANCELLER_ROLE]) {
      assert.equal(await timelock.getRoleAdmin(role), ROLES.DEFAULT_ADMIN_ROLE);
    }
  });

  it("the former deployer can no longer grant roles or change the delay", async () => {
    const asFormerAdmin = timelock.connect(deployer);
    await assert.rejects(asFormerAdmin.grantRole(ROLES.CANCELLER_ROLE, newMember.address));
    await assert.rejects(asFormerAdmin.grantRole(ROLES.PROPOSER_ROLE, deployer.address));
    await assert.rejects(asFormerAdmin.revokeRole(ROLES.CANCELLER_ROLE, cancellerA.address));
    await assert.rejects(asFormerAdmin.updateDelay(0));
    // Nor can the proposer shorten the wait directly.
    await assert.rejects(timelock.connect(proposer).updateDelay(0));
  });

  it("propose-compose-hash schedules the approval; it cannot run before the delay", async () => {
    // Stand-in app contracts owned by the timelock (see contracts/stand-ins/).
    const artifact = JSON.parse(
      readFileSync(join(here, "test-artifacts", "contracts", "stand-ins", "ComposeHashStandIn.sol", "ComposeHashStandIn.json"), "utf8"),
    );
    const factory = new ContractFactory(artifact.abi, artifact.bytecode, deployer);
    app = await factory.deploy(timelockAddress, APP_VERSIONS.basic.managementInterfaceId);
    await app.waitForDeployment();
    epochApp = await factory.deploy(timelockAddress, APP_VERSIONS.epoch.managementInterfaceId);
    await epochApp.waitForDeployment();
    // Cancel-only addresses need gas money to cancel.
    for (const canceller of [cancellerA, cancellerB]) {
      await (await deployer.sendTransaction({ to: canceller.address, value: parseEther("1") })).wait();
    }
    // The owner check is real: nobody but the timelock can approve a hash.
    await assert.rejects(app.connect(proposer).addComposeHash(HASH_A));

    const flags = ["--timelock", timelockAddress, "--app", await app.getAddress(), "--app-version", "basic", "--compose-hash", HASH_A, ...chain()];

    const notProposer = cli(["propose-compose-hash", ...flags], { INSIGHTS_DEPLOYER_KEY: outsider.privateKey });
    assert.equal(notProposer.code, 1);
    assert.match(notProposer.stderr, /does not have PROPOSER_ROLE/);

    const wrongVersion = cli(["propose-compose-hash", ...flags.map((f) => (f === "basic" ? "epoch" : f)), "--epoch", "0"], asProposer());
    assert.equal(wrongVersion.code, 1);
    assert.match(wrongVersion.stderr, /version is probably wrong/);

    const dry = cli(["propose-compose-hash", "--dry-run", ...flags], asProposer());
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.problems, []);
    assert.equal(dry.json.transactions[0].to, timelockAddress);
    assert.equal(await timelock.isOperation(dry.json.operationId), false, "a dry run must not schedule");

    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    const id = proposed.json.operationId;
    assert.equal(id, dry.json.operationId, "the operation id is deterministic");
    assert.equal(await timelock.isOperationPending(id), true);
    assert.equal(await timelock.isOperationReady(id), false);
    const scheduledAt = (await provider.getBlock(proposed.json.block)).timestamp;
    assert.equal(BigInt(proposed.json.earliestExecution.unixSeconds), BigInt(scheduledAt + DELAY_SECONDS));

    // Too early: the script refuses, and so does the contract when called directly.
    const early = cli(["execute", ...flags], asProposer());
    assert.equal(early.code, 1);
    assert.match(early.stderr, /still waiting/);
    const call = proposed.json.calls[0];
    const direct = timelock.connect(proposer);
    await assert.rejects(direct.executeBatch([call.target], [0], [call.data], ZeroHash, proposed.json.salt));
    await advanceTime(DELAY_SECONDS - 3600);
    await assert.rejects(direct.executeBatch([call.target], [0], [call.data], ZeroHash, proposed.json.salt));
    assert.equal(await app.allowedComposeHashes(HASH_A), false);

    // And the proposer cannot schedule anything with a shorter wait.
    await assert.rejects(direct.schedule(call.target, 0, call.data, ZeroHash, "0x" + "11".repeat(32), 60));
  });

  it("a non-canceller cannot cancel; a cancel-only key can, and can do nothing else", async () => {
    const flags = ["--timelock", timelockAddress, "--app", await app.getAddress(), "--app-version", "basic", "--compose-hash", HASH_A, ...chain()];
    const id = cli(["propose-compose-hash", "--dry-run", ...flags], asProposer()).json.operationId;
    const cancelFlags = ["cancel", "--timelock", timelockAddress, "--id", id, ...chain()];

    const byOutsider = cli(cancelFlags, { INSIGHTS_CANCEL_KEY: outsider.privateKey });
    assert.equal(byOutsider.code, 1);
    assert.match(byOutsider.stderr, /does not have CANCELLER_ROLE/);
    await assert.rejects(timelock.connect(outsider).cancel(id));
    await assert.rejects(timelock.connect(deployer).cancel(id));
    assert.equal(await timelock.isOperationPending(id), true);

    // The deployer key variable is not accepted for cancelling.
    const wrongVariable = cli(cancelFlags, { INSIGHTS_DEPLOYER_KEY: cancellerA.key });
    assert.equal(wrongVariable.code, 2);
    assert.match(wrongVariable.stderr, /INSIGHTS_CANCEL_KEY/);

    const dry = cli([...cancelFlags, "--dry-run"], { INSIGHTS_CANCEL_KEY: cancellerA.key });
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.problems, []);
    assert.equal(await timelock.isOperationPending(id), true, "a dry run must not cancel");

    const cancelled = cli(cancelFlags, { INSIGHTS_CANCEL_KEY: cancellerA.key });
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.ok(!(cancelled.stdout + cancelled.stderr).includes(cancellerA.key.slice(2)), "the key must not be printed");
    assert.equal(cancelled.json.cancelledBy, cancellerA.address);
    assert.equal(await timelock.isOperation(id), false);

    // Even after the full delay the cancelled operation cannot run.
    await advanceTime(DELAY_SECONDS);
    const afterCancel = cli(["execute", ...flags], asProposer());
    assert.equal(afterCancel.code, 1);
    assert.match(afterCancel.stderr, /not scheduled/);
    assert.equal(await app.allowedComposeHashes(HASH_A), false);

    // The cancel-only key cannot propose, execute, grant roles or change the delay.
    const limited = timelock.connect(new Wallet(cancellerA.key, provider));
    const appAddress = await app.getAddress();
    const data = app.interface.encodeFunctionData("addComposeHash", [HASH_C]);
    await assert.rejects(limited.schedule(appAddress, 0, data, ZeroHash, ZeroHash, DELAY_SECONDS));
    await assert.rejects(limited.execute(appAddress, 0, data, ZeroHash, ZeroHash));
    await assert.rejects(limited.grantRole(ROLES.PROPOSER_ROLE, cancellerA.address));
    await assert.rejects(limited.updateDelay(0));
    const viaCli = cli(["propose-compose-hash", ...flags], { INSIGHTS_DEPLOYER_KEY: cancellerA.key });
    assert.equal(viaCli.code, 1);
    assert.match(viaCli.stderr, /does not have PROPOSER_ROLE/);
  });

  it("proposed again, the approval executes once the delay has passed", async () => {
    const flags = ["--timelock", timelockAddress, "--app", await app.getAddress(), "--app-version", "basic", "--compose-hash", HASH_A, ...chain()];
    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    const id = proposed.json.operationId;

    const twice = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /already exists/);

    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(await timelock.isOperationReady(id), true);

    const byOutsider = cli(["execute", ...flags], { INSIGHTS_DEPLOYER_KEY: outsider.privateKey });
    assert.equal(byOutsider.code, 1);
    assert.match(byOutsider.stderr, /does not have EXECUTOR_ROLE/);

    const dry = cli(["execute", "--dry-run", ...flags], asProposer());
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(await app.allowedComposeHashes(HASH_A), false, "a dry run must not execute");

    const executed = cli(["execute", ...flags], asProposer());
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(executed.json.state, "Done");
    assert.equal(await timelock.isOperationDone(id), true);
    assert.equal(await app.allowedComposeHashes(HASH_A), true);

    // An executed operation can be neither cancelled nor run a second time.
    const lateCancel = cli(["cancel", "--timelock", timelockAddress, "--id", id, ...chain()], { INSIGHTS_CANCEL_KEY: cancellerB.key });
    assert.equal(lateCancel.code, 1);
    assert.match(lateCancel.stderr, /not pending/);
    const again = cli(["execute", ...flags], asProposer());
    assert.equal(again.code, 1);
    assert.match(again.stderr, /already executed/);
  });

  it("--remove approves the new hash and removes the old one in one operation", async () => {
    const flags = [
      "--timelock", timelockAddress, "--app", await app.getAddress(), "--app-version", "basic",
      "--compose-hash", HASH_B, "--remove", HASH_A, ...chain(),
    ];
    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    assert.equal(proposed.json.calls.length, 2);
    await advanceTime(DELAY_SECONDS + 1);
    const executed = cli(["execute", ...flags], asProposer());
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(await app.allowedComposeHashes(HASH_B), true);
    assert.equal(await app.allowedComposeHashes(HASH_A), false);
  });

  it("the epoch-style calls (--app-version epoch) are accepted by a contract with those signatures", async () => {
    const common = ["--timelock", timelockAddress, "--app", await epochApp.getAddress(), "--app-version", "epoch", ...chain()];

    const missingEpoch = cli(["propose-compose-hash", ...common, "--compose-hash", HASH_B], asProposer());
    assert.equal(missingEpoch.code, 2);
    assert.match(missingEpoch.stderr, /needs --epoch/);

    const add = [...common, "--epoch", "1", "--compose-hash", HASH_B];
    assert.equal(cli(["propose-compose-hash", ...add], asProposer()).code, 0);
    await advanceTime(DELAY_SECONDS + 1);
    const executed = cli(["execute", ...add], asProposer());
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(await epochApp.allowedComposeHashesAtEpoch(1, HASH_B), true);
    assert.equal(await epochApp.allowedComposeHashesAtEpoch(0, HASH_B), false);

    const swap = [...common, "--epoch", "1", "--compose-hash", HASH_C, "--remove", HASH_B];
    assert.equal(cli(["propose-compose-hash", ...swap], asProposer()).code, 0);
    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(cli(["execute", ...swap], asProposer()).code, 0);
    assert.equal(await epochApp.allowedComposeHashesAtEpoch(1, HASH_C), true);
    assert.equal(await epochApp.allowedComposeHashesAtEpoch(1, HASH_B), false);
  });

  it("a new canceller can only be added through the timelock itself, after the delay", async () => {
    const salt = "0x" + "77".repeat(32);
    const data = timelock.interface.encodeFunctionData("grantRole", [ROLES.CANCELLER_ROLE, newMember.address]);

    // Directly: refused for everyone, including the proposer and an existing canceller.
    for (const who of [deployer, proposer, outsider, new Wallet(cancellerB.key, provider)]) {
      await assert.rejects(timelock.connect(who).grantRole(ROLES.CANCELLER_ROLE, newMember.address));
    }
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, newMember.address), false);

    // Through the timelock: scheduled in public, waits, then takes effect.
    const asProposerContract = timelock.connect(proposer);
    await (await asProposerContract.schedule(timelockAddress, 0, data, ZeroHash, salt, DELAY_SECONDS)).wait();
    await assert.rejects(asProposerContract.execute(timelockAddress, 0, data, ZeroHash, salt));
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, newMember.address), false);
    await advanceTime(DELAY_SECONDS + 1);
    await (await asProposerContract.execute(timelockAddress, 0, data, ZeroHash, salt)).wait();
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, newMember.address), true);
  });

  it("status reports the delay, the role holders, the operations with decoded calls, and the app's owner", async () => {
    // Leave one operation pending so status has something waiting to show.
    const appAddress = await app.getAddress();
    const flags = ["--timelock", timelockAddress, "--app", appAddress, "--app-version", "basic", "--compose-hash", HASH_C, ...chain()];
    const pending = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(pending.code, 0, pending.stderr);

    const result = cli(["status", "--timelock", timelockAddress, "--app", appAddress, ...chain()]);
    assert.equal(result.code, 0, result.stderr);
    const s = result.json;
    assert.equal(s.codeIsOpenZeppelinTimelock, true);
    assert.equal(s.delaySeconds, String(DELAY_SECONDS));
    assert.deepEqual(s.roles.DEFAULT_ADMIN_ROLE, [timelockAddress]);
    assert.deepEqual(s.roles.EXECUTOR_ROLE, [proposer.address]);
    assert.deepEqual(s.roles.PROPOSER_ROLE, [proposer.address]);
    // OpenZeppelin gives every proposer the canceller role as well.
    assert.deepEqual(
      [...s.roles.CANCELLER_ROLE].sort(),
      [proposer.address, cancellerA.address, cancellerB.address, newMember.address].sort(),
    );
    assert.equal(s.pendingOperations.length, 1);
    assert.equal(s.pendingOperations[0].operationId, pending.json.operationId);
    assert.equal(s.pendingOperations[0].state, "Waiting");
    assert.equal(s.pendingOperations[0].calls[0].meaning, `addComposeHash(${HASH_C}) on ${appAddress}`);
    const grant = s.otherOperations.find((op) => op.calls.some((c) => c.meaning.startsWith("grantRole(CANCELLER_ROLE")));
    assert.ok(grant, "the role change shows up as a decoded timelock operation");
    assert.equal(grant.state, "Done");
    assert.ok(s.otherOperations.some((op) => op.history.includes("Cancelled")));
    assert.equal(s.app.owner, timelockAddress);
    assert.equal(s.app.ownerIsTimelock, true);
    assert.deepEqual(s.app.reportsManagementInterface, { basic: true, epoch: false });

    const one = cli(["status", "--timelock", timelockAddress, "--id", pending.json.operationId, ...chain()]);
    assert.equal(one.json.pendingOperations.length + one.json.otherOperations.length, 1);

    // A call this tool does not know is labelled as unknown, not guessed at.
    assert.match(decodeCall(timelockAddress, "0xdeadbeef"), /^UNKNOWN call \(selector 0xdeadbeef\)/);
  });

  it("create-app creates the app through the key service with the timelock as owner from the start", async () => {
    const artifact = JSON.parse(
      readFileSync(join(here, "test-artifacts", "contracts", "stand-ins", "KmsFactoryStandIn.sol", "KmsFactoryStandIn.json"), "utf8"),
    );
    const kms = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy();
    await kms.waitForDeployment();
    const kmsAddress = await kms.getAddress();
    const DEVICE = "0x" + "d4".repeat(32);
    const flags = [
      "--kms", kmsAddress, "--timelock", timelockAddress, "--compose-hash", HASH_A,
      "--contract-upgrades", "disabled", "--device-id", DEVICE, ...chain(),
    ];

    // Choices that must be made out loud.
    const noUpgradeChoice = cli(["create-app", ...flags.filter((f) => f !== "--contract-upgrades" && f !== "disabled")], asDeployer());
    assert.equal(noUpgradeChoice.code, 2);
    assert.match(noUpgradeChoice.stderr, /--contract-upgrades is required/);
    const bothDevices = cli(["create-app", ...flags, "--allow-any-device"], asDeployer());
    assert.equal(bothDevices.code, 2);
    assert.match(bothDevices.stderr, /exactly one of --allow-any-device or --device-id/);

    // The owner must be a finished timelock, not any address.
    const notATimelock = cli(["create-app", ...flags.map((f) => (f === timelockAddress ? kmsAddress : f))], asDeployer());
    assert.equal(notATimelock.code, 1);
    assert.match(notATimelock.stderr, /is not the OpenZeppelin TimelockController/);
    const noKms = cli(["create-app", ...flags.map((f) => (f === kmsAddress ? outsider.address : f))], asDeployer());
    assert.equal(noKms.code, 1);
    assert.match(noKms.stderr, /no contract at --kms/);

    const blockBefore = await provider.getBlockNumber();
    const dry = cli(["create-app", "--dry-run", "--from", deployer.address, ...flags]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.problems, []);
    assert.equal(dry.json.transactions[0].to, kmsAddress);
    assert.deepEqual(
      [...kms.interface.decodeFunctionData("deployAndRegisterApp", dry.json.transactions[0].data)],
      [timelockAddress, true, true, false, DEVICE, HASH_A],
    );
    assert.equal(await provider.getBlockNumber(), blockBefore, "a dry run must not send anything");
    assert.equal(await provider.getCode(dry.json.predictedApp), "0x");

    const created = cli(["create-app", ...flags], asDeployer());
    assert.equal(created.code, 0, created.stderr);
    assert.ok(!(created.stdout + created.stderr).includes(deployer.privateKey.slice(2)), "the key must not be printed");
    assert.equal(created.json.verified, true);
    assert.equal(created.json.app, dry.json.predictedApp);
    assert.equal(created.json.appVersion, "basic");

    // Independent reads, not the script's own summary.
    const created_app = new Contract(
      created.json.app,
      [
        "function owner() view returns (address)",
        "function upgradesDisabled() view returns (bool)",
        "function requireTcbUpToDate() view returns (bool)",
        "function allowAnyDevice() view returns (bool)",
        "function allowedDeviceIds(bytes32) view returns (bool)",
        "function allowedComposeHashes(bytes32) view returns (bool)",
        "function addComposeHash(bytes32)",
      ],
      provider,
    );
    assert.equal(await created_app.owner(), timelockAddress);
    assert.equal(await created_app.upgradesDisabled(), true);
    assert.equal(await created_app.requireTcbUpToDate(), true);
    assert.equal(await created_app.allowAnyDevice(), false);
    assert.equal(await created_app.allowedDeviceIds(DEVICE), true);
    assert.equal(await created_app.allowedComposeHashes(HASH_A), true);
    assert.equal(await kms.registeredApps(created.json.app), true);
    // The key that created the app cannot approve a build on it.
    await assert.rejects(created_app.connect(deployer).addComposeHash(HASH_B));
    await assert.rejects(created_app.connect(proposer).addComposeHash(HASH_B));

    // The other choices reach the contract too.
    const loose = cli(
      ["create-app", "--kms", kmsAddress, "--timelock", timelockAddress, "--compose-hash", HASH_B,
        "--contract-upgrades", "allowed", "--allow-any-device", "--allow-outdated-tcb", ...chain()],
      asDeployer(),
    );
    assert.equal(loose.code, 0, loose.stderr);
    const looseApp = created_app.attach(loose.json.app);
    assert.equal(await looseApp.upgradesDisabled(), false);
    assert.equal(await looseApp.requireTcbUpToDate(), false);
    assert.equal(await looseApp.allowAnyDevice(), true);

    // And the new app takes upgrades through the timelock like any other.
    const upgrade = ["--timelock", timelockAddress, "--app", created.json.app, "--app-version", "basic", "--compose-hash", HASH_B, ...chain()];
    assert.equal(cli(["propose-compose-hash", ...upgrade], asProposer()).code, 0);
    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(cli(["execute", ...upgrade], asProposer()).code, 0);
    assert.equal(await created_app.allowedComposeHashes(HASH_B), true);
  });

  it("propose-canceller adds and removes a cancel key only after the delay, and a canceller can stop it", async () => {
    const joiner = account(5).connect(provider);
    await (await deployer.sendTransaction({ to: joiner.address, value: parseEther("1") })).wait();
    const add = ["--timelock", timelockAddress, "--add", joiner.address, ...chain()];

    const neither = cli(["propose-canceller", "--timelock", timelockAddress, ...chain()], asProposer());
    assert.equal(neither.code, 2);
    assert.match(neither.stderr, /exactly one of --add/);
    const notProposer = cli(["propose-canceller", ...add], { INSIGHTS_DEPLOYER_KEY: outsider.privateKey });
    assert.equal(notProposer.code, 1);
    assert.match(notProposer.stderr, /does not have PROPOSER_ROLE/);
    const already = cli(["propose-canceller", "--timelock", timelockAddress, "--add", cancellerA.address, ...chain()], asProposer());
    assert.equal(already.code, 1);
    assert.match(already.stderr, /already has CANCELLER_ROLE/);
    const notCancelOnly = cli(["propose-canceller", "--timelock", timelockAddress, "--remove-canceller", outsider.address, ...chain()], asProposer());
    assert.equal(notCancelOnly.code, 1);
    assert.match(notCancelOnly.stderr, /nothing to remove/);

    const proposed = cli(["propose-canceller", ...add], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    assert.equal(proposed.json.change, "add");
    assert.equal(proposed.json.calls[0].target, timelockAddress);
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, joiner.address), false, "no key before the delay");

    // An existing member's key can stop the addition.
    const stopped = cli(["cancel", "--timelock", timelockAddress, "--id", proposed.json.operationId, ...chain()], { INSIGHTS_CANCEL_KEY: cancellerB.key });
    assert.equal(stopped.code, 0, stopped.stderr);
    await advanceTime(DELAY_SECONDS + 1);
    const afterCancel = cli(["execute-canceller", ...add], asProposer());
    assert.equal(afterCancel.code, 1);
    assert.match(afterCancel.stderr, /not scheduled/);
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, joiner.address), false);

    // Proposed again and left alone, it goes through after the delay.
    assert.equal(cli(["propose-canceller", ...add], asProposer()).code, 0);
    const early = cli(["execute-canceller", ...add], asProposer());
    assert.equal(early.code, 1);
    assert.match(early.stderr, /still waiting/);
    await advanceTime(DELAY_SECONDS + 1);
    const executed = cli(["execute-canceller", ...add], asProposer());
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, joiner.address), true);
    for (const role of [ROLES.PROPOSER_ROLE, ROLES.EXECUTOR_ROLE, ROLES.DEFAULT_ADMIN_ROLE]) {
      assert.equal(await timelock.hasRole(role, joiner.address), false);
    }

    // Leaving the pool: removal also waits, and the key works until then.
    const remove = ["--timelock", timelockAddress, "--remove-canceller", joiner.address, ...chain()];
    const removal = cli(["propose-canceller", ...remove], asProposer());
    assert.equal(removal.code, 0, removal.stderr);
    assert.notEqual(removal.json.operationId, proposed.json.operationId);
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, joiner.address), true);
    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(cli(["execute-canceller", ...remove], asProposer()).code, 0);
    assert.equal(await timelock.hasRole(ROLES.CANCELLER_ROLE, joiner.address), false);
    await assert.rejects(timelock.connect(joiner).cancel(proposed.json.operationId));
  });

  // -------------------------------------------------------------------------
  // Member veto: cancel by signature, no wallet for the member
  // -------------------------------------------------------------------------

  let vetoTimelockAddress, vetoTimelock, vetoAddress, veto, vetoApp;
  let memberA, memberB; // random keys that never hold any money
  const asMember = (wallet) => ({ INSIGHTS_MEMBER_KEY: wallet.privateKey });
  const asOutsider = () => ({ INSIGHTS_DEPLOYER_KEY: outsider.privateKey });
  const VETO_READ_ABI = [
    "function timelock() view returns (address)",
    "function enroller() view returns (address)",
    "function isMember(address) view returns (bool)",
    "function memberCount() view returns (uint256)",
    "function addMember(address)",
    "function removeMember(address)",
    "function veto(bytes32, bytes)",
  ];

  it("the committed MemberVeto build matches a fresh compile", () => {
    const committed = JSON.parse(readFileSync(BUILD_FILE, "utf8"));
    assert.deepEqual(committed, JSON.parse(JSON.stringify(freshBuild())));
  });

  it("deploy-timelock --member-veto deploys the veto contract as the only canceller besides the proposer", async () => {
    memberA = Wallet.createRandom();
    memberB = Wallet.createRandom();
    const flags = [
      "deploy-timelock", "--delay-hours", "48", "--proposer", proposer.address, "--member-veto",
      "--members", `${memberA.address},${memberB.address}`, ...chain(),
    ];
    const stray = cli(["deploy-timelock", "--delay-hours", "48", "--proposer", proposer.address,
      "--cancellers", cancellerA.address, "--members", memberA.address, ...chain()], asDeployer());
    assert.equal(stray.code, 2);
    assert.match(stray.stderr, /only apply with --member-veto/);

    const blockBefore = await provider.getBlockNumber();
    const dry = cli([...flags, "--dry-run", "--from", deployer.address]);
    assert.equal(dry.code, 0, dry.stderr);
    assert.equal(dry.json.transactions.length, 4); // timelock, veto contract, one grant, renounce
    assert.equal(dry.json.transactions[1].to, null);
    assert.equal(await provider.getBlockNumber(), blockBefore, "a dry run must not send anything");

    const result = cli(flags, asDeployer());
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.json.verified, true);
    assert.equal(result.json.timelock, dry.json.predictedTimelock);
    assert.equal(result.json.memberVeto, dry.json.predictedMemberVeto);
    vetoTimelockAddress = result.json.timelock;
    vetoAddress = result.json.memberVeto;
    vetoTimelock = new Contract(vetoTimelockAddress, TIMELOCK_ABI, provider);
    veto = new Contract(vetoAddress, VETO_READ_ABI, provider);

    // Independent reads.
    assert.equal(await veto.timelock(), vetoTimelockAddress);
    assert.equal(await veto.enroller(), proposer.address);
    assert.equal(await veto.memberCount(), 2n);
    assert.equal(await veto.isMember(memberA.address), true);
    assert.equal(await veto.isMember(memberB.address), true);
    assert.equal(await veto.isMember(outsider.address), false);
    assert.equal(await vetoTimelock.hasRole(ROLES.CANCELLER_ROLE, vetoAddress), true);
    for (const role of [ROLES.PROPOSER_ROLE, ROLES.EXECUTOR_ROLE, ROLES.DEFAULT_ADMIN_ROLE]) {
      assert.equal(await vetoTimelock.hasRole(role, vetoAddress), false, "the veto contract may only cancel");
    }
    for (const role of Object.values(ROLES)) {
      assert.equal(await vetoTimelock.hasRole(role, deployer.address), false, "the deployer must hold no role");
      assert.equal(await vetoTimelock.hasRole(role, memberA.address), false, "members hold no role themselves");
    }
  });

  it("a member with no money vetoes by signature, and anyone can carry it to the chain", async () => {
    const artifact = JSON.parse(
      readFileSync(join(here, "test-artifacts", "contracts", "stand-ins", "ComposeHashStandIn.sol", "ComposeHashStandIn.json"), "utf8"),
    );
    vetoApp = await new ContractFactory(artifact.abi, artifact.bytecode, deployer).deploy(vetoTimelockAddress, APP_VERSIONS.basic.managementInterfaceId);
    await vetoApp.waitForDeployment();
    const flags = ["--timelock", vetoTimelockAddress, "--app", await vetoApp.getAddress(), "--app-version", "basic", "--compose-hash", HASH_A, ...chain()];
    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    const id = proposed.json.operationId;
    const sign = ["sign-veto", "--veto", vetoAddress, "--id", id, ...chain()];

    const noKey = cli(sign);
    assert.equal(noKey.code, 2);
    assert.match(noKey.stderr, /INSIGHTS_MEMBER_KEY/);
    const notMember = cli(sign, asMember(outsider));
    assert.equal(notMember.code, 1);
    assert.match(notMember.stderr, /is not a member/);

    const blockBefore = await provider.getBlockNumber();
    const signed = cli(sign, asMember(memberA));
    assert.equal(signed.code, 0, signed.stderr);
    assert.ok(!(signed.stdout + signed.stderr).includes(memberA.privateKey.slice(2)), "the key must not be printed");
    assert.equal(signed.json.member, memberA.address);
    assert.equal(await provider.getBlockNumber(), blockBefore, "signing must not send anything");
    assert.equal(await vetoTimelock.isOperationPending(id), true);
    const relay = ["relay-veto", "--veto", vetoAddress, "--id", id, "--signature", signed.json.signature, ...chain()];

    // A signature by someone who is not a member is refused by the tool and by the contract.
    const forged = await outsider.signTypedData(
      { name: "Router insights member veto", version: "1", chainId: 31337, verifyingContract: vetoAddress },
      { Veto: [{ name: "operationId", type: "bytes32" }] },
      { operationId: id },
    );
    const forgedRelay = cli(relay.map((f) => (f === signed.json.signature ? forged : f)), asOutsider());
    assert.equal(forgedRelay.code, 1);
    assert.match(forgedRelay.stderr, /not a member/);
    await assert.rejects(veto.connect(outsider).veto(id, forged));
    // The member's signature does not work for another operation.
    const otherFlags = flags.map((f) => (f === HASH_A ? HASH_C : f));
    const other = cli(["propose-compose-hash", ...otherFlags], asProposer());
    assert.equal(other.code, 0, other.stderr);
    await assert.rejects(veto.connect(outsider).veto(other.json.operationId, signed.json.signature));
    assert.equal(await vetoTimelock.isOperationPending(other.json.operationId), true);
    assert.equal(await vetoTimelock.isOperationPending(id), true);

    const dry = cli([...relay, "--dry-run"], asOutsider());
    assert.equal(dry.code, 0, dry.stderr);
    assert.deepEqual(dry.json.problems, []);
    assert.equal(await vetoTimelock.isOperationPending(id), true, "a dry run must not cancel");

    // Someone unrelated, who has money, carries the member's veto to the chain.
    const relayed = cli(relay, asOutsider());
    assert.equal(relayed.code, 0, relayed.stderr);
    assert.equal(relayed.json.member, memberA.address);
    assert.equal(relayed.json.relayedBy, outsider.address);
    assert.equal(await vetoTimelock.isOperation(id), false);
    assert.equal(await provider.getBalance(memberA.address), 0n, "the member never held or spent anything");
    assert.equal(await provider.getTransactionCount(memberA.address), 0);

    // The proposer cannot shake the objection off by scheduling the same
    // operation again: the member's one signature cancels it again, with the
    // member doing nothing.
    await advanceTime(3600);
    assert.equal(cli(["propose-compose-hash", ...flags], asProposer()).code, 0);
    assert.equal(await vetoTimelock.isOperationPending(id), true);
    const again = cli(relay, asOutsider());
    assert.equal(again.code, 0, again.stderr);
    assert.equal(await vetoTimelock.isOperation(id), false);
    assert.equal(await provider.getTransactionCount(memberA.address), 0);

    // An operation nobody vetoes goes through after the wait; the vetoed one never does.
    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(cli(["execute", ...otherFlags], asProposer()).code, 0);
    assert.equal(await vetoApp.allowedComposeHashes(HASH_C), true);
    assert.equal(await vetoApp.allowedComposeHashes(HASH_A), false);
    const vetoed = cli(["execute", ...flags], asProposer());
    assert.equal(vetoed.code, 1);
    assert.match(vetoed.stderr, /not scheduled/);
  });

  it("a new member can veto at once; removing one waits, and the member can veto their own removal", async () => {
    const joiner = Wallet.createRandom();
    const add = ["add-member", "--veto", vetoAddress, "--member", joiner.address, ...chain()];
    const notEnroller = cli(add, asOutsider());
    assert.equal(notEnroller.code, 1);
    assert.match(notEnroller.stderr, /is not the enroller/);
    await assert.rejects(veto.connect(outsider).addMember(joiner.address));
    await assert.rejects(veto.connect(deployer).addMember(joiner.address));

    const added = cli(add, asProposer());
    assert.equal(added.code, 0, added.stderr);
    assert.equal(await veto.isMember(joiner.address), true);
    const twice = cli(add, asProposer());
    assert.equal(twice.code, 1);
    assert.match(twice.stderr, /already a member/);

    // In the same hour as joining, the new member stops an update.
    const flags = ["--timelock", vetoTimelockAddress, "--app", await vetoApp.getAddress(), "--app-version", "basic", "--compose-hash", HASH_B, ...chain()];
    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    const signed = cli(["sign-veto", "--veto", vetoAddress, "--id", proposed.json.operationId, ...chain()], asMember(joiner));
    assert.equal(signed.code, 0, signed.stderr);
    const relayed = cli(
      ["relay-veto", "--veto", vetoAddress, "--id", proposed.json.operationId, "--signature", signed.json.signature, ...chain()],
      asProposer(),
    );
    assert.equal(relayed.code, 0, relayed.stderr);
    assert.equal(await vetoTimelock.isOperation(proposed.json.operationId), false);

    // Nobody can remove a member directly, the enroller included.
    for (const who of [deployer, proposer, outsider]) {
      await assert.rejects(veto.connect(who).removeMember(joiner.address));
    }
    const remove = ["--timelock", vetoTimelockAddress, "--veto", vetoAddress, "--member", joiner.address, ...chain()];
    const noSuchMember = cli(["propose-remove-member", ...remove.map((f) => (f === joiner.address ? outsider.address : f))], asProposer());
    assert.equal(noSuchMember.code, 1);
    assert.match(noSuchMember.stderr, /nothing to remove/);

    const removal = cli(["propose-remove-member", ...remove], asProposer());
    assert.equal(removal.code, 0, removal.stderr);
    assert.equal(await veto.isMember(joiner.address), true, "still a member during the wait");

    // The known limit: the member being removed can veto the removal.
    const selfSigned = cli(["sign-veto", "--veto", vetoAddress, "--id", removal.json.operationId, ...chain()], asMember(joiner));
    assert.equal(selfSigned.code, 0, selfSigned.stderr);
    assert.equal(
      cli(["relay-veto", "--veto", vetoAddress, "--id", removal.json.operationId, "--signature", selfSigned.json.signature, ...chain()], asOutsider()).code,
      0,
    );
    assert.equal(await vetoTimelock.isOperation(removal.json.operationId), false);

    // Left alone, the removal goes through after the wait, and the key stops working.
    assert.equal(cli(["propose-remove-member", ...remove, "--round", "1"], asProposer()).code, 0);
    const early = cli(["execute-remove-member", ...remove, "--round", "1"], asProposer());
    assert.equal(early.code, 1);
    assert.match(early.stderr, /still waiting/);
    await advanceTime(DELAY_SECONDS + 1);
    const executed = cli(["execute-remove-member", ...remove, "--round", "1"], asProposer());
    assert.equal(executed.code, 0, executed.stderr);
    assert.equal(await veto.isMember(joiner.address), false);
    assert.equal(await veto.memberCount(), 2n);
    assert.equal(cli(["propose-compose-hash", ...flags], asProposer()).code, 0);
    const afterRemoval = cli(["sign-veto", "--veto", vetoAddress, "--id", proposed.json.operationId, ...chain()], asMember(joiner));
    assert.equal(afterRemoval.code, 1);
    assert.match(afterRemoval.stderr, /is not a member/);
  });

  // -------------------------------------------------------------------------
  // The veto contract pays for the veto itself (ERC-4337)
  //
  // The entry point here is the real one: its code was copied from Base
  // (test-fixtures/) and placed at the same address on the local chain. No
  // bundler runs locally, so the test plays the bundler by calling handleOps.
  // -------------------------------------------------------------------------

  const USER_OP = "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";
  const ENTRY_POINT_TEST_ABI = [
    `function handleOps(${USER_OP}[] ops, address beneficiary)`,
    `function getUserOpHash(${USER_OP} userOp) view returns (bytes32)`,
    "function getNonce(address sender, uint192 key) view returns (uint256)",
    "function balanceOf(address account) view returns (uint256)",
  ];
  const GAS = ["--verification-gas", "200000", "--call-gas", "200000", "--pre-verification-gas", "60000", "--max-fee-wei", "100000000", "--priority-fee-wei", "1000000"];
  const pack = (high, low) => "0x" + BigInt(high).toString(16).padStart(32, "0") + BigInt(low).toString(16).padStart(32, "0");

  /** A user operation built and signed by the test itself, for the cases the tool would never produce. */
  async function handMadeOp(entryPoint, { signer, callData, maxFee = 100000000n, nonceOf = signer.address }) {
    const op = {
      sender: vetoAddress,
      nonce: await entryPoint.getNonce(vetoAddress, BigInt(nonceOf)),
      initCode: "0x",
      callData,
      accountGasLimits: pack(200000, 200000),
      preVerificationGas: 60000,
      gasFees: pack(1000000, maxFee),
      paymasterAndData: "0x",
      signature: "0x",
    };
    op.signature = signer.signingKey.sign(await entryPoint.getUserOpHash(op)).serialized;
    return op;
  }

  it("the veto contract pays for a member's veto from that member's own budget, and nobody else can spend it", async () => {
    const entryPoint = new Contract(ENTRY_POINT_V09, ENTRY_POINT_TEST_ABI, outsider);
    // The test plays the bundler. An explicit gas limit, because the local chain caps estimates.
    const bundle = async (op) => (await entryPoint.handleOps([op], newMember.address, { gasLimit: 3000000n })).wait();
    const paidVeto = new Contract(
      vetoAddress,
      [
        "function budget(address) view returns (uint256)",
        "function totalBudget() view returns (uint256)",
        "function pot() view returns (uint256)",
        "function vetoAsMember(bytes32, address)",
        "function addMember(address)",
        "function fund(address) payable",
        "function withdraw(address, uint256)",
        `function validateUserOp(${USER_OP} userOp, bytes32 userOpHash, uint256 missingAccountFunds) returns (uint256)`,
      ],
      provider,
    );
    // Every operation in this test is charged the same: (200000 + 200000 + 60000) gas at 0.1 gwei.
    const CHARGE = 460000n * 100000000n;
    const sendDry = (wallet, id, gas = GAS) =>
      cli(["send-veto", "--dry-run", "--veto", vetoAddress, "--id", id, ...gas, ...chain()], asMember(wallet));
    assert.equal(await paidVeto.pot(), 0n);

    // Anyone can add to a member's budget; only members have one.
    const fund = (member, eth, env = asDeployer()) => cli(["fund-veto", "--veto", vetoAddress, "--member", member, "--eth", eth, ...chain()], env);
    const notAMember = fund(outsider.address, "0.0002");
    assert.equal(notAMember.code, 1);
    assert.match(notAMember.stderr, /is not a member/);
    await assert.rejects(paidVeto.connect(deployer).fund(outsider.address, { value: 1n }));
    const funded = fund(memberA.address, "0.0002", asOutsider());
    assert.equal(funded.code, 0, funded.stderr);
    assert.equal(fund(memberB.address, "0.0001").code, 0);
    assert.equal(await paidVeto.budget(memberA.address), parseEther("0.0002"));
    assert.equal(await paidVeto.budget(memberB.address), parseEther("0.0001"));
    assert.equal(await paidVeto.totalBudget(), parseEther("0.0003"));
    assert.equal(await paidVeto.pot(), parseEther("0.0003"));
    assert.equal(await entryPoint.balanceOf(vetoAddress), parseEther("0.0003"));

    const HASH_E = "0x" + "e5".repeat(32);
    const flags = ["--timelock", vetoTimelockAddress, "--app", await vetoApp.getAddress(), "--app-version", "basic", "--compose-hash", HASH_E, ...chain()];
    const proposed = cli(["propose-compose-hash", ...flags], asProposer());
    assert.equal(proposed.code, 0, proposed.stderr);
    const id = proposed.json.operationId;

    // The member's agent builds and signs the operation. Nothing is sent yet.
    const built = sendDry(memberA, id);
    assert.equal(built.code, 0, built.stderr);
    assert.deepEqual(built.json.problems, []);
    assert.equal(BigInt(built.json.maxCostWei), CHARGE);
    assert.ok(!(built.stdout + built.stderr).includes(memberA.privateKey.slice(2)), "the key must not be printed");
    assert.equal(await vetoTimelock.isOperationPending(id), true);

    // A bundler (here: the test) includes it. The contract pays; the member does not.
    const potAtStart = await paidVeto.pot();
    const bundlerBefore = await provider.getBalance(newMember.address);
    await bundle(built.json.packedUserOperation);
    assert.equal(await vetoTimelock.isOperation(id), false, "the operation is cancelled");
    const paid = potAtStart - (await paidVeto.pot());
    assert.ok(paid > 0n && paid <= CHARGE, "the fee came out of the deposit, and no more than the charge");
    assert.equal((await provider.getBalance(newMember.address)) - bundlerBefore, paid, "the bundler was paid from it");
    assert.equal(await paidVeto.budget(memberA.address), parseEther("0.0002") - CHARGE, "the member's budget is charged the maximum");
    assert.equal(await paidVeto.budget(memberB.address), parseEther("0.0001"), "another member's budget is untouched");
    assert.equal(await provider.getBalance(memberA.address), 0n, "the member never held or spent anything");
    assert.equal(await provider.getTransactionCount(memberA.address), 0);

    // The same signed operation cannot be used twice.
    await assert.rejects(bundle(built.json.packedUserOperation));

    // What the contract will not pay for. None of these moves the deposit or anyone's budget.
    assert.equal(cli(["propose-compose-hash", ...flags], asProposer()).code, 0);
    const junk = Wallet.createRandom();
    assert.equal(cli(["add-member", "--veto", vetoAddress, "--member", junk.address, ...chain()], asProposer()).code, 0);
    const potBeforeBad = await paidVeto.pot();
    const nonceBBefore = await entryPoint.getNonce(vetoAddress, BigInt(memberB.address));
    const vetoCall = (member) => paidVeto.interface.encodeFunctionData("vetoAsMember", [id, member]);
    const bad = {
      "someone who is not a member": await handMadeOp(entryPoint, { signer: outsider, callData: vetoCall(outsider.address) }),
      "a member's name on another key's signature": await handMadeOp(entryPoint, { signer: outsider, callData: vetoCall(memberA.address), nonceOf: memberA.address }),
      "a member using another member's nonce sequence": await handMadeOp(entryPoint, { signer: memberA, callData: vetoCall(memberA.address), nonceOf: memberB.address }),
      "a member just added by the enroller, who has no budget": await handMadeOp(entryPoint, { signer: junk, callData: vetoCall(junk.address) }),
      "any call other than a veto (add a member)": await handMadeOp(entryPoint, { signer: memberA, callData: paidVeto.interface.encodeFunctionData("addMember", [outsider.address]) }),
      "any call other than a veto (take the deposit)": await handMadeOp(entryPoint, { signer: memberA, callData: paidVeto.interface.encodeFunctionData("withdraw", [outsider.address, 1n]) }),
      "a veto priced above the limit": await handMadeOp(entryPoint, { signer: memberA, callData: vetoCall(memberA.address), maxFee: 1000000000n }),
    };
    for (const [what, op] of Object.entries(bad)) {
      await assert.rejects(bundle(op), `must refuse: ${what}`);
    }
    assert.equal(await paidVeto.pot(), potBeforeBad);
    assert.equal(await paidVeto.budget(memberA.address), parseEther("0.0002") - CHARGE);
    assert.equal(await paidVeto.budget(memberB.address), parseEther("0.0001"));
    assert.equal(await entryPoint.getNonce(vetoAddress, BigInt(memberB.address)), nonceBBefore, "nobody used up member B's sequence");
    assert.equal(await vetoTimelock.isOperationPending(id), true);
    const tooDear = sendDry(memberA, id, GAS.map((g) => (g === "100000000" ? "1000000000" : g)));
    assert.equal(tooDear.code, 0, tooDear.stderr);
    assert.match(tooDear.json.problems.join("\n"), /over the contract's limit/);
    assert.match(sendDry(outsider, id).json.problems.join("\n"), /is not a member/);
    assert.match(sendDry(junk, id).json.problems.join("\n"), /budget is 0\.0 ETH/);

    // Only the entry point may use the paid path, and nobody takes from the deposit directly.
    await assert.rejects(paidVeto.connect(outsider).vetoAsMember(id, memberA.address));
    await assert.rejects(paidVeto.connect(outsider).validateUserOp(bad["a veto priced above the limit"], ZeroHash, 0));
    for (const who of [deployer, proposer, outsider]) {
      await assert.rejects(paidVeto.connect(who).withdraw(who.address, 1n));
    }
    assert.equal(await vetoTimelock.isOperationPending(id), true);

    // A member who wastes paid vetoes spends only their own budget, and then stops being paid for.
    const nothingThere = "0x" + "99".repeat(32);
    const wasteful = paidVeto.interface.encodeFunctionData("vetoAsMember", [nothingThere, memberA.address]);
    let wasted = 0;
    while ((await paidVeto.budget(memberA.address)) >= CHARGE) {
      await bundle(await handMadeOp(entryPoint, { signer: memberA, callData: wasteful }));
      wasted += 1;
    }
    assert.equal(wasted, 3, "0.0002 ETH pays for four of these charges; one was a real veto");
    await assert.rejects(bundle(await handMadeOp(entryPoint, { signer: memberA, callData: wasteful })));
    assert.match(sendDry(memberA, id).json.problems.join("\n"), /this member's budget is/);
    assert.equal(await paidVeto.budget(memberB.address), parseEther("0.0001"), "the other member lost nothing");
    assert.ok((await paidVeto.pot()) >= (await paidVeto.totalBudget()), "the deposit still covers every budget");

    // The other member can still veto at the contract's expense.
    const byB = sendDry(memberB, id);
    assert.deepEqual(byB.json.problems, []);
    await bundle(byB.json.packedUserOperation);
    assert.equal(await vetoTimelock.isOperation(id), false);
    assert.equal(await paidVeto.budget(memberB.address), parseEther("0.0001") - CHARGE);

    // And the member with no budget left can still veto the other way, at a relayer's expense.
    assert.equal(cli(["propose-compose-hash", ...flags], asProposer()).code, 0);
    const signed = cli(["sign-veto", "--veto", vetoAddress, "--id", id, ...chain()], asMember(memberA));
    assert.equal(signed.code, 0, signed.stderr);
    assert.equal(cli(["relay-veto", "--veto", vetoAddress, "--id", id, "--signature", signed.json.signature, ...chain()], asOutsider()).code, 0);
    assert.equal(await vetoTimelock.isOperation(id), false);

    // What belongs to no member can leave only through the timelock, after the wait;
    // what is in a member's budget cannot leave even then.
    const unallocated = (await paidVeto.pot()) - (await paidVeto.totalBudget());
    assert.ok(unallocated > 0n, "charging the maximum leaves a remainder that belongs to nobody");
    const direct = vetoTimelock.connect(proposer);
    const takeAll = paidVeto.interface.encodeFunctionData("withdraw", [outsider.address, unallocated + 1n]);
    const takeSpare = paidVeto.interface.encodeFunctionData("withdraw", [outsider.address, unallocated]);
    await (await direct.schedule(vetoAddress, 0, takeAll, ZeroHash, HASH_A, DELAY_SECONDS)).wait();
    await (await direct.schedule(vetoAddress, 0, takeSpare, ZeroHash, HASH_B, DELAY_SECONDS)).wait();
    await assert.rejects(direct.execute(vetoAddress, 0, takeSpare, ZeroHash, HASH_B), "not before the wait");
    await advanceTime(DELAY_SECONDS + 1);
    await assert.rejects(direct.execute(vetoAddress, 0, takeAll, ZeroHash, HASH_A), "a member's budget cannot be withdrawn");
    const outsiderBefore = await provider.getBalance(outsider.address);
    await (await direct.execute(vetoAddress, 0, takeSpare, ZeroHash, HASH_B)).wait();
    assert.equal((await provider.getBalance(outsider.address)) - outsiderBefore, unallocated);
    assert.equal(await paidVeto.pot(), await paidVeto.totalBudget());

    // Removing a funded member (through the timelock, after the wait) takes
    // their budget out of the total; the money stays in the deposit, belonging to nobody.
    assert.equal(fund(junk.address, "0.0001").code, 0);
    const totalBefore = await paidVeto.totalBudget();
    const potBefore = await paidVeto.pot();
    const remove = ["--timelock", vetoTimelockAddress, "--veto", vetoAddress, "--member", junk.address, ...chain()];
    assert.equal(cli(["propose-remove-member", ...remove], asProposer()).code, 0);
    assert.equal(await paidVeto.budget(junk.address), parseEther("0.0001"), "still theirs during the wait");
    await advanceTime(DELAY_SECONDS + 1);
    assert.equal(cli(["execute-remove-member", ...remove], asProposer()).code, 0);
    assert.equal(await paidVeto.budget(junk.address), 0n);
    assert.equal(await paidVeto.totalBudget(), totalBefore - parseEther("0.0001"));
    assert.equal(await paidVeto.pot(), potBefore);
    assert.equal((await paidVeto.pot()) - (await paidVeto.totalBudget()), parseEther("0.0001"));
  });
});
