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
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  AbiCoder,
  Interface,
  JsonRpcProvider,
  Network,
  Wallet,
  ZeroAddress,
  ZeroHash,
  concat,
  formatEther,
  getAddress,
  getCreateAddress,
  id as keccakText,
  isHexString,
  keccak256,
  parseEther,
  toBeHex,
  verifyTypedData,
  zeroPadValue,
} from "ethers";

const require = createRequire(import.meta.url);
const OZ_VERSION = require("@openzeppelin/contracts/package.json").version;
const timelockArtifact = require("@openzeppelin/contracts/build/contracts/TimelockController.json");

export const TIMELOCK_ABI = timelockArtifact.abi;
export const timelockInterface = new Interface(TIMELOCK_ABI);

export const MIN_DELAY_HOURS = 48;
export const DEPLOYER_KEY_ENV = "INSIGHTS_DEPLOYER_KEY";
export const CANCEL_KEY_ENV = "INSIGHTS_CANCEL_KEY";
export const MEMBER_KEY_ENV = "INSIGHTS_MEMBER_KEY";
// The ERC-4337 entry point the veto contract answers to unless told otherwise:
// v0.9, the default in the OpenZeppelin release this package pins. Its code
// was found at this address on Base on 2026-11-14.
export const ENTRY_POINT_V09 = "0x433709009B8330FDa32311DF1C2AFA402eD8D009";
// The most one paid veto may cost the veto contract unless told otherwise.
export const DEFAULT_MAX_VETO_COST_ETH = "0.0002";
// keccak256 of the code at ENTRY_POINT_V09 on Base, read on 2026-11-14 (the
// same code is in test-fixtures/). deploy-timelock refuses if the code at
// that address on the chosen chain is anything else.
export const ENTRY_POINT_V09_CODE_HASH = "0x826b7ec542db9f3345234a25c2a6330a61f99483dedb6e6709928cc97e4e4d5d";

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

function parseEthAmount(value, flag) {
  let wei;
  try {
    wei = parseEther(value);
  } catch {
    throw new UsageError(`${flag} must be an amount of ETH, such as 0.002`);
  }
  if (wei <= 0n) throw new UsageError(`${flag} must be more than zero`);
  return wei;
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
  "function addMember(address member)",
  "function removeMember(address member)",
  "function withdraw(address to, uint256 amount)",
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
  // Public endpoints drop a request now and then, so this is tried a few
  // times. Nothing has been sent at this point.
  for (let attempt = 1; actual === undefined; attempt += 1) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(15000),
      });
      actual = BigInt((await response.json()).result);
    } catch {
      if (attempt >= 4) throw new RefusedError("could not read the chain id from the RPC endpoint given by --rpc");
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
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
  // Public endpoints sit behind several nodes, and one of them may not have
  // seen the previous transaction yet, so a gas estimate can fail for a
  // contract that was deployed a moment ago. Only that case is retried: when
  // the estimate fails, nothing has been sent.
  let response;
  for (let attempt = 1; ; attempt += 1) {
    try {
      response = await signer.sendTransaction(tx);
      break;
    } catch (error) {
      if (error?.action !== "estimateGas" || attempt >= 6) throw error;
      log(`  the endpoint could not estimate this yet (attempt ${attempt} of 6); waiting`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }
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
  const withVeto = Boolean(values["member-veto"]);
  const addressList = (flag) =>
    (values[flag] ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => parseAddress(entry, `--${flag}`));
  if (!withVeto && (values.members !== undefined || values.enroller !== undefined)) {
    throw new UsageError("--members and --enroller only apply with --member-veto");
  }
  const cancellers = addressList("cancellers");
  if (!withVeto && cancellers.length === 0) throw new UsageError("--cancellers is required (or use --member-veto)");
  if (new Set(cancellers).size !== cancellers.length) throw new UsageError("--cancellers lists an address twice");
  const members = addressList("members");
  if (new Set(members).size !== members.length) throw new UsageError("--members lists an address twice");
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
  // Who may add a member to the veto contract at once. Removing one always
  // goes through the timelock.
  const enroller = !withVeto ? null : values.enroller ? parseAddress(values.enroller, "--enroller") : proposer;
  if (!withVeto && (values["entry-point"] !== undefined || values["max-veto-cost-eth"] !== undefined)) {
    throw new UsageError("--entry-point and --max-veto-cost-eth only apply with --member-veto");
  }
  const entryPointAddress = !withVeto ? null : parseAddress(values["entry-point"] ?? ENTRY_POINT_V09, "--entry-point");
  const maxVetoCost = !withVeto ? null : parseEthAmount(values["max-veto-cost-eth"] ?? DEFAULT_MAX_VETO_COST_ETH, "--max-veto-cost-eth");
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

    let entryPointCodeKnown = null;
    if (withVeto) {
      const code = await provider.getCode(entryPointAddress);
      if (code === "0x") throw new RefusedError(`no contract at --entry-point ${entryPointAddress} on this chain`);
      // Everything the veto contract pays for rests on the entry point being
      // the real one, so its code is compared with the known code.
      entryPointCodeKnown = keccak256(code) === ENTRY_POINT_V09_CODE_HASH;
      if (!entryPointCodeKnown && !values["unknown-entry-point"]) {
        throw new RefusedError(
          `the code at --entry-point ${entryPointAddress} is not the ERC-4337 entry point v0.9 code this tool knows; ` +
            "refusing (pass --unknown-entry-point only after checking that contract yourself)",
        );
      }
    }

    let nonce = await provider.getTransactionCount(deployer, "pending");
    const predicted = getCreateAddress({ from: deployer, nonce });
    // The veto contract is deployed straight after the timelock, so its
    // address is known before either exists.
    const predictedVeto = withVeto ? getCreateAddress({ from: deployer, nonce: nonce + 1 }) : null;
    const allCancellers = withVeto ? [predictedVeto, ...cancellers] : cancellers;
    const vetoSteps = withVeto
      ? [
          {
            tx: {
              data:
                memberVetoBuild().bytecode +
                vetoInterface.encodeDeploy([predicted, enroller, entryPointAddress, maxVetoCost, members]).slice(2),
            },
            meaning:
              `deploy MemberVeto for timelock ${predicted} with enroller=${enroller}, ` +
              `entry point ${entryPointAddress}, at most ${formatEther(maxVetoCost)} ETH per paid veto, ` +
              `members=[${members.join(", ")}]`,
          },
        ]
      : [];

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
      ...vetoSteps,
      ...allCancellers.map((canceller) => ({
        tx: { to: predicted, data: timelockInterface.encodeFunctionData("grantRole", [ROLES.CANCELLER_ROLE, canceller]) },
        meaning:
          `grantRole(CANCELLER_ROLE, ${canceller}) on the timelock` +
          (canceller === predictedVeto ? " (the member veto contract)" : ""),
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
        predictedMemberVeto: predictedVeto ?? undefined,
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
      if (withVeto && index === 1 && receipt.contractAddress !== predictedVeto) {
        throw new Error(`member veto deployed at ${receipt.contractAddress}, expected ${predictedVeto}; stopping`);
      }
    }

    const verification = await verifyTimelockSetup(provider, {
      timelock: predicted,
      minDelay,
      proposer,
      executor,
      cancellers: allCancellers,
      deployer,
    });
    if (withVeto) {
      verification.push(...(await verifyVetoSetup(provider, {
          veto: predictedVeto,
          timelock: predicted,
          enroller,
          entryPoint: entryPointAddress,
          maxVetoCost,
          members,
        })));
    }
    verification.push(
      ...(await verifyRoleHistory(provider, {
        timelock: predicted,
        fromBlock: deployBlock,
        expected: {
          DEFAULT_ADMIN_ROLE: [predicted],
          PROPOSER_ROLE: [proposer],
          EXECUTOR_ROLE: [executor],
          // OpenZeppelin gives every proposer the canceller role too.
          CANCELLER_ROLE: [proposer, ...allCancellers],
        },
      })),
    );
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
      memberVeto: predictedVeto ?? undefined,
      enroller: enroller ?? undefined,
      entryPoint: entryPointAddress ?? undefined,
      entryPointCodeIsKnownV09: entryPointCodeKnown ?? undefined,
      maxVetoCostWei: maxVetoCost ?? undefined,
      members: withVeto ? members : undefined,
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

/**
 * Rebuilds every role holder from the timelock's own grant and revoke events
 * since it was deployed and checks that the result is exactly the expected
 * set, so a holder nobody named cannot go unnoticed.
 */
export async function verifyRoleHistory(provider, { timelock, fromBlock, expected }) {
  let logs;
  try {
    // An explicit end block: some endpoints refuse an open-ended range.
    logs = await provider.getLogs({ address: timelock, fromBlock, toBlock: await provider.getBlockNumber() });
  } catch (error) {
    // Everything has been sent by now, so report this as a check that could
    // not be made, with the rest of the summary, instead of stopping.
    return [
      {
        what: `the timelock's role history could be read from the endpoint (it answered: ${error.shortMessage ?? error.message}); run status with --from-block ${fromBlock} to check it`,
        ok: false,
      },
    ];
  }
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const holders = Object.fromEntries(Object.keys(ROLES).map((name) => [name, new Set()]));
  let unknownRoles = 0;
  for (const entry of logs) {
    let parsed = null;
    try {
      parsed = timelockInterface.parseLog(entry);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.name !== "RoleGranted" && parsed.name !== "RoleRevoked")) continue;
    const roleName = ROLE_NAMES[parsed.args.role];
    if (!roleName) unknownRoles += 1;
    else if (parsed.name === "RoleGranted") holders[roleName].add(parsed.args.account);
    else holders[roleName].delete(parsed.args.account);
  }
  const checks = [{ what: "the timelock's events mention no role this tool does not know", ok: unknownRoles === 0 }];
  for (const [name, accounts] of Object.entries(expected)) {
    const want = [...new Set(accounts)].sort();
    const got = [...holders[name]].sort();
    checks.push({
      what: `by the full event history, ${name} is held by exactly: ${want.join(", ")}`,
      ok: want.length === got.length && want.every((account, index) => account === got[index]),
    });
  }
  return checks;
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

/**
 * Problems with an operation's target, read from the chain. Compose-hash
 * operations check the app contract; cancel-key operations check the roles.
 */
async function targetProblems(provider, timelock, op) {
  if (op.kind === "canceller") return cancellerProblems(timelock, op);
  if (op.kind === "member") return memberProblems(provider, op);
  return appProblems(provider, op);
}

export const proposeComposeHash = (values) => proposeOperation(values, readOperationFlags(values), "propose-compose-hash");
export const proposeCanceller = (values) => proposeOperation(values, readCancellerFlags(values), "propose-canceller");
export const executeOperation = (values) => runOperation(values, readOperationFlags(values), "execute");
export const executeCanceller = (values) => runOperation(values, readCancellerFlags(values), "execute-canceller");
export const proposeRemoveMember = (values) => proposeOperation(values, readMemberRemovalFlags(values), "propose-remove-member");
export const executeRemoveMember = (values) => runOperation(values, readMemberRemovalFlags(values), "execute-remove-member");

async function proposeOperation(values, op, command) {
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    const isOzBuild = await requireTimelockCode(provider, op.timelock);
    const timelock = timelockAt(op.timelock, provider);

    const problems = await targetProblems(provider, timelock, op);
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
      command,
      chainId,
      timelock: op.timelock,
      app: op.app,
      appVersion: op.appVersion,
      canceller: op.canceller,
      change: op.change,
      veto: op.veto,
      member: op.member,
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

async function runOperation(values, op, command) {
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    await requireTimelockCode(provider, op.timelock);
    const timelock = timelockAt(op.timelock, provider);

    const state = OPERATION_STATES[Number(await timelock.call("getOperationState", [op.id]))];
    const readyAt = await timelock.call("getTimestamp", [op.id]);
    // A cancel-key or member change that is already scheduled is judged by
    // its own state below; the app checks apply only to compose-hash changes.
    const problems = op.kind ? [] : await appProblems(provider, op);
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
    const base = {
      command,
      chainId,
      timelock: op.timelock,
      app: op.app,
      canceller: op.canceller,
      change: op.change,
      veto: op.veto,
      member: op.member,
      operationId: op.id,
      state,
    };

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
// propose-canceller / execute-canceller
//
// Giving or taking away a cancel key is a grantRole or revokeRole call on the
// timelock, and only the timelock may make it. So it is scheduled like any
// other change and waits the full delay.
// ---------------------------------------------------------------------------

function readCancellerFlags(values) {
  const timelock = parseAddress(requireFlag(values, "timelock"), "--timelock");
  if (Boolean(values.add) === Boolean(values["remove-canceller"])) {
    throw new UsageError("give exactly one of --add 0x… or --remove-canceller 0x…");
  }
  const adding = Boolean(values.add);
  const canceller = adding
    ? parseAddress(values.add, "--add")
    : parseAddress(values["remove-canceller"], "--remove-canceller");
  if (canceller === timelock) throw new UsageError("the timelock itself cannot be a canceller");
  const round = parseWholeNumber(values.round ?? "0", "--round");
  const name = adding ? "grantRole" : "revokeRole";
  const calls = [
    {
      target: timelock,
      value: 0n,
      data: timelockInterface.encodeFunctionData(name, [ROLES.CANCELLER_ROLE, canceller]),
      meaning: `${name}(CANCELLER_ROLE, ${canceller}) on the timelock`,
    },
  ];
  const salt = keccak256(
    abi.encode(["string", "address", "bool", "uint256"], ["insights-upgrades/canceller/v1", canceller, adding, round]),
  );
  const predecessor = ZeroHash;
  return {
    kind: "canceller",
    timelock,
    canceller,
    change: adding ? "add" : "remove",
    calls,
    salt,
    predecessor,
    id: operationId(calls, predecessor, salt),
  };
}

async function cancellerProblems(timelock, op) {
  const problems = [];
  const has = (role) => timelock.call("hasRole", [ROLES[role], op.canceller]);
  const holds = await has("CANCELLER_ROLE");
  if (op.change === "add") {
    if (holds) problems.push(`${op.canceller} already has CANCELLER_ROLE`);
    for (const other of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "DEFAULT_ADMIN_ROLE"]) {
      if (await has(other)) problems.push(`${op.canceller} has ${other}; a cancel-only key must hold nothing else`);
    }
  } else if (!holds) {
    problems.push(`${op.canceller} does not have CANCELLER_ROLE, so there is nothing to remove`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// create-app
//
// Creates the dstack app contract through the key service's factory with the
// timelock as its owner from the first block, so no key ever owns the app.
//
// Signatures copied from Dstack-TEE/dstack DstackKms.sol and DstackApp.sol
// (see README.md). On 2026-11-14 the function selectors below were found in
// the bytecode of Phala's key service on Base and of its app template, and
// the factory call was simulated there with a timelock address as owner.
// Nothing has been sent there.
// ---------------------------------------------------------------------------

const KMS_ABI = [
  "function deployAndRegisterApp(address initialOwner, bool disableUpgrades, bool requireTcbUpToDate, bool allowAnyDevice, bytes32 initialDeviceId, bytes32 initialComposeHash) returns (address appId)",
  "function registeredApps(address app) view returns (bool)",
  "event AppDeployedViaFactory(address indexed appId, address indexed deployer)",
];
const APP_READ_ABI = [
  "function owner() view returns (address)",
  "function supportsInterface(bytes4) view returns (bool)",
  "function allowedComposeHashes(bytes32) view returns (bool)",
  "function allowAnyDevice() view returns (bool)",
  "function allowedDeviceIds(bytes32) view returns (bool)",
  "function requireTcbUpToDate() view returns (bool)",
];
const kmsInterface = new Interface(KMS_ABI);
const appReadInterface = new Interface(APP_READ_ABI);
const UPGRADE_CHOICES = ["allowed", "disabled"];

async function readContract(provider, iface, to, name, args = []) {
  const result = await provider.call({ to, data: iface.encodeFunctionData(name, args) });
  return iface.decodeFunctionResult(name, result)[0];
}

export async function createApp(values) {
  const kms = parseAddress(requireFlag(values, "kms"), "--kms");
  const timelockAddress = parseAddress(requireFlag(values, "timelock"), "--timelock");
  const composeHash = parseBytes32(requireFlag(values, "compose-hash"), "--compose-hash");
  const upgrades = requireFlag(values, "contract-upgrades");
  if (!UPGRADE_CHOICES.includes(upgrades)) {
    throw new UsageError(`--contract-upgrades must be one of: ${UPGRADE_CHOICES.join(", ")}`);
  }
  if (Boolean(values["allow-any-device"]) === Boolean(values["device-id"])) {
    throw new UsageError("give exactly one of --allow-any-device or --device-id 0x…");
  }
  const allowAnyDevice = Boolean(values["allow-any-device"]);
  const deviceId = allowAnyDevice ? ZeroHash : parseBytes32(values["device-id"], "--device-id");
  const requireTcbUpToDate = !values["allow-outdated-tcb"];
  const disableUpgrades = upgrades === "disabled";

  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);

    const problems = [];
    if ((await provider.getCode(kms)) === "0x") problems.push(`no contract at --kms ${kms} on this chain`);
    const isOzBuild = await requireTimelockCode(provider, timelockAddress);
    const timelock = timelockAt(timelockAddress, provider);
    if (!isOzBuild) {
      problems.push(
        `the code at ${timelockAddress} is not the OpenZeppelin TimelockController ${OZ_VERSION} build this tool ships`,
      );
    } else {
      const delay = await timelock.call("getMinDelay");
      if (delay < BigInt(MIN_DELAY_HOURS) * 3600n) {
        problems.push(`the timelock's delay is ${delay}s, under the ${MIN_DELAY_HOURS}-hour minimum`);
      }
      if (!(await timelock.call("hasRole", [ROLES.DEFAULT_ADMIN_ROLE, timelockAddress]))) {
        problems.push("the timelock is not its own admin");
      }
      if (await timelock.call("hasRole", [ROLES.DEFAULT_ADMIN_ROLE, sender])) {
        problems.push(
          `${sender} still has DEFAULT_ADMIN_ROLE on the timelock; its setup was not finished, deploy a new one`,
        );
      }
    }

    const tx = {
      to: kms,
      data: kmsInterface.encodeFunctionData("deployAndRegisterApp", [
        timelockAddress,
        disableUpgrades,
        requireTcbUpToDate,
        allowAnyDevice,
        deviceId,
        composeHash,
      ]),
    };
    const meaning =
      `deployAndRegisterApp on key service ${kms}: owner=${timelockAddress} (the timelock), ` +
      `contract upgrades ${upgrades}, requireTcbUpToDate=${requireTcbUpToDate}, ` +
      (allowAnyDevice ? "any device allowed" : `only device ${deviceId}`) +
      `, first approved compose hash ${composeHash}`;

    // Ask the chain what the call would do. This also gives the app's address
    // before anything is sent.
    let predictedApp = null;
    if (problems.length === 0) {
      try {
        const result = await provider.call({ ...tx, from: sender });
        [predictedApp] = kmsInterface.decodeFunctionResult("deployAndRegisterApp", result);
      } catch (error) {
        problems.push(`the key service rejects the call in simulation: ${error.shortMessage ?? error.message}`);
      }
    }

    const base = {
      command: "create-app",
      chainId,
      kms,
      timelock: timelockAddress,
      composeHash,
      contractUpgrades: upgrades,
      requireTcbUpToDate,
      allowAnyDevice,
      deviceId: allowAnyDevice ? null : deviceId,
    };
    if (dryRun) {
      return {
        ...base,
        dryRun: true,
        sender,
        predictedApp,
        note: "The app address comes from simulating the call; it changes if anyone else creates an app first. Nothing was sent.",
        problems,
        transactions: [describeTx(1, tx, meaning)],
      };
    }
    if (problems.length > 0) throw new RefusedError("refusing to create the app:\n  - " + problems.join("\n  - "));

    const receipt = await send(signer, tx, meaning, confirmations);
    let app = null;
    for (const entry of receipt.logs) {
      if (getAddress(entry.address) !== kms) continue;
      let parsed = null;
      try {
        parsed = kmsInterface.parseLog(entry);
      } catch {
        parsed = null;
      }
      if (parsed?.name === "AppDeployedViaFactory") app = parsed.args.appId;
    }
    if (!app) {
      throw new Error(`the transaction was mined (${receipt.hash}) but the key service logged no AppDeployedViaFactory event`);
    }

    const verification = await verifyAppSetup(provider, {
      kms,
      app,
      timelock: timelockAddress,
      composeHash,
      allowAnyDevice,
      deviceId,
      requireTcbUpToDate,
      sender,
    });
    const summary = {
      ...base,
      dryRun: false,
      app,
      appVersion: verification.appVersion,
      transaction: receipt.hash,
      block: receipt.blockNumber,
      verification: verification.checks,
      verified: verification.checks.every((check) => check.ok),
    };
    if (!summary.verified) {
      const error = new Error("on-chain verification FAILED; do not deploy the enclave under this app");
      error.summary = summary;
      throw error;
    }
    return summary;
  } finally {
    provider.destroy();
  }
}

/** Reads the chain and checks what the factory call should have left behind. */
export async function verifyAppSetup(
  provider,
  { kms, app, timelock, composeHash, allowAnyDevice, deviceId, requireTcbUpToDate, sender },
) {
  const checks = [];
  const check = (what, ok) => checks.push({ what, ok: Boolean(ok) });
  const read = async (name, args = []) => {
    try {
      return await readContract(provider, appReadInterface, app, name, args);
    } catch {
      return undefined;
    }
  };
  check(`there is a contract at app ${app}`, (await provider.getCode(app)) !== "0x");
  const owner = await read("owner");
  check(`the app's owner is the timelock ${timelock}`, owner === timelock);
  check(`the sender ${sender} is not the app's owner`, owner !== undefined && owner !== sender);
  let appVersion = null;
  for (const [name, version] of Object.entries(APP_VERSIONS)) {
    if ((await read("supportsInterface", [version.managementInterfaceId])) === true) appVersion = name;
  }
  check("the app reports a management interface this tool knows (basic or epoch)", appVersion !== null);
  check(`compose hash ${composeHash} is approved`, (await read("allowedComposeHashes", [composeHash])) === true);
  check(`allowAnyDevice is ${allowAnyDevice}`, (await read("allowAnyDevice")) === allowAnyDevice);
  if (!allowAnyDevice) check(`device ${deviceId} is allowed`, (await read("allowedDeviceIds", [deviceId])) === true);
  check(`requireTcbUpToDate is ${requireTcbUpToDate}`, (await read("requireTcbUpToDate")) === requireTcbUpToDate);
  let registered;
  try {
    registered = await readContract(provider, kmsInterface, kms, "registeredApps", [app]);
  } catch {
    registered = undefined;
  }
  check(`the key service ${kms} lists the app as registered`, registered === true);
  return { checks, appVersion };
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
// Member veto: cancel by signature, with no wallet for the member
//
// contracts/MemberVeto.sol holds the canceller role on the timelock. A member
// signs a veto with a key that holds no money (sign-veto); anyone hands it to
// the contract and pays the fee (relay-veto). Adding a member is immediate
// (add-member, by the enroller); removing one goes through the timelock
// (propose-remove-member, execute-remove-member).
// ---------------------------------------------------------------------------

const VETO_ABI = [
  "constructor(address timelock_, address enroller_, address entryPoint_, uint256 maxCostPerVeto_, address[] members)",
  "function timelock() view returns (address)",
  "function enroller() view returns (address)",
  "function entryPoint() view returns (address)",
  "function maxCostPerVeto() view returns (uint256)",
  "function isMember(address) view returns (bool)",
  "function budget(address) view returns (uint256)",
  "function totalBudget() view returns (uint256)",
  "function memberCount() view returns (uint256)",
  "function pot() view returns (uint256)",
  "function vetoAsMember(bytes32 operationId, address member)",
  "function fund(address member) payable",
  "event Funded(address indexed member, address indexed by, uint256 amount)",
  "function withdraw(address to, uint256 amount)",
  "function addMember(address member)",
  "function removeMember(address member)",
  "function veto(bytes32 operationId, bytes signature)",
];
const vetoInterface = new Interface(VETO_ABI);
const VETO_TYPES = {
  Veto: [{ name: "operationId", type: "bytes32" }],
};
// Must match the EIP712 name and version in MemberVeto.sol's constructor.
const vetoDomain = (chainId, veto) => ({
  name: "Router insights member veto",
  version: "1",
  chainId,
  verifyingContract: veto,
});

/** The committed build of MemberVeto.sol (see build-contract.mjs). */
function memberVetoBuild() {
  let text;
  try {
    text = readFileSync(new URL("./MemberVeto.build.json", import.meta.url), "utf8");
  } catch {
    throw new RefusedError("MemberVeto.build.json is missing; run `node build-contract.mjs` first");
  }
  return JSON.parse(text);
}

const readVeto = (provider, veto, name, args = []) => readContract(provider, vetoInterface, veto, name, args);

async function requireVetoCode(provider, veto) {
  if ((await provider.getCode(veto)) === "0x") throw new RefusedError(`no contract at --veto ${veto} on this chain`);
}

/** Reads the chain and checks what deploying the veto contract should have left behind. */
export async function verifyVetoSetup(provider, { veto, timelock, enroller, entryPoint, maxVetoCost, members }) {
  const checks = [];
  const check = (what, ok) => checks.push({ what, ok: Boolean(ok) });
  const read = async (name, args = []) => {
    try {
      return await readVeto(provider, veto, name, args);
    } catch {
      return undefined;
    }
  };
  check(`there is a contract at member veto ${veto}`, (await provider.getCode(veto)) !== "0x");
  check(`the member veto cancels on timelock ${timelock}`, (await read("timelock")) === timelock);
  check(`the member veto's enroller is ${enroller}`, (await read("enroller")) === enroller);
  check(`the member veto answers to entry point ${entryPoint}`, (await read("entryPoint")) === entryPoint);
  check(`a paid veto may cost at most ${maxVetoCost} wei`, (await read("maxCostPerVeto")) === maxVetoCost);
  check(`the member veto has ${members.length} member(s)`, (await read("memberCount")) === BigInt(members.length));
  for (const member of members) check(`${member} is a member`, (await read("isMember", [member])) === true);
  return checks;
}

export async function signVeto(values) {
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const id = parseBytes32(requireFlag(values, "id"), "--id");
  const { provider, chainId } = await connect(values);
  try {
    const signer = signerFromEnv(MEMBER_KEY_ENV, provider);
    if (!signer) throw new UsageError(`set ${MEMBER_KEY_ENV} to the member's signing key (environment variable only)`);
    await requireVetoCode(provider, veto);
    const timelockAddress = await readVeto(provider, veto, "timelock");
    const readyAt = await timelockAt(timelockAddress, provider).call("getTimestamp", [id]);
    const problems = [];
    if (readyAt <= 1n) problems.push(`operation ${id} is not waiting on timelock ${timelockAddress}; there is nothing to veto`);
    if (!(await readVeto(provider, veto, "isMember", [signer.address]))) {
      problems.push(`${signer.address} is not a member on ${veto}`);
    }
    if (problems.length > 0) throw new RefusedError("refusing to sign:\n  - " + problems.join("\n  - "));
    const signature = await signer.signTypedData(vetoDomain(chainId, veto), VETO_TYPES, { operationId: id });
    return {
      command: "sign-veto",
      chainId,
      veto,
      timelock: timelockAddress,
      operationId: id,
      dueAt: { unixSeconds: readyAt, iso: isoTime(readyAt) },
      member: signer.address,
      signature,
      note:
        "Nothing was sent, so nothing is cancelled yet. Someone has to hand this to the contract with relay-veto " +
        "before the operation is due. It costs the member nothing, and it also cancels this same operation if it is scheduled again.",
    };
  } finally {
    provider.destroy();
  }
}

export async function relayVeto(values) {
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const id = parseBytes32(requireFlag(values, "id"), "--id");
  const signature = requireFlag(values, "signature");
  if (!isHexString(signature, 65)) throw new UsageError("--signature must be a 65-byte 0x value");
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    await requireVetoCode(provider, veto);
    const timelockAddress = await readVeto(provider, veto, "timelock");
    const timelock = timelockAt(timelockAddress, provider);

    const problems = [];
    let member = null;
    try {
      member = verifyTypedData(vetoDomain(chainId, veto), VETO_TYPES, { operationId: id }, signature);
    } catch {
      problems.push("the signature is not a valid signature");
    }
    if (member && !(await readVeto(provider, veto, "isMember", [member]))) {
      problems.push(`the signature is by ${member}, who is not a member on ${veto} (or it was made for a different operation, chain or contract)`);
    }
    if ((await timelock.call("getTimestamp", [id])) <= 1n) {
      problems.push(`operation ${id} is not waiting; there is nothing to veto`);
    }
    if (!(await timelock.call("hasRole", [ROLES.CANCELLER_ROLE, veto]))) {
      problems.push(`${veto} does not have CANCELLER_ROLE on the timelock ${timelockAddress}`);
    }

    const tx = { to: veto, data: vetoInterface.encodeFunctionData("veto", [id, signature]) };
    const meaning = `veto(${id}) on member veto ${veto}, signed by ${member ?? "unknown"}: cancels the operation on timelock ${timelockAddress}`;
    const base = { command: "relay-veto", chainId, veto, timelock: timelockAddress, operationId: id, member };
    if (dryRun) return { ...base, dryRun: true, sender, problems, transactions: [describeTx(1, tx, meaning)] };
    if (problems.length > 0) throw new RefusedError("refusing to relay:\n  - " + problems.join("\n  - "));

    const receipt = await send(signer, tx, meaning, confirmations);
    // Judged from this transaction's own events: the operation may be
    // scheduled again a moment later, and that is a separate fact.
    const cancelled = receipt.logs.some((entry) => {
      if (getAddress(entry.address) !== timelockAddress) return false;
      try {
        const parsed = timelockInterface.parseLog(entry);
        return parsed?.name === "Cancelled" && parsed.args.id === id;
      } catch {
        return false;
      }
    });
    if (!cancelled) {
      throw new Error(`the transaction was mined (${receipt.hash}) but the timelock logged no cancellation of ${id}`);
    }
    return { ...base, dryRun: false, relayedBy: sender, state: "Cancelled", transaction: receipt.hash, block: receipt.blockNumber };
  } finally {
    provider.destroy();
  }
}

export async function addMember(values) {
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const member = parseAddress(requireFlag(values, "member"), "--member");
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    await requireVetoCode(provider, veto);
    const problems = [];
    const enroller = await readVeto(provider, veto, "enroller");
    if (enroller !== sender) problems.push(`${sender} is not the enroller (${enroller}); only the enroller can add a member at once`);
    if (await readVeto(provider, veto, "isMember", [member])) problems.push(`${member} is already a member`);
    const tx = { to: veto, data: vetoInterface.encodeFunctionData("addMember", [member]) };
    const meaning = `addMember(${member}) on member veto ${veto}: this address can veto from now on`;
    const base = { command: "add-member", chainId, veto, member };
    if (dryRun) return { ...base, dryRun: true, sender, problems, transactions: [describeTx(1, tx, meaning)] };
    if (problems.length > 0) throw new RefusedError("refusing to add the member:\n  - " + problems.join("\n  - "));
    const receipt = await send(signer, tx, meaning, confirmations);
    if (!(await readVeto(provider, veto, "isMember", [member]))) {
      throw new Error("the transaction was mined but the address is not a member");
    }
    return { ...base, dryRun: false, transaction: receipt.hash, block: receipt.blockNumber };
  } finally {
    provider.destroy();
  }
}

// ---------------------------------------------------------------------------
// send-veto / fund-veto: the veto contract pays for the veto itself
//
// The veto contract is an ERC-4337 account whose only permitted action is to
// cancel. send-veto builds a user operation, signs it with the member's key,
// and hands it to a bundler (a public relay); the entry point takes the fee
// from the veto contract's deposit. The member holds no money at any point.
// ---------------------------------------------------------------------------

const USER_OP_TUPLE =
  "(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)";
const ENTRY_POINT_ABI = [
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  `function getUserOpHash(${USER_OP_TUPLE} userOp) view returns (bytes32)`,
  "function balanceOf(address account) view returns (uint256)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
];
const entryPointInterface = new Interface(ENTRY_POINT_ABI);
const pack128 = (high, low) => concat([zeroPadValue(toBeHex(high), 16), zeroPadValue(toBeHex(low), 16)]);
const hex = (value) => toBeHex(value);
// Extra gas on top of a bundler's estimate. The estimate is made with a
// placeholder signature, so it does not see the storage write that a real
// member's signature leads to.
const VERIFICATION_GAS_MARGIN = 60000n;

async function bundlerCall(url, method, params, timeoutMs = 30000) {
  let body;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    body = await response.json();
  } catch {
    throw new RefusedError(`could not reach the bundler for ${method}`);
  }
  if (body.error) throw new RefusedError(`the bundler refused ${method}: ${body.error.message ?? JSON.stringify(body.error)}`);
  return body.result;
}

/** The same operation in the two shapes that exist: for a bundler's JSON-RPC, and packed for the entry point. */
function userOperationShapes(op) {
  return {
    json: {
      sender: op.sender,
      nonce: hex(op.nonce),
      callData: op.callData,
      callGasLimit: hex(op.callGasLimit),
      verificationGasLimit: hex(op.verificationGasLimit),
      preVerificationGas: hex(op.preVerificationGas),
      maxFeePerGas: hex(op.maxFeePerGas),
      maxPriorityFeePerGas: hex(op.maxPriorityFeePerGas),
      signature: op.signature,
    },
    packed: {
      sender: op.sender,
      nonce: op.nonce,
      initCode: "0x",
      callData: op.callData,
      accountGasLimits: pack128(op.verificationGasLimit, op.callGasLimit),
      preVerificationGas: op.preVerificationGas,
      gasFees: pack128(op.maxPriorityFeePerGas, op.maxFeePerGas),
      paymasterAndData: "0x",
      signature: op.signature,
    },
  };
}

export async function sendVeto(values) {
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const id = parseBytes32(requireFlag(values, "id"), "--id");
  const gasFlags = ["verification-gas", "call-gas", "pre-verification-gas", "max-fee-wei", "priority-fee-wei"];
  const given = gasFlags.filter((flag) => values[flag] !== undefined);
  if (given.length !== 0 && given.length !== gasFlags.length) {
    throw new UsageError(`give all of ${gasFlags.map((flag) => "--" + flag).join(", ")} or none of them`);
  }
  const manualGas = given.length === gasFlags.length;
  const dryRun = Boolean(values["dry-run"]);
  if (!values.bundler && !(dryRun && manualGas)) {
    throw new UsageError("--bundler URL is required (a dry run with every gas flag given needs none)");
  }
  const { provider, chainId } = await connect(values);
  try {
    const signer = signerFromEnv(MEMBER_KEY_ENV, provider);
    if (!signer) throw new UsageError(`set ${MEMBER_KEY_ENV} to the member's signing key (environment variable only)`);
    const member = signer.address;
    await requireVetoCode(provider, veto);
    const timelockAddress = await readVeto(provider, veto, "timelock");
    const entryPoint = await readVeto(provider, veto, "entryPoint");
    const maxCostAllowed = await readVeto(provider, veto, "maxCostPerVeto");
    const readEntryPoint = (name, args) => readContract(provider, entryPointInterface, entryPoint, name, args);

    const problems = [];
    const readyAt = await timelockAt(timelockAddress, provider).call("getTimestamp", [id]);
    if (readyAt <= 1n) problems.push(`operation ${id} is not waiting on timelock ${timelockAddress}; there is nothing to veto`);
    const isMember = await readVeto(provider, veto, "isMember", [member]);
    if (!isMember) problems.push(`${member} is not a member on ${veto}`);
    const budget = await readVeto(provider, veto, "budget", [member]);

    const op = {
      sender: veto,
      // Each member has their own nonce sequence, so two members vetoing at
      // the same moment do not collide.
      nonce: await readEntryPoint("getNonce", [veto, BigInt(member)]),
      callData: vetoInterface.encodeFunctionData("vetoAsMember", [id, member]),
      signature: "0x",
    };
    if (manualGas) {
      op.verificationGasLimit = parseWholeNumber(values["verification-gas"], "--verification-gas");
      op.callGasLimit = parseWholeNumber(values["call-gas"], "--call-gas");
      op.preVerificationGas = parseWholeNumber(values["pre-verification-gas"], "--pre-verification-gas");
      op.maxFeePerGas = parseWholeNumber(values["max-fee-wei"], "--max-fee-wei");
      op.maxPriorityFeePerGas = parseWholeNumber(values["priority-fee-wei"], "--priority-fee-wei");
    } else {
      if (problems.length > 0) throw new RefusedError("refusing to send the veto:\n  - " + problems.join("\n  - "));
      // Fees: the bundler's own quote when it has one, otherwise from the chain.
      try {
        const quote = await bundlerCall(values.bundler, "pimlico_getUserOperationGasPrice", []);
        op.maxFeePerGas = BigInt(quote.fast.maxFeePerGas);
        op.maxPriorityFeePerGas = BigInt(quote.fast.maxPriorityFeePerGas);
      } catch {
        const block = await provider.getBlock("latest");
        const tip = (await provider.getFeeData()).maxPriorityFeePerGas ?? 0n;
        op.maxPriorityFeePerGas = tip > 1000000n ? tip : 1000000n;
        op.maxFeePerGas = (block.baseFeePerGas ?? 0n) * 2n + op.maxPriorityFeePerGas;
      }
      // A placeholder of the right length, so the bundler can size the operation.
      const placeholder = { ...op, verificationGasLimit: 0n, callGasLimit: 0n, preVerificationGas: 0n, signature: "0x" + "ff".repeat(65) };
      const estimate = await bundlerCall(values.bundler, "eth_estimateUserOperationGas", [userOperationShapes(placeholder).json, entryPoint]);
      op.verificationGasLimit = BigInt(estimate.verificationGasLimit) + VERIFICATION_GAS_MARGIN;
      op.callGasLimit = (BigInt(estimate.callGasLimit) * 12n) / 10n;
      op.preVerificationGas = BigInt(estimate.preVerificationGas);
    }
    const maxCost = (op.verificationGasLimit + op.callGasLimit + op.preVerificationGas) * op.maxFeePerGas;
    if (maxCost > maxCostAllowed) {
      problems.push(`this veto could cost up to ${formatEther(maxCost)} ETH, over the contract's limit of ${formatEther(maxCostAllowed)} ETH per veto; fees are high right now, so use sign-veto and a relayer`);
    }
    if (isMember && budget < maxCost) {
      problems.push(`this member's budget is ${formatEther(budget)} ETH, under the ${formatEther(maxCost)} ETH this veto is charged; it needs fund-veto for this member, or use sign-veto and a relayer`);
    }

    const userOpHash = await readEntryPoint("getUserOpHash", [userOperationShapes(op).packed]);
    // Entry points from v0.8 on give an EIP-712 hash that is signed as it is.
    op.signature = signer.signingKey.sign(userOpHash).serialized;
    const shapes = userOperationShapes(op);
    const base = {
      command: "send-veto",
      chainId,
      veto,
      timelock: timelockAddress,
      entryPoint,
      operationId: id,
      dueAt: { unixSeconds: readyAt, iso: isoTime(readyAt) },
      member,
      userOpHash,
      maxCostWei: maxCost,
      memberBudgetWei: budget,
    };
    if (dryRun) {
      return {
        ...base,
        dryRun: true,
        problems,
        note: "Signed but not sent, so nothing is cancelled.",
        userOperation: shapes.json,
        packedUserOperation: shapes.packed,
      };
    }
    if (problems.length > 0) throw new RefusedError("refusing to send the veto:\n  - " + problems.join("\n  - "));

    log("sending the veto to the bundler");
    const accepted = await bundlerCall(values.bundler, "eth_sendUserOperation", [shapes.json, entryPoint]);
    if (typeof accepted !== "string" || accepted.toLowerCase() !== userOpHash.toLowerCase()) {
      throw new Error(`the bundler answered with ${accepted}, not the hash of the operation that was sent (${userOpHash})`);
    }
    // The bundler is asked only where the operation landed. Whether it
    // cancelled anything is read from the chain itself.
    const timelock = timelockAt(timelockAddress, provider);
    const deadline = Date.now() + 90000;
    let transaction = null;
    while (!transaction && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const reported = await bundlerCall(values.bundler, "eth_getUserOperationReceipt", [userOpHash], 8000).catch(() => null);
      transaction = reported?.receipt?.transactionHash ?? null;
    }
    const chainReceipt = transaction ? await provider.getTransactionReceipt(transaction) : null;
    const logs = chainReceipt?.logs ?? [];
    const parsedFrom = (iface, address) =>
      logs
        .filter((entry) => getAddress(entry.address) === address)
        .map((entry) => {
          try {
            return iface.parseLog(entry);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    // The transaction the bundler names must be the one that ran THIS
    // operation (the entry point's own event, by hash, sender and nonce) and
    // must contain the timelock's cancellation. An older transaction that
    // cancelled the same id would pass the second test but not the first.
    const ran = parsedFrom(entryPointInterface, entryPoint).some(
      (event) =>
        event.name === "UserOperationEvent" &&
        event.args.userOpHash === userOpHash &&
        event.args.sender === veto &&
        event.args.nonce === op.nonce &&
        event.args.success === true,
    );
    const cancelledHere = ran && parsedFrom(timelockInterface, timelockAddress).some(
      (event) => event.name === "Cancelled" && event.args.id === id,
    );
    const stillWaiting = (await timelock.call("getTimestamp", [id])) > 1n;
    if (cancelledHere) {
      return {
        ...base,
        dryRun: false,
        state: "Cancelled",
        transaction,
        block: chainReceipt.blockNumber,
        waitingAgainNow: stillWaiting,
        note: stillWaiting
          ? "This veto cancelled the operation, and it has ALREADY BEEN SCHEDULED AGAIN: it needs another veto."
          : "This veto cancelled the operation. If it is scheduled again, it needs a veto again.",
      };
    }
    const error = new Error(
      transaction
        ? `the veto landed in ${transaction} but that transaction did not cancel the operation; the operation is ${stillWaiting ? "STILL WAITING" : "not waiting any more (something else cancelled or executed it)"}`
        : `the bundler accepted the veto but named no transaction within 90 seconds; the operation is ${stillWaiting ? "STILL WAITING, so veto again or use sign-veto and a relayer" : "not waiting any more"}`,
    );
    error.summary = { ...base, dryRun: false, transaction, stillWaiting };
    throw error;
  } finally {
    provider.destroy();
  }
}

export async function fundVeto(values) {
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const member = parseAddress(requireFlag(values, "member"), "--member");
  const amount = parseEthAmount(requireFlag(values, "eth"), "--eth");
  const { provider, chainId } = await connect(values);
  try {
    const dryRun = Boolean(values["dry-run"]);
    const confirmations = Number(parseWholeNumber(values.confirmations ?? "1", "--confirmations"));
    const { signer, address: sender } = resolveSender(values, DEPLOYER_KEY_ENV, provider);
    await requireVetoCode(provider, veto);
    const problems = [];
    if (!(await readVeto(provider, veto, "isMember", [member]))) problems.push(`${member} is not a member on ${veto}`);
    const before = await readVeto(provider, veto, "budget", [member]);
    const tx = { to: veto, value: amount, data: vetoInterface.encodeFunctionData("fund", [member]) };
    const meaning =
      `fund(${member}) on member veto ${veto} with ${formatEther(amount)} ETH: ` +
      "added to this member's budget for paid vetoes; nobody else can spend it, and it leaves the budget only if the member is removed through the timelock";
    const base = { command: "fund-veto", chainId, veto, member, amountWei: amount, budgetBeforeWei: before };
    if (dryRun) return { ...base, dryRun: true, sender, problems, transactions: [describeTx(1, tx, meaning)] };
    if (problems.length > 0) throw new RefusedError("refusing to fund:\n  - " + problems.join("\n  - "));
    const receipt = await send(signer, tx, meaning, confirmations);
    // Judged from this transaction's own event: the member may spend from
    // the budget in the same moment, which is a separate fact.
    const fundedHere = receipt.logs.some((entry) => {
      if (getAddress(entry.address) !== veto) return false;
      try {
        const parsed = vetoInterface.parseLog(entry);
        return parsed?.name === "Funded" && parsed.args.member === member && parsed.args.amount === amount;
      } catch {
        return false;
      }
    });
    if (!fundedHere) throw new Error(`the transaction was mined (${receipt.hash}) but the contract logged no funding of ${member}`);
    return {
      ...base,
      dryRun: false,
      budgetNowWei: await readVeto(provider, veto, "budget", [member]),
      potWei: await readVeto(provider, veto, "pot"),
      transaction: receipt.hash,
      block: receipt.blockNumber,
    };
  } finally {
    provider.destroy();
  }
}

function readMemberRemovalFlags(values) {
  const timelock = parseAddress(requireFlag(values, "timelock"), "--timelock");
  const veto = parseAddress(requireFlag(values, "veto"), "--veto");
  const member = parseAddress(requireFlag(values, "member"), "--member");
  const round = parseWholeNumber(values.round ?? "0", "--round");
  const calls = [
    {
      target: veto,
      value: 0n,
      data: vetoInterface.encodeFunctionData("removeMember", [member]),
      meaning: `removeMember(${member}) on member veto ${veto}`,
    },
  ];
  const salt = keccak256(
    abi.encode(["string", "address", "address", "uint256"], ["insights-upgrades/remove-member/v1", veto, member, round]),
  );
  const predecessor = ZeroHash;
  return { kind: "member", timelock, veto, member, calls, salt, predecessor, id: operationId(calls, predecessor, salt) };
}

async function memberProblems(provider, op) {
  if ((await provider.getCode(op.veto)) === "0x") return [`no contract at --veto ${op.veto} on this chain`];
  const problems = [];
  const owner = await readVeto(provider, op.veto, "timelock");
  if (owner !== op.timelock) problems.push(`the member veto answers to timelock ${owner}, not ${op.timelock}`);
  if (!(await readVeto(provider, op.veto, "isMember", [op.member]))) {
    problems.push(`${op.member} is not a member, so there is nothing to remove`);
  }
  return problems;
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
  "create-app": createApp,
  "propose-compose-hash": proposeComposeHash,
  execute: executeOperation,
  "propose-canceller": proposeCanceller,
  "execute-canceller": executeCanceller,
  "sign-veto": signVeto,
  "relay-veto": relayVeto,
  "send-veto": sendVeto,
  "fund-veto": fundVeto,
  "add-member": addMember,
  "propose-remove-member": proposeRemoveMember,
  "execute-remove-member": executeRemoveMember,
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
  kms: { type: "string" },
  "contract-upgrades": { type: "string" },
  "allow-any-device": { type: "boolean" },
  "device-id": { type: "string" },
  "allow-outdated-tcb": { type: "boolean" },
  add: { type: "string" },
  "remove-canceller": { type: "string" },
  "member-veto": { type: "boolean" },
  members: { type: "string" },
  enroller: { type: "string" },
  veto: { type: "string" },
  member: { type: "string" },
  signature: { type: "string" },
  "entry-point": { type: "string" },
  "unknown-entry-point": { type: "boolean" },
  "max-veto-cost-eth": { type: "string" },
  bundler: { type: "string" },
  eth: { type: "string" },
  "verification-gas": { type: "string" },
  "call-gas": { type: "string" },
  "pre-verification-gas": { type: "string" },
  "max-fee-wei": { type: "string" },
  "priority-fee-wei": { type: "string" },
  help: { type: "boolean" },
};

const USAGE = `Usage: node upgrades.mjs <command> [flags]

Commands that reach a chain need --rpc URL and --chain-id N (no default).
Commands that send a transaction accept --dry-run (print, send nothing).
Signing keys come only from the environment: ${DEPLOYER_KEY_ENV} (deploy,
create, propose, execute, relay-veto, add-member, fund-veto), ${CANCEL_KEY_ENV} (cancel)
and ${MEMBER_KEY_ENV} (send-veto, sign-veto; this key needs no money).

  deploy-timelock       --delay-hours N --proposer 0x…
                        (--member-veto [--members 0x…,0x…] [--enroller 0x…]
                           [--entry-point 0x…] [--max-veto-cost-eth N] | --cancellers 0x…,0x…)
                        [--executor 0x… | --open-execution]
  create-app            --kms 0x… --timelock 0x… --compose-hash 0x…
                        --contract-upgrades allowed|disabled
                        (--allow-any-device | --device-id 0x…) [--allow-outdated-tcb]
  propose-compose-hash  --timelock 0x… --app 0x… --app-version basic|epoch
                        --compose-hash 0x… [--remove 0x…] [--epoch N] [--round N]
  execute               (same flags as propose-compose-hash)
  propose-canceller     --timelock 0x… (--add 0x… | --remove-canceller 0x…) [--round N]
  execute-canceller     (same flags as propose-canceller)
  send-veto             --veto 0x… --id 0x… --bundler URL   (the veto contract pays)
  fund-veto             --veto 0x… --member 0x… --eth N   (adds to that member's budget)
  sign-veto             --veto 0x… --id 0x…          (signs only; sends nothing)
  relay-veto            --veto 0x… --id 0x… --signature 0x…
  add-member            --veto 0x… --member 0x…      (at once, by the enroller)
  propose-remove-member --timelock 0x… --veto 0x… --member 0x… [--round N]
  execute-remove-member (same flags as propose-remove-member)
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
