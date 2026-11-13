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
import { APP_VERSIONS, ROLES, TIMELOCK_ABI, decodeCall } from "./upgrades.mjs";

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
    // Stand-in app contracts owned by the timelock (see test-contracts/).
    const artifact = JSON.parse(
      readFileSync(join(here, "test-artifacts", "test-contracts", "ComposeHashStandIn.sol", "ComposeHashStandIn.json"), "utf8"),
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
});
