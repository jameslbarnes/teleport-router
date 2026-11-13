# Insights enclave upgrades: timelock and cancel-only keys

The insights enclave gets its key from dstack's on-chain key service. The key
is released only to builds whose compose hash is on the app contract's
approved list. This folder holds the tool that changes that list slowly and in
public:

- The app contract is owned by a standard OpenZeppelin `TimelockController`.
- Approving a new build is proposed on chain, waits a fixed delay (48 hours or
  more), and then goes through unless someone cancels it.
- Every group member's agent holds a cancel-only key. It can cancel a waiting
  change and do nothing else.
- Nothing can shorten the wait. Changing the delay, or who may cancel, is
  itself a change that has to wait in the timelock.

Nothing here has been run against a real network. See "What is tested" below.

## Setup

```
npm ci
node upgrades.mjs --help
```

Every command that reaches a chain needs `--rpc URL` and `--chain-id N`. There
is no default chain, and the command refuses if the endpoint reports a
different id. Every command that sends a transaction accepts `--dry-run`: it
prints each transaction (`to`, `data`, and what it means) and sends nothing.

Signing keys are read only from environment variables and never printed:
`INSIGHTS_DEPLOYER_KEY` for deploy, propose and execute, and
`INSIGHTS_CANCEL_KEY` for cancel. A dry run works without a key if you pass
`--from 0x…`, the address that would sign.

Results are printed as JSON on standard output; progress goes to standard error.

## Commands

**`new-cancel-key --out FILE`** makes a fresh key for one member's agent,
writes it to the file with a warning about what it is, and prints only the
address. It will not overwrite a file. The address needs a little ETH on the
chain to pay for a cancel.

**`deploy-timelock --delay-hours N --proposer 0x… --cancellers 0x…,0x… [--executor 0x… | --open-execution]`**
deploys the timelock, gives each canceller the canceller role, then has the
deployer give up its admin role. It then reads the chain and checks the delay,
every role holder, that cancellers hold nothing else, and that the deployer has
no role left. It refuses a delay under 48 hours. Without `--executor`, the
proposer is the executor; `--open-execution` lets anyone execute a change once
its wait is over. If it stops partway, do not use that timelock: deploy a new
one (a half-set-up timelock owns nothing).

**`propose-compose-hash --timelock 0x… --app 0x… --app-version basic|epoch --compose-hash 0x… [--remove 0x…]`**
schedules the approval of a compose hash and, with `--remove`, the removal of
an old one in the same operation. It prints the operation id and the earliest
execution time. Before sending it checks that the app's owner is the timelock,
that the app reports the contract version you named, and that the signer may
propose. The operation's salt is derived from the hashes, so the same request
always has the same id. To schedule an identical change a second time after it
has executed, add `--round 1` (then 2, and so on).

**`execute`** takes the same flags as `propose-compose-hash` and carries out
the operation once its wait is over.

**`cancel --timelock 0x… --id 0x…`** cancels a waiting operation. It signs
with `INSIGHTS_CANCEL_KEY`.

**`status --timelock 0x… [--id 0x…] [--app 0x…] [--from-block N] [--block-chunk N]`**
is read-only. It shows the delay, whether the contract's code is exactly the
OpenZeppelin build this package ships, the holders of each role (rebuilt from
the grant and revoke events, then confirmed against the contract), and every
operation with its state and its calls in plain words. A call the tool does not
recognise is labelled `UNKNOWN call`. With `--app` it shows the app's owner and
which contract version the app reports. On a public RPC endpoint, give
`--from-block` (the `deployBlock` that `deploy-timelock` printed) and a
`--block-chunk` the endpoint accepts.

## Roles after setup

| Who | Can | Cannot |
| --- | --- | --- |
| Proposer | schedule a change; cancel one | execute before the wait is over; shorten the wait |
| Executor (the proposer unless set otherwise) | carry out a change whose wait is over | anything else |
| Each canceller (a member's agent) | cancel a waiting change | propose, execute, change roles or the delay |
| The timelock itself | change roles and the delay, through its own wait | — |
| The deployer | nothing | — |

OpenZeppelin gives every proposer the canceller role too, so the proposer shows
up in the list of cancellers.

Two things the timelock does not cover. A canceller can cancel every proposal,
so one compromised or stubborn cancel key can block upgrades until it is
removed, which itself takes a proposal that key can cancel. And whoever owns
dstack's key service contract (not us) is outside this arrangement.

## The app contract versions

The function that approves a compose hash differs between DstackApp versions,
so it is isolated in one function, `composeHashCalls`, chosen by
`--app-version`:

- `basic`: DstackApp v0.5.9 and v0.6.0. `addComposeHash(bytes32)` and
  `removeComposeHash(bytes32)`.
- `epoch`: DstackApp on the `next` branch. Needs `--epoch N`. Approves with
  `addComposeHashAtEpoch(uint256 epoch, bytes32 composeHash)` and removes with
  `removeComposeHashAtEpochs(0, N, bytes32 composeHash)`, because the source
  says a removal has to clear every epoch row from 0 to the current one.

Both are **confirmed from source only**: the signatures were read from
`Dstack-TEE/dstack`, branch `next`, `dstack/kms/auth-eth/contracts/` (commit
`76bd1f03`, read 2026-11-13) and have not been called on a real DstackApp. How
the key service chooses an epoch when a build asks for its key was not studied.

## What is tested

`npm test` (`node --test upgrades.test.mjs`) starts a local hardhat chain and
runs the real commands against the real OpenZeppelin timelock bytecode:

- two cancel keys are made; the timelock is deployed with them; roles are
  checked independently and the deployer is shown to hold none;
- wrong chain id, a delay under 48 hours, a missing key and a key on the
  command line are all refused, and dry runs send nothing;
- a proposal cannot execute before the wait, by the script or by calling the
  contract directly, and cannot be scheduled with a shorter wait;
- a canceller can cancel and a non-canceller cannot; a cancel key cannot
  propose, execute, grant roles or change the delay;
- proposed again and after the wait, the change executes; `--remove` swaps
  hashes in one operation;
- a new canceller can be added only by a call that goes through the timelock
  and waits.

The app contract in the tests is a small stand-in written for the tests
(`test-contracts/ComposeHashStandIn.sol`): an owner check and functions with
the same names and argument types as DstackApp. It proves the encoded calls and
the ownership rule, not the behaviour of dstack's contract.

Not tested anywhere: Base, the real DstackApp and DstackKms contracts, and
`status` against a public RPC endpoint's block-range limits.

## Open points

1. **Which DstackApp version runs on Base.** Unknown. `status --app 0x…` asks
   the contract which management interface it reports (`0x8fd37527` for
   `basic`, as written in the source; `0x8c0524c4` for `epoch`, computed here
   from the eleven function signatures of `IAppEpochManagement` and not yet
   checked against a deployed contract); `propose-compose-hash` refuses when
   the answer does not match `--app-version`.
2. **Creating the app with the timelock as owner.** The key service's factory
   takes the owner as an argument and sets it directly, with no acceptance
   step. The same two overloads are in v0.5.9, v0.6.0 and `next`:

   ```solidity
   function deployAndRegisterApp(address initialOwner, bool disableUpgrades, bool requireTcbUpToDate,
       bool allowAnyDevice, bytes32 initialDeviceId, bytes32 initialComposeHash) public returns (address appId)
   function deployAndRegisterApp(address initialOwner, bool disableUpgrades,
       bool allowAnyDevice, bytes32 initialDeviceId, bytes32 initialComposeHash) external returns (address appId)
   ```

   It emits `AppDeployedViaFactory(address indexed appId, address indexed deployer)`.
   Pass the timelock as `initialOwner` and the first build's hash as
   `initialComposeHash`. This tool has no command for that call. A new app
   contract means a new app id, and so presumably a new key.
3. **Moving the existing app instead.** Its current owner would call
   `transferOwnership(timelock)`. On v0.5.9 (plain `Ownable`) that takes effect
   at once. On v0.6.0 and `next` (`Ownable2Step`) the timelock must then call
   `acceptOwnership()`, which has to be scheduled and wait out the delay. This
   tool has no command for that either.
4. **Contract upgrades.** DstackApp is upgradeable by its owner unless created
   with `disableUpgrades = true`. With the timelock as owner an upgrade also
   waits and can be cancelled; `status` shows it as `upgradeToAndCall`.
5. **Adding or removing a member's cancel key** has no command yet. It is a
   `grantRole` or `revokeRole` call on the timelock, scheduled through the
   timelock (the test does this directly).
