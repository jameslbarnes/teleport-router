#!/usr/bin/env node
// Timelocked, cancellable compose-hash approvals for a dstack app contract.
//
// The app contract (dstack's DstackApp) is owned by an OpenZeppelin
// TimelockController. Approving a new build means: schedule the call in
// public, wait the fixed delay, execute. Any holder of a cancel-only key can
// cancel while it waits. See README.md.
//
// Rules this file keeps:
//   - signing keys come only from environment variables, never from argv,
//     and are never printed;
//   - every command that talks to a chain needs --rpc and --chain-id and
//     refuses when the chain's id differs;
//   - every command that sends a transaction supports --dry-run, which
//     prints the exact transactions and sends nothing.

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AbiCoder,
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  ZeroAddress,
  ZeroHash,
  getAddress,
  getCreateAddress,
  id as keccakText,
  isHexString,
  keccak256,
} from "ethers";

const require = createRequire(import.meta.url);
const OZ_VERSION = require("@openzeppelin/contracts/package.json").version;
const timelockArtifact = require("@openzeppelin/contracts/build/contracts/TimelockController.json");

export const TIMELOCK_ABI = timelockArtifact.abi;
export const timelockInterface = new Interface(TIMELOCK_ABI);

export const MIN_DELAY_HOURS = 48;
export const DEPLOYER_KEY_ENV = "INSIGHTS_DEPLOYER_KEY";
export const CANCEL_KEY_ENV = "INSIGHTS_CANCEL_KEY";

export const ROLES = {
  DEFAULT_ADMIN_ROLE: ZeroHash,
  PROPOSER_ROLE: keccakText("PROPOSER_ROLE"),
  EXECUTOR_ROLE: keccakText("EXECUTOR_ROLE"),
  CANCELLER_ROLE: keccakText("CANCELLER_ROLE"),
};
const ROLE_NAMES = Object.fromEntries(Object.entries(ROLES).map(([name, hash]) => [hash, name]));
const OPERATION_STATES = ["Unset", "Waiting", "Ready", "Done"];

// ---------------------------------------------------------------------------
// The one place that knows how a DstackApp approves or removes a compose hash.
//
// Signatures copied from Dstack-TEE/dstack, branch `next`, under
// dstack/kms/auth-eth/contracts (read on 2026-11-13, commit 76bd1f03):
//   basic: DstackApp v0.5.9 and v0.6.0 (test-utils/reference/...)
//          addComposeHash(bytes32), removeComposeHash(bytes32)
//   epoch: DstackApp.sol on `next` (app epochs)
//          addComposeHashAtEpoch(uint256,bytes32),
//          removeComposeHashAtEpochs(uint256,uint256,bytes32)
// Neither has been run against the real contracts; see README.md.
// ---------------------------------------------------------------------------

const BASIC_APP_ABI = [
  "function addComposeHash(bytes32 composeHash)",
  "function removeComposeHash(bytes32 composeHash)",
];

// The full IAppEpochManagement interface, in source order, so its ERC-165 id
// can be computed here instead of copied.
const EPOCH_MANAGEMENT_ABI = [
  "function addComposeHashAtEpoch(uint256 epoch, bytes32 composeHash)",
  "function addComposeHashAtEpochs(uint256 fromEpoch, uint256 toEpoch, bytes32 composeHash)",
  "function removeComposeHashAtEpoch(uint256 epoch, bytes32 composeHash)",
  "function removeComposeHashAtEpochs(uint256 fromEpoch, uint256 toEpoch, bytes32 composeHash)",
  "function addDeviceAtEpoch(uint256 epoch, bytes32 deviceId)",
  "function addDeviceAtEpochs(uint256 fromEpoch, uint256 toEpoch, bytes32 deviceId)",
  "function removeDeviceAtEpoch(uint256 epoch, bytes32 deviceId)",
  "function removeDeviceAtEpochs(uint256 fromEpoch, uint256 toEpoch, bytes32 deviceId)",
  "function setAllowAnyDevice(bool allowed)",
  "function setAllowAnyTeeVariant(bool allowed)",
  "function setAllowedTeeVariants(string[] teeVariants)",
];

const basicAppInterface = new Interface(BASIC_APP_ABI);
const epochAppInterface = new Interface(EPOCH_MANAGEMENT_ABI);

function interfaceId(iface) {
  let acc = 0n;
  iface.forEachFunction((fn) => {
    acc ^= BigInt(fn.selector);
  });
  return "0x" + acc.toString(16).padStart(8, "0");
}

export const APP_VERSIONS = {
  basic: {
    describes: "DstackApp v0.5.9 and v0.6.0: addComposeHash(bytes32)",
    // IAppAuthBasicManagement, as written in the v0.5.9 and v0.6.0 sources.
    managementInterfaceId: "0x8fd37527",
  },
  epoch: {
    describes: "DstackApp on the `next` branch: addComposeHashAtEpoch(uint256,bytes32)",
    managementInterfaceId: interfaceId(epochAppInterface),
  },
};

/**
 * The calls the app's owner must make to approve `composeHash` and, when
 * `remove` is given, to remove the old one. Returns
 * [{ target, value, data, meaning }].
 */
export function composeHashCalls({ appVersion, app, composeHash, remove, epoch }) {
  const calls = [];
  const call = (iface, name, args) => {
    calls.push({
      target: app,
      value: 0n,
      data: iface.encodeFunctionData(name, args),
      meaning: `${name}(${args.join(", ")}) on app ${app}`,
    });
  };
  if (appVersion === "basic") {
    if (epoch !== undefined) throw new UsageError("--epoch only applies to --app-version epoch");
    call(basicAppInterface, "addComposeHash", [composeHash]);
    if (remove) call(basicAppInterface, "removeComposeHash", [remove]);
  } else if (appVersion === "epoch") {
    if (epoch === undefined) {
      throw new UsageError("--app-version epoch needs --epoch N (the app epoch to approve the hash in)");
    }
    call(epochAppInterface, "addComposeHashAtEpoch", [epoch, composeHash]);
    // The source notes that a request may select any epoch up to the current
    // one, so a removal has to clear every row from 0 up to it.
    if (remove) call(epochAppInterface, "removeComposeHashAtEpochs", [0n, epoch, remove]);
  } else {
    throw new UsageError(`--app-version must be one of: ${Object.keys(APP_VERSIONS).join(", ")}`);
  }
  return calls;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export class UsageError extends Error {}
export class RefusedError extends Error {}

const abi = AbiCoder.defaultAbiCoder();

function log(message) {
  process.stderr.write(message + "\n");
}

function toJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v), 2);
}

function isoTime(seconds) {
  return new Date(Number(seconds) * 1000).toISOString();
}

function parseAddress(value, flag) {
  if (typeof value !== "string" || !isHexString(value, 20)) {
    throw new UsageError(`${flag} must be a 20-byte 0x address`);
  }
  const address = getAddress(value.toLowerCase());
  if (address === ZeroAddress) throw new UsageError(`${flag} must not be the zero address`);
  return address;
}

function parseBytes32(value, flag, { allowZero = false } = {}) {
  if (typeof value !== "string" || !isHexString(value, 32)) {
    throw new UsageError(`${flag} must be a 32-byte 0x value (66 characters)`);
  }
  const lower = value.toLowerCase();
  if (!allowZero && lower === ZeroHash) throw new UsageError(`${flag} must not be zero`);
  return lower;
}

function parseWholeNumber(value, flag) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new UsageError(`${flag} must be a whole number`);
  }
  return BigInt(value);
}

function requireFlag(values, name) {
  if (values[name] === undefined) throw new UsageError(`--${name} is required`);
  return values[name];
}

function operationSalt({ composeHash, remove, round }) {
  return keccak256(
    abi.encode(
      ["string", "bytes32", "bytes32", "uint256"],
      ["insights-upgrades/compose-hash/v1", composeHash, remove ?? ZeroHash, round],
    ),
  );
}

/** Same hash as TimelockController.hashOperationBatch. */
export function operationId(calls, predecessor, salt) {
  return keccak256(
    abi.encode(
      ["address[]", "uint256[]", "bytes[]", "bytes32", "bytes32"],
      [calls.map((c) => c.target), calls.map((c) => c.value), calls.map((c) => c.data), predecessor, salt],
    ),
  );
}

const KNOWN_CALLS = new Interface([
  ...BASIC_APP_ABI,
  ...EPOCH_MANAGEMENT_ABI,
  "function addDevice(bytes32 deviceId)",
  "function removeDevice(bytes32 deviceId)",
  "function setRequireTcbUpToDate(bool requireUpToDate)",
  "function advanceAppEpoch(uint256 expectedCurrentEpoch)",
  "function disableUpgrades()",
  "function upgradeToAndCall(address newImplementation, bytes data)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "function renounceOwnership()",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function renounceRole(bytes32 role, address callerConfirmation)",
  "function updateDelay(uint256 newDelay)",
]);

/** Plain-words reading of a call the timelock would make. Never throws. */
export function decodeCall(target, data, value = 0n) {
  const sent = value && BigInt(value) !== 0n ? ` sending ${value} wei` : "";
  if (data === "0x") return `plain transfer to ${target}${sent}`;
  let parsed = null;
  try {
    parsed = KNOWN_CALLS.parseTransaction({ data });
  } catch {
    parsed = null;
  }
  if (!parsed) {
    return `UNKNOWN call (selector ${data.slice(0, 10)}) on ${target}${sent}: not a function this tool knows`;
  }
  const args = parsed.args.map((arg, index) => {
    const text = typeof arg === "bigint" ? arg.toString() : String(arg);
    const isRole = parsed.fragment.inputs[index].name === "role";
    return isRole && ROLE_NAMES[text] ? ROLE_NAMES[text] : text;
  });
  return `${parsed.name}(${args.join(", ")}) on ${target}${sent}`;
}

async function connect(values) {
  const rpc = requireFlag(values, "rpc");
  const expected = parseWholeNumber(requireFlag(values, "chain-id"), "--chain-id");
  // Ask the endpoint directly first: ethers retries forever when it cannot
  // detect the network.
  let actual;
  try {
    const response = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(15000),
    });
    actual = BigInt((await response.json()).result);
  } catch {
    throw new RefusedError("could not read the chain id from the RPC endpoint given by --rpc");
  }
  if (actual !== expected) {
    throw new RefusedError(`the RPC endpoint is chain ${actual}, but --chain-id says ${expected}; refusing`);
  }
  // The provider is pinned to the checked chain id, and every transaction is
  // signed for that id (EIP-155), so it is invalid on any other chain.
  const provider = new JsonRpcProvider(rpc, Network.from(expected), {
    staticNetwork: true,
    // No short-lived response cache: a read made right after a transaction
    // must see that transaction.
    cacheTimeout: -1,
  });
  return { provider, chainId: actual };
}

/** A signer from an environment variable. The key is never echoed. */
function signerFromEnv(envName, provider) {
  const key = process.env[envName];
  if (!key) return null;
  try {
    return new Wallet(key.trim(), provider);
  } catch {
    throw new UsageError(`${envName} is set but is not a valid private key`);
  }
}

/**
 * Who would sign. With --dry-run the key is optional: --from names the
 * address instead.
 */
function resolveSender(values, envName, provider) {
  const signer = signerFromEnv(envName, provider);
  if (signer) {
    if (values.from && parseAddress(values.from, "--from") !== signer.address) {
      throw new UsageError(`--from does not match the address of the key in ${envName}`);
    }
    return { signer, address: signer.address };
  }
  if (!values["dry-run"]) throw new UsageError(`set ${envName} to the signing key (environment variable only)`);
  if (!values.from) throw new UsageError(`for a dry run without ${envName}, pass --from 0x… (the address that would sign)`);
  return { signer: null, address: parseAddress(values.from, "--from") };
}

async function send(signer, tx, label, confirmations) {
  log(`sending: ${label}`);
  const response = await signer.sendTransaction(tx);
  const receipt = await response.wait(confirmations);
  if (!receipt || receipt.status !== 1) throw new Error(`transaction failed: ${label} (${response.hash})`);
  log(`  mined in block ${receipt.blockNumber}: ${response.hash}`);
  return receipt;
}

function describeTx(step, tx, meaning) {
  return { step, to: tx.to ?? null, value: (tx.value ?? 0n).toString(), data: tx.data, meaning };
}

function timelockAt(address, provider) {
  const call = async (name, args = []) => {
    const data = timelockInterface.encodeFunctionData(name, args);
    const result = await provider.call({ to: address, data });
    const decoded = timelockInterface.decodeFunctionResult(name, result);
    return decoded.length === 1 ? decoded[0] : decoded;
  };
  return { address, call };
}

async function requireTimelockCode(provider, address) {
  const code = await provider.getCode(address);
  if (code === "0x") throw new RefusedError(`no contract at --timelock ${address} on this chain`);
  return code.toLowerCase() === timelockArtifact.deployedBytecode.toLowerCase();
}

// ---------------------------------------------------------------------------
// deploy-timelock
// ---------------------------------------------------------------------------

export async function deployTimelock(values) {
  const hoursText = requireFlag(values, "delay-hours");
  const hours = parseWholeNumber(hoursText, "--delay-hours");
  if (hours < BigInt(MIN_DELAY_HOURS)) {
    throw new RefusedError(`--delay-hours ${hours} is under the ${MIN_DELAY_HOURS}-hour minimum; refusing`);
  }
  const minDelay = hours * 3600n;
  const proposer = parseAddress(requireFlag(values, "proposer"), "--proposer");
  const cancellers = requireFlag(values, "cancellers")
    .split(",")
    .map((entry) => parseAddress(entry.trim(), "--cancellers"));
  if (new Set(cancellers).size !== cancellers.length) throw new UsageError("--cancellers lists an address twice");
  if (values.executor && values["open-execution"]) {
    throw new UsageError("give --executor or --open-execution, not both");
  }
  // OpenZeppelin's rule: the zero address as executor means anyone may
  // execute an operation once its delay has passed.
  const executor = values["open-execution"]
    ? ZeroAddress
    : values.executor
      ? parseAddress(values.executor, "--executor")
      : proposer;
  for (const canceller of cancellers) {
    if (canceller === proposer || canceller === executor) {
      throw new UsageError(`canceller ${canceller} is also the proposer or executor; a cancel-only key must hold nothing else`);
    }
  }

  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: deployer } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    if (cancellers.includes(deployer)) {
      throw new UsageError("the deployer is listed as a canceller; use a separate cancel-only key");
    }

    let nonce = await provider.getTransactionCount(deployer, "pending");
    const predicted = getCreateAddress({ from: deployer, nonce });

    const deployTx = {
      data: timelockArtifact.bytecode + timelockInterface.encodeDeploy([minDelay, [proposer], [executor], deployer]).slice(2),
    };
    const steps = [
      {
        tx: deployTx,
        meaning:
          `deploy OpenZeppelin TimelockController ${OZ_VERSION} with minDelay=${minDelay}s (${hours}h), ` +
          `proposers=[${proposer}], executors=[${executor === ZeroAddress ? "anyone (zero address)" : executor}], ` +
          `admin=${deployer} (temporary)`,
      },
      ...cancellers.map((canceller) => ({
        tx: { to: predicted, data: timelockInterface.encodeFunctionData("grantRole", [ROLES.CANCELLER_ROLE, canceller]) },
        meaning: `grantRole(CANCELLER_ROLE, ${canceller}) on the timelock`,
      })),
      {
        tx: {
          to: predicted,
          data: timelockInterface.encodeFunctionData("renounceRole", [ROLES.DEFAULT_ADMIN_ROLE, deployer]),
        },
        meaning: `renounceRole(DEFAULT_ADMIN_ROLE, ${deployer}): the deployer gives up admin for good`,
      },
    ];

    if (dryRun) {
      return {
        command: "deploy-timelock",
        dryRun: true,
        chainId,
        deployer,
        predictedTimelock: predicted,
        note: "The timelock address is predicted from the deployer's current nonce. Nothing was sent.",
        transactions: steps.map((step, index) => describeTx(index + 1, step.tx, step.meaning)),
      };
    }

    const sent = [];
    let deployBlock = null;
    for (const [index, step] of steps.entries()) {
      const receipt = await send(signer, { ...step.tx, nonce }, step.meaning, confirmations);
      nonce += 1;
      sent.push({ step: index + 1, hash: receipt.hash, block: receipt.blockNumber, meaning: step.meaning });
      if (index === 0) {
        deployBlock = receipt.blockNumber;
        if (receipt.contractAddress !== predicted) {
          throw new Error(`timelock deployed at ${receipt.contractAddress}, expected ${predicted}; stopping`);
        }
      }
    }

    const verification = await verifyTimelockSetup(provider, {
      timelock: predicted,
      minDelay,
      proposer,
      executor,
      cancellers,
      deployer,
    });
    const summary = {
      command: "deploy-timelock",
      dryRun: false,
      chainId,
      timelock: predicted,
      deployBlock,
      openZeppelinContracts: OZ_VERSION,
      delaySeconds: minDelay,
      delayHours: hours,
      proposer,
      executor: executor === ZeroAddress ? "anyone (open execution)" : executor,
      cancellers,
      deployer,
      transactions: sent,
      verification,
      verified: verification.every((check) => check.ok),
    };
    if (!summary.verified) {
      const error = new Error("on-chain verification FAILED; do not make this timelock the owner of anything");
      error.summary = summary;
      throw error;
    }
    return summary;
  } finally {
    provider.destroy();
  }
}

/** Reads the chain and checks every role the setup should and should not have left behind. */
export async function verifyTimelockSetup(provider, { timelock, minDelay, proposer, executor, cancellers, deployer }) {
  const contract = timelockAt(timelock, provider);
  const checks = [];
  const check = (what, ok) => checks.push({ what, ok: Boolean(ok) });
  const has = (role, account) => contract.call("hasRole", [ROLES[role], account]);

  check(`deployed code is OpenZeppelin TimelockController ${OZ_VERSION}`, await requireTimelockCode(provider, timelock));
  check(`delay is ${minDelay} seconds`, (await contract.call("getMinDelay")) === minDelay);
  check(`proposer ${proposer} has PROPOSER_ROLE`, await has("PROPOSER_ROLE", proposer));
  check(`executor ${executor} has EXECUTOR_ROLE`, await has("EXECUTOR_ROLE", executor));
  for (const canceller of cancellers) {
    check(`canceller ${canceller} has CANCELLER_ROLE`, await has("CANCELLER_ROLE", canceller));
    for (const other of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "DEFAULT_ADMIN_ROLE"]) {
      check(`canceller ${canceller} does not have ${other}`, !(await has(other, canceller)));
    }
  }
  check(`deployer ${deployer} has no DEFAULT_ADMIN_ROLE`, !(await has("DEFAULT_ADMIN_ROLE", deployer)));
  if (deployer !== proposer) {
    check(`deployer ${deployer} has no PROPOSER_ROLE`, !(await has("PROPOSER_ROLE", deployer)));
    check(`deployer ${deployer} has no CANCELLER_ROLE`, !(await has("CANCELLER_ROLE", deployer)));
  }
  if (deployer !== executor) {
    check(`deployer ${deployer} has no EXECUTOR_ROLE`, !(await has("EXECUTOR_ROLE", deployer)));
  }
  check("the timelock is its own admin (role and delay changes must go through it)", await has("DEFAULT_ADMIN_ROLE", timelock));
  return checks;
}

// ---------------------------------------------------------------------------
// propose-compose-hash / execute
// ---------------------------------------------------------------------------

function readOperationFlags(values) {
  const timelock = parseAddress(requireFlag(values, "timelock"), "--timelock");
  const app = parseAddress(requireFlag(values, "app"), "--app");
  const composeHash = parseBytes32(requireFlag(values, "compose-hash"), "--compose-hash");
  const remove = values.remove ? parseBytes32(values.remove, "--remove") : undefined;
  if (remove === composeHash) throw new UsageError("--remove is the same hash as --compose-hash");
  const appVersion = requireFlag(values, "app-version");
  const epoch = values.epoch === undefined ? undefined : parseWholeNumber(values.epoch, "--epoch");
  const round = parseWholeNumber(values.round ?? "0", "--round");
  const calls = composeHashCalls({ appVersion, app, composeHash, remove, epoch });
  const salt = operationSalt({ composeHash, remove, round });
  const predecessor = ZeroHash;
  return { timelock, app, appVersion, composeHash, remove, calls, salt, predecessor, id: operationId(calls, predecessor, salt) };
}

/** Read-only checks on the app contract. Returns a list of problems (empty when fine). */
async function appProblems(provider, { app, timelock, appVersion }) {
  const problems = [];
  if ((await provider.getCode(app)) === "0x") return [`no contract at --app ${app} on this chain`];
  const ownable = new Interface(["function owner() view returns (address)", "function supportsInterface(bytes4) view returns (bool)"]);
  try {
    const result = await provider.call({ to: app, data: ownable.encodeFunctionData("owner") });
    const [owner] = ownable.decodeFunctionResult("owner", result);
    if (owner !== timelock) problems.push(`the app's owner is ${owner}, not the timelock ${timelock}; the timelock's call would be rejected`);
  } catch {
    problems.push("could not read owner() from the app contract");
  }
  const wanted = APP_VERSIONS[appVersion].managementInterfaceId;
  try {
    const result = await provider.call({ to: app, data: ownable.encodeFunctionData("supportsInterface", [wanted]) });
    const [supported] = ownable.decodeFunctionResult("supportsInterface", result);
    if (!supported) {
      problems.push(`the app does not report the management interface ${wanted} that --app-version ${appVersion} expects; the version is probably wrong`);
    }
  } catch {
    problems.push(`could not ask the app whether it supports interface ${wanted} (--app-version ${appVersion})`);
  }
  return problems;
}

export async function proposeComposeHash(values) {
  const op = readOperationFlags(values);
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    const isOzBuild = await requireTimelockCode(provider, op.timelock);
    const timelock = timelockAt(op.timelock, provider);

    const problems = await appProblems(provider, op);
    if (!isOzBuild) problems.push(`the code at ${op.timelock} is not the OpenZeppelin TimelockController ${OZ_VERSION} build this tool ships`);
    if (!(await timelock.call("hasRole", [ROLES.PROPOSER_ROLE, sender]))) {
      problems.push(`${sender} does not have PROPOSER_ROLE on the timelock`);
    }
    const state = OPERATION_STATES[Number(await timelock.call("getOperationState", [op.id]))];
    if (state !== "Unset") {
      problems.push(`operation ${op.id} already exists (state ${state}); to schedule the same change again use a new --round`);
    }
    const onChainId = await timelock.call("hashOperationBatch", [
      op.calls.map((c) => c.target),
      op.calls.map((c) => c.value),
      op.calls.map((c) => c.data),
      op.predecessor,
      op.salt,
    ]);
    if (onChainId !== op.id) problems.push(`the timelock computes operation id ${onChainId}, this tool computed ${op.id}`);

    const delay = await timelock.call("getMinDelay");
    const tx = {
      to: op.timelock,
      data: timelockInterface.encodeFunctionData("scheduleBatch", [
        op.calls.map((c) => c.target),
        op.calls.map((c) => c.value),
        op.calls.map((c) => c.data),
        op.predecessor,
        op.salt,
        delay,
      ]),
    };
    const meaning = `scheduleBatch on timelock ${op.timelock}, delay ${delay}s: ` + op.calls.map((c) => c.meaning).join("; then ");
    const base = {
      command: "propose-compose-hash",
      chainId,
      timelock: op.timelock,
      app: op.app,
      appVersion: op.appVersion,
      operationId: op.id,
      salt: op.salt,
      delaySeconds: delay,
      calls: op.calls.map((c) => ({ target: c.target, value: c.value, data: c.data, meaning: c.meaning })),
    };

    if (dryRun) {
      return { ...base, dryRun: true, sender, problems, transactions: [describeTx(1, tx, meaning)] };
    }
    if (problems.length > 0) throw new RefusedError("refusing to propose:\n  - " + problems.join("\n  - "));

    const receipt = await send(signer, tx, meaning, confirmations);
    const readyAt = await timelock.call("getTimestamp", [op.id]);
    return {
      ...base,
      dryRun: false,
      transaction: receipt.hash,
      block: receipt.blockNumber,
      earliestExecution: { unixSeconds: readyAt, iso: isoTime(readyAt) },
    };
  } finally {
    provider.destroy();
  }
}

export async function executeOperation(values) {
  const op = readOperationFlags(values);
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    await requireTimelockCode(provider, op.timelock);
    const timelock = timelockAt(op.timelock, provider);

    const problems = await appProblems(provider, op);
    const state = OPERATION_STATES[Number(await timelock.call("getOperationState", [op.id]))];
    const readyAt = await timelock.call("getTimestamp", [op.id]);
    if (state === "Unset") problems.push(`operation ${op.id} is not scheduled (never proposed, or cancelled)`);
    if (state === "Done") problems.push(`operation ${op.id} was already executed`);
    if (state === "Waiting") problems.push(`operation ${op.id} is still waiting; earliest execution is ${isoTime(readyAt)}`);
    const mayExecute =
      (await timelock.call("hasRole", [ROLES.EXECUTOR_ROLE, ZeroAddress])) ||
      (await timelock.call("hasRole", [ROLES.EXECUTOR_ROLE, sender]));
    if (!mayExecute) problems.push(`${sender} does not have EXECUTOR_ROLE on the timelock`);

    const tx = {
      to: op.timelock,
      data: timelockInterface.encodeFunctionData("executeBatch", [
        op.calls.map((c) => c.target),
        op.calls.map((c) => c.value),
        op.calls.map((c) => c.data),
        op.predecessor,
        op.salt,
      ]),
    };
    const meaning = `executeBatch on timelock ${op.timelock}: ` + op.calls.map((c) => c.meaning).join("; then ");
    const base = { command: "execute", chainId, timelock: op.timelock, app: op.app, operationId: op.id, state };

    if (dryRun) {
      return { ...base, dryRun: true, sender, problems, transactions: [describeTx(1, tx, meaning)] };
    }
    if (problems.length > 0) throw new RefusedError("refusing to execute:\n  - " + problems.join("\n  - "));

    const receipt = await send(signer, tx, meaning, confirmations);
    const after = OPERATION_STATES[Number(await timelock.call("getOperationState", [op.id]))];
    if (after !== "Done") throw new Error(`the transaction was mined but the operation state is ${after}`);
    return { ...base, dryRun: false, state: after, transaction: receipt.hash, block: receipt.blockNumber };
  } finally {
    provider.destroy();
  }
}

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

export async function cancelOperation(values) {
  const timelockAddress = parseAddress(requireFlag(values, "timelock"), "--timelock");
  const id = parseBytes32(requireFlag(values, "id"), "--id");
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, CANCEL_KEY_ENV, provider);
    await requireTimelockCode(provider, timelockAddress);
    const timelock = timelockAt(timelockAddress, provider);

    const problems = [];
    const state = OPERATION_STATES[Number(await timelock.call("getOperationState", [id]))];
    if (state !== "Waiting" && state !== "Ready") {
      problems.push(`operation ${id} is not pending (state ${state}); only a scheduled, not yet executed operation can be cancelled`);
    }
    if (!(await timelock.call("hasRole", [ROLES.CANCELLER_ROLE, sender]))) {
      problems.push(`${sender} does not have CANCELLER_ROLE on the timelock`);
    }
    const tx = { to: timelockAddress, data: timelockInterface.encodeFunctionData("cancel", [id]) };
    const meaning = `cancel(${id}) on timelock ${timelockAddress}`;
    const base = { command: "cancel", chainId, timelock: timelockAddress, operationId: id };

    if (dryRun) {
      return { ...base, dryRun: true, sender, state, problems, transactions: [describeTx(1, tx, meaning)] };
    }
    if (problems.length > 0) throw new RefusedError("refusing to cancel:\n  - " + problems.join("\n  - "));

    const receipt = await send(signer, tx, meaning, confirmations);
    const after = OPERATION_STATES[Number(await timelock.call("getOperationState", [id]))];
    if (after !== "Unset") throw new Error(`the transaction was mined but the operation state is ${after}`);
    return { ...base, dryRun: false, cancelledBy: sender, state: "Cancelled", transaction: receipt.hash, block: receipt.blockNumber };
  } finally {
    provider.destroy();
  }
}

// ---------------------------------------------------------------------------
// status (read-only)
// ---------------------------------------------------------------------------

async function getLogsInChunks(provider, filter, fromBlock, toBlock, chunk) {
  const logs = [];
  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(start + chunk - 1, toBlock);
    logs.push(...(await provider.getLogs({ ...filter, fromBlock: start, toBlock: end })));
  }
  return logs;
}

export async function status(values) {
  const timelockAddress = parseAddress(requireFlag(values, "timelock"), "--timelock");
  const onlyId = values.id ? parseBytes32(values.id, "--id") : undefined;
  const app = values.app ? parseAddress(values.app, "--app") : undefined;
  const { provider, chainId } = await connect(values);
  try {
    const isOzBuild = await requireTimelockCode(provider, timelockAddress);
    const timelock = timelockAt(timelockAddress, provider);
    const latest = await provider.getBlockNumber();
    const fromBlock = Number(parseWholeNumber(values["from-block"] ?? "0", "--from-block"));
    const chunk = Number(parseWholeNumber(values["block-chunk"] ?? String(latest + 1), "--block-chunk"));
    if (chunk < 1) throw new UsageError("--block-chunk must be at least 1");

    const logs = await getLogsInChunks(provider, { address: timelockAddress }, fromBlock, latest, chunk);
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

    const holders = Object.fromEntries(Object.keys(ROLES).map((name) => [name, new Set()]));
    const otherRoles = [];
    const operations = new Map();
    const operation = (id) => {
      if (!operations.has(id)) {
        operations.set(id, { operationId: id, salt: null, scheduledInBlock: null, calls: [], events: [] });
      }
      return operations.get(id);
    };
    const delayChanges = [];

    for (const entry of logs) {
      let parsed = null;
      try {
        parsed = timelockInterface.parseLog(entry);
      } catch {
        parsed = null;
      }
      if (!parsed) continue;
      const { name, args } = parsed;
      if (name === "RoleGranted" || name === "RoleRevoked") {
        const roleName = ROLE_NAMES[args.role];
        if (!roleName) {
          otherRoles.push({ event: name, role: args.role, account: args.account, block: entry.blockNumber });
        } else if (name === "RoleGranted") {
          holders[roleName].add(args.account);
        } else {
          holders[roleName].delete(args.account);
        }
      } else if (name === "CallScheduled") {
        const op = operation(args.id);
        // A cancelled id can be scheduled again: start its call list afresh.
        if (op.events.at(-1) === "Cancelled") op.calls = [];
        op.scheduledInBlock = entry.blockNumber;
        op.predecessor = args.predecessor;
        op.delaySeconds = args.delay;
        op.calls[Number(args.index)] = {
          index: Number(args.index),
          target: args.target,
          value: args.value,
          data: args.data,
          meaning: decodeCall(args.target, args.data, args.value),
        };
        if (Number(args.index) === 0) op.events.push("Scheduled");
      } else if (name === "CallSalt") {
        operation(args.id).salt = args.salt;
      } else if (name === "Cancelled") {
        operation(args.id).events.push("Cancelled");
      } else if (name === "CallExecuted") {
        const op = operation(args.id);
        if (op.events.at(-1) !== "Executed") op.events.push("Executed");
      } else if (name === "MinDelayChange") {
        delayChanges.push({ block: entry.blockNumber, from: args.oldDuration, to: args.newDuration });
      }
    }

    // Events can be incomplete when --from-block is after the deployment, so
    // every holder found is also confirmed against the contract's own state.
    const roles = {};
    for (const [name, accounts] of Object.entries(holders)) {
      roles[name] = [];
      for (const account of accounts) {
        const confirmed = await timelock.call("hasRole", [ROLES[name], account]);
        if (confirmed) roles[name].push(account === ZeroAddress ? `${account} (anyone)` : account);
      }
    }

    const now = (await provider.getBlock(latest)).timestamp;
    const operationList = [];
    for (const op of operations.values()) {
      if (onlyId && op.operationId !== onlyId) continue;
      const chainState = OPERATION_STATES[Number(await timelock.call("getOperationState", [op.operationId]))];
      const readyAt = await timelock.call("getTimestamp", [op.operationId]);
      const state = chainState === "Unset" && op.events.at(-1) === "Cancelled" ? "Cancelled" : chainState;
      const pending = chainState === "Waiting" || chainState === "Ready";
      operationList.push({
        operationId: op.operationId,
        state,
        pending,
        earliestExecution: pending ? { unixSeconds: readyAt, iso: isoTime(readyAt) } : null,
        secondsUntilReady: chainState === "Waiting" ? readyAt - BigInt(now) : null,
        scheduledInBlock: op.scheduledInBlock,
        delaySeconds: op.delaySeconds ?? null,
        salt: op.salt,
        history: op.events,
        calls: op.calls.filter(Boolean),
      });
    }
    if (onlyId && operationList.length === 0) {
      const chainState = OPERATION_STATES[Number(await timelock.call("getOperationState", [onlyId]))];
      operationList.push({ operationId: onlyId, state: chainState, note: "no events for this id in the scanned blocks" });
    }

    const delay = await timelock.call("getMinDelay");
    const result = {
      command: "status",
      chainId,
      timelock: timelockAddress,
      codeIsOpenZeppelinTimelock: isOzBuild,
      openZeppelinContracts: OZ_VERSION,
      delaySeconds: delay,
      delayHours: Number(delay) / 3600,
      delayChanges,
      roles,
      rolesOutsideTheStandardFour: otherRoles,
      scannedBlocks: { from: fromBlock, to: latest },
      latestBlockTime: { unixSeconds: now, iso: isoTime(now) },
      pendingOperations: operationList.filter((op) => op.pending),
      otherOperations: operationList.filter((op) => !op.pending),
    };

    if (app) {
      const iface = new Interface([
        "function owner() view returns (address)",
        "function pendingOwner() view returns (address)",
        "function supportsInterface(bytes4) view returns (bool)",
      ]);
      const read = async (name, args = []) => {
        try {
          const out = await provider.call({ to: app, data: iface.encodeFunctionData(name, args) });
          return iface.decodeFunctionResult(name, out)[0];
        } catch {
          return null;
        }
      };
      const owner = await read("owner");
      const reports = {};
      for (const [version, info] of Object.entries(APP_VERSIONS)) {
        reports[version] = await read("supportsInterface", [info.managementInterfaceId]);
      }
      result.app = {
        address: app,
        hasCode: (await provider.getCode(app)) !== "0x",
        owner,
        ownerIsTimelock: owner === timelockAddress,
        // Ownable2Step only (v0.6.0 and later); null on v0.5.9.
        pendingOwner: await read("pendingOwner"),
        reportsManagementInterface: reports,
      };
    }
    return result;
  } finally {
    provider.destroy();
  }
}

// ---------------------------------------------------------------------------
// new-cancel-key
// ---------------------------------------------------------------------------

export function newCancelKey(values) {
  const out = requireFlag(values, "out");
  const wallet = Wallet.createRandom();
  const text = [
    "# Cancel-only key for the insights enclave's upgrade timelock.",
    "#",
    "# WARNING: this key can do exactly one thing once its address has been",
    "# given CANCELLER_ROLE on the timelock: cancel a pending upgrade. It cannot",
    "# propose, approve, speed up or execute anything, and it holds no funds",
    "# beyond the small amount of gas money sent to it. Anyone who gets this",
    "# file can block upgrades, so keep it private to the member's agent.",
    "# Losing it is harmless to the enclave; ask for the address to be replaced.",
    `INSIGHTS_CANCEL_ADDRESS=${wallet.address}`,
    `${CANCEL_KEY_ENV}=${wallet.privateKey}`,
    "",
  ].join("\n");
  try {
    // "wx": never overwrite an existing key file. The mode has no effect on Windows.
    writeFileSync(out, text, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code === "EEXIST") throw new RefusedError(`${out} already exists; refusing to overwrite a key file`);
    throw new Error(`could not write ${out}: ${error.code ?? "write failed"}`);
  }
  return {
    command: "new-cancel-key",
    address: wallet.address,
    file: out,
    note: "The key is in the file only. It can cancel and nothing else, and only after the timelock grants this address CANCELLER_ROLE.",
  };
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const COMMANDS = {
  "deploy-timelock": deployTimelock,
  "propose-compose-hash": proposeComposeHash,
  execute: executeOperation,
  cancel: cancelOperation,
  status,
  "new-cancel-key": newCancelKey,
};

const OPTIONS = {
  rpc: { type: "string" },
  "chain-id": { type: "string" },
  "dry-run": { type: "boolean" },
  from: { type: "string" },
  confirmations: { type: "string" },
  "delay-hours": { type: "string" },
  proposer: { type: "string" },
  cancellers: { type: "string" },
  executor: { type: "string" },
  "open-execution": { type: "boolean" },
  timelock: { type: "string" },
  app: { type: "string" },
  "app-version": { type: "string" },
  "compose-hash": { type: "string" },
  remove: { type: "string" },
  epoch: { type: "string" },
  round: { type: "string" },
  id: { type: "string" },
  "from-block": { type: "string" },
  "block-chunk": { type: "string" },
  out: { type: "string" },
  help: { type: "boolean" },
};

const USAGE = `Usage: node upgrades.mjs <command> [flags]

Commands that reach a chain need --rpc URL and --chain-id N (no default).
Commands that send a transaction accept --dry-run (print, send nothing).
Signing keys come only from the environment: ${DEPLOYER_KEY_ENV} (deploy,
propose, execute) and ${CANCEL_KEY_ENV} (cancel).

  deploy-timelock       --delay-hours N --proposer 0x… --cancellers 0x…,0x…
                        [--executor 0x… | --open-execution]
  propose-compose-hash  --timelock 0x… --app 0x… --app-version basic|epoch
                        --compose-hash 0x… [--remove 0x…] [--epoch N] [--round N]
  execute               (same flags as propose-compose-hash)
  cancel                --timelock 0x… --id 0x…
  status                --timelock 0x… [--id 0x…] [--app 0x…]
                        [--from-block N] [--block-chunk N]
  new-cancel-key        --out FILE

Other flags: --from 0x… (dry run without a key), --confirmations N (default 1).
See README.md.`;

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  const [command, ...extra] = parsed.positionals;
  if (parsed.values.help || !command) return { usage: USAGE };
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);
  const handler = COMMANDS[command];
  if (!handler) throw new UsageError(`unknown command: ${command}`);
  return handler(parsed.values);
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (runDirectly) {
  main(process.argv.slice(2)).then(
    (result) => {
      process.stdout.write((result.usage ?? toJson(result)) + "\n");
    },
    (error) => {
      if (error.summary) process.stdout.write(toJson(error.summary) + "\n");
      const kind = error instanceof UsageError ? "usage error" : error instanceof RefusedError ? "refused" : "error";
      process.stderr.write(`${kind}: ${error.message}\n`);
      if (error instanceof UsageError) process.stderr.write("run with --help for usage\n");
      process.exitCode = error instanceof UsageError ? 2 : 1;
    },
  );
}
