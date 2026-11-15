# Insights enclave upgrades: timelock and member veto

The insights enclave gets its key from dstack's on-chain key service. The key
is released only to builds whose compose hash is on the app contract's
approved list. This folder holds the tool that changes that list slowly and in
public:

- The app contract is owned by a standard OpenZeppelin `TimelockController`.
- Approving a new build is proposed on chain, waits a fixed delay (48 hours or
  more), and then goes through unless someone cancels it.
- Every person in the pool can cancel a waiting change, and needs no wallet
  or money to do it. Their agent signs a veto with a key that holds nothing.
  A small contract (`contracts/MemberVeto.sol`) holds the cancel power and
  pays the fee for the veto itself, out of a budget it keeps for each member,
  which anyone can add to and nobody else can spend. The
  agent sends the signed veto to a public relay (an ERC-4337 bundler), so
  nobody else has to act: not the operator, not Router, not a person with a
  wallet. As a second way, the same contract accepts a member's signature
  from whoever hands it over and pays for it.
- Joining the pool gives the power to veto at once. Leaving takes it away
  only after the wait.
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
`INSIGHTS_DEPLOYER_KEY` for deploy, create, propose, execute, relaying a veto
and adding a member; `INSIGHTS_MEMBER_KEY` for signing a veto (this key needs
no money); and `INSIGHTS_CANCEL_KEY` for a direct cancel. A dry run works without a key if you pass
`--from 0x…`, the address that would sign.

Results are printed as JSON on standard output; progress goes to standard error.

## Commands

**`new-cancel-key --out FILE`** makes a fresh key for one member's agent,
writes it to the file with a warning about what it is, and prints only the
address. It will not overwrite a file. The address needs a little ETH on the
chain to pay for a cancel.

**`deploy-timelock --delay-hours N --proposer 0x… --member-veto [--members 0x…,0x…] [--enroller 0x…]`**
deploys the timelock and then the member veto contract, gives the veto
contract the canceller role, and has the deployer give up its admin role. The
enroller is the address that may add members later; it is the proposer unless
`--enroller` says otherwise. `--entry-point` names the ERC-4337 entry point
the veto contract answers to (v0.9 unless given) and `--max-veto-cost-eth` the
most one paid veto may cost it (0.0002 unless given); neither can be changed
afterwards. It refuses unless the code at the entry point's address is the
v0.9 code this tool knows. The checks afterwards also read the veto
contract's timelock, enroller, entry point, limit and members. Every budget
starts empty: run `fund-veto` for each member before relying on paid vetoes.

**`send-veto --veto 0x… --id 0x… --bundler URL`** is how a member's agent
vetoes. It builds an ERC-4337 user operation that does one thing, cancel that
operation; signs it with `INSIGHTS_MEMBER_KEY`; asks the bundler for gas
figures; and sends it to the bundler. The veto contract pays the fee and
charges it to that member's budget. It refuses beforehand if the operation is
not waiting, the signer is not a member, the charge would be over the
contract's limit per veto, or the member's budget is too small. It reports
"Cancelled" only when the chain's own record of the transaction shows the
timelock cancelling that operation. `--dry-run` signs and prints the operation
without sending it.

**`fund-veto --veto 0x… --member 0x… --eth N`** adds to one member's budget
for paid vetoes. Anyone can. Nobody can spend it for another member, and it
leaves the budget only if the member is removed through the timelock.

**`sign-veto --veto 0x… --id 0x…`** is the second way. It signs a member's veto of one waiting
operation with `INSIGHTS_MEMBER_KEY` and prints it. It sends nothing and costs
nothing, and by itself it cancels nothing: someone has to relay it before the
operation is due. The signature covers that one operation, on this chain and
this contract only. It keeps working if the proposer cancels the operation
and schedules the same one again.

**`relay-veto --veto 0x… --id 0x… --signature 0x…`** hands a signed veto to
the contract, which cancels the operation. Any key with a little ETH can do
this; it does not have to be Router's.

**`add-member --veto 0x… --member 0x…`** adds a person who has joined the
pool. Only the enroller can, and it takes effect at once.

**`propose-remove-member --timelock 0x… --veto 0x… --member 0x…`** schedules
removing a person who has left; **`execute-remove-member`** carries it out
after the wait. Nobody can remove a member any faster.

**`deploy-timelock --delay-hours N --proposer 0x… --cancellers 0x…,0x… [--executor 0x… | --open-execution]`**
is the older arrangement, with a funded cancel key per member instead of the
veto contract. It
deploys the timelock, gives each canceller the canceller role, then has the
deployer give up its admin role. It then reads the chain and checks the delay,
every role holder, that cancellers hold nothing else, and that the deployer has
no role left. It refuses a delay under 48 hours. Without `--executor`, the
proposer is the executor; `--open-execution` lets anyone execute a change once
its wait is over. If it stops partway, do not use that timelock: deploy a new
one (a half-set-up timelock owns nothing).

**`create-app --kms 0x… --timelock 0x… --compose-hash 0x… --contract-upgrades allowed|disabled (--allow-any-device | --device-id 0x…) [--allow-outdated-tcb]`**
creates the app contract through the key service's factory with the timelock
as its owner from the first block, so no key ever owns the app. It refuses
unless the timelock is the OpenZeppelin build this package ships, waits at
least 48 hours, is its own admin, and the signer has no admin role left on it.
It simulates the call first and prints the address the app would get. After
sending it reads the chain and checks the owner, the approved hash, the device
rule, and that the key service lists the app. `--contract-upgrades` has no
default: `disabled` means the app contract's own code can never be replaced;
`allowed` means the owner (the timelock) can replace it, after the wait.
Builds must be on up-to-date hardware firmware unless `--allow-outdated-tcb`
is given.

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

**`propose-canceller --timelock 0x… (--add 0x… | --remove-canceller 0x…)`**
schedules giving a cancel key to a person who has joined the pool, or taking
one away from a person who has left. Only the timelock can change who holds a
cancel key, so this waits the full delay like any other change, and any
existing cancel key can stop it. It refuses to add an address that already
holds a role. **`execute-canceller`** takes the same flags and carries it out
once the wait is over. Because the key is not live for the first 48 hours, a
new member's traces must not be read until it is.

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
| The member veto contract | cancel a waiting change, when given a member's signature; pay the fee for doing so, up to its limit | propose, execute, change roles or the delay; pay for anything else |
| Each pool member (through the veto contract) | cancel a waiting change by signing | anything else; they hold no role and no money |
| The enroller (the proposer unless set otherwise) | add a member at once (with no budget) | remove a member; touch any member's budget |
| Anyone | add to a member's budget; carry a member's signed veto to the chain | spend a budget or take it back |
| Each direct canceller, if any were set | cancel a waiting change | propose, execute, change roles or the delay |
| The timelock itself | change roles and the delay; remove a member (their budget then belongs to nobody); withdraw money that is in no member's budget, all through its own wait | take from a current member's budget |
| The deployer | nothing | — |

OpenZeppelin gives every proposer the canceller role too, so the proposer shows
up in the list of cancellers.

Things this arrangement does not cover. Any one member can cancel every
proposal, so one compromised or stubborn member key can block upgrades until
it is removed, which itself takes a proposal that member can cancel; the way
out is a new app that everyone agrees to again. The enroller can add members
nobody asked for, which can only block the operator's own upgrades.

What a veto is and is not (from an independent review on 2026-11-14):

- **A veto is against one operation, not against an idea.** The same change
  with another salt, or a build that differs by one byte, is another
  operation. It waits the full delay again and needs its own veto. So
  members' agents have to look at every operation that is scheduled, and two
  scheduled at once need two vetoes.
- **A signed veto does nothing until it reaches the chain.** `send-veto`
  takes it there through a bundler, at the contract's expense, without the
  operator. That depends on a bundler accepting it and on the deposit not
  being empty; `sign-veto` with a relayer is the fallback. An operation can be
  executed in the same second it becomes due, so a veto should be sent early,
  not near the end of the wait.
- **A member's budget can run out.** Each paid veto is charged at the most
  it could cost, whether or not it cancels anything, to the budget of the
  member who signed it. A member can waste only their own budget; members
  added by the enroller start with none; a budget is lost only when its
  member is removed through the timelock. But
  whoever proposes can schedule one operation after another, and each one a
  member vetoes costs that member a charge, so a determined proposer can run
  a member's budget down. Anyone can top it up, and `sign-veto` with a relayer
  still works when it is empty. When fees on the chain are above the limit
  per veto, paid vetoes stop working until they fall.
- **At most a few paid vetoes can wait at once.** Bundlers keep only a small
  number of pending operations from one contract (four, by the current
  rules), and all members share this one contract. One veto is enough to
  cancel an operation, so this matters only if many different operations are
  being vetoed in the same moment.
- **The delay and the roles are themselves changeable through the timelock.**
  A scheduled `updateDelay`, `revokeRole` on the veto contract, `grantRole`,
  or an `UNKNOWN call` waits like anything else and can be vetoed, and has to
  be: an agent that only looks at compose-hash approvals would miss the
  operation that removes its own veto.
- **`verified: true` after deploying is the deployer checking its own work.**
  It includes the full history of role grants since the timelock was made.
  Someone who does not trust the deployer should run `status` and compare the
  veto contract's creation transaction with `MemberVeto.build.json`; no
  command does the second part yet. And whoever owns
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
  and waits;
- `create-app` makes an app whose owner is the timelock and on which the
  creating key can approve nothing; the app then takes an upgrade through the
  timelock;
- `propose-canceller` adds and removes a cancel key only after the wait, and
  an existing cancel key can stop an addition;
- with `--member-veto`, the veto contract ends up holding the canceller role
  and nothing else; a member whose key has never held any money vetoes by
  signature and a stranger carries it to the chain; a signature by a
  non-member or for another operation is refused by the tool and by the
  contract; when the proposer schedules the vetoed operation again, the same
  signature cancels it again;
- a member added by the enroller can veto at once; nobody can remove a member
  directly; a removal waits and the member can veto it; left alone it goes
  through and the key stops working;
- the committed `MemberVeto.build.json` matches a fresh compile;
- the paid way, against the real entry point's code (copied from Base into
  `test-fixtures/` and placed at its real address on the local chain, with
  the test playing the bundler): a member who holds nothing cancels an
  operation and the fee comes out of the contract's deposit and goes to the
  bundler, charged to that member's budget and nobody else's; the same
  signed operation cannot be used twice; the contract refuses to pay for a
  non-member, for a member's name on another key's signature, for a member
  using another member's sequence, for a member the enroller has just added
  (no budget), for any call other than a veto, and for a veto priced above
  the limit; a member who wastes paid vetoes runs out of their own budget and
  the other member's is untouched; money in no member's budget leaves only
  through the timelock after the wait, and money in a budget not even then.

The app contract in the tests is a small stand-in written for the tests
(`contracts/stand-ins/ComposeHashStandIn.sol`): an owner check and functions with
the same names and argument types as DstackApp. The key service in the tests
is likewise a stand-in (`contracts/stand-ins/KmsFactoryStandIn.sol`). They prove the
encoded calls and the ownership rule, not the behaviour of dstack's contracts.

Read from Base on 2026-11-14, sending nothing: Phala's key service there
(`0x2f83172A49584C017F2B256F0FB2Dca14126Ba9C`, from Phala's public key-service
list) has both factory overloads, `registeredApps` and the factory event in
its code; its app template reports the `basic` interface and not `epoch`, and
has no `acceptOwnership`; and a simulated `deployAndRegisterApp` with a
not-yet-deployed timelock address as owner returned an app address. A dry run
of `deploy-timelock` against Base printed its transactions.

Tried once on Base itself, on 2026-11-15, with a throwaway copy (timelock
`0x786381A3Fb71719ae2f8E563a2e7cBfA969d8c61`, member veto
`0x47c89c801024991691c1Ad3550739fF146106241`, one made-up member): `deploy-timelock
--member-veto`, `propose-canceller`, `fund-veto` and `send-veto` through
Pimlico's public bundler endpoint. The bundler accepted the operation and
transaction `0xa38433abf1ef92594039c6cb1d72095e5f2459c637a872e0d42f0dde75088a49`,
sent by the bundler's own account, cancelled the waiting operation. The member's
key held nothing before or after and never sent a transaction. The veto cost
the contract about 0.00000075 ETH and was charged to the member's budget at
0.0000016 ETH. That is one veto through one bundler on one day. What the trial
also showed: a bundler will not estimate a veto until the member has a budget
(`fund-veto` first), and free public chain endpoints fail often enough
(rate limits, a node that has not yet seen the previous transaction, refused
log queries) that a real deployment should use a dependable endpoint; two
earlier attempts stopped after the timelock and were abandoned.

Not tested anywhere: other bundlers, several members vetoing at once,
`create-app` or anything else beyond the commands named above on Base, the real DstackApp and
DstackKms contracts beyond the reads above, whether Phala Cloud will run an
enclave under an app contract created this way instead of by its own tooling,
and `status` against a public RPC endpoint's block-range limits.

## Open points

1. **Which DstackApp version runs on Base.** `basic`, by the read on
   2026-11-14 described above; check again before the first proposal, since
   the key service's owner can change the template. `status --app 0x…` asks
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
   `initialComposeHash`. `create-app` makes that call (the first overload). A
   new app contract means a new app id, and so presumably a new key. Still
   open: how Phala Cloud is told to run an enclave under an app contract it
   did not create itself.
3. **Moving the existing app instead.** Its current owner would call
   `transferOwnership(timelock)`. On v0.5.9 (plain `Ownable`) that takes effect
   at once. On v0.6.0 and `next` (`Ownable2Step`) the timelock must then call
   `acceptOwnership()`, which has to be scheduled and wait out the delay. This
   tool has no command for that either.
4. **Contract upgrades.** DstackApp is upgradeable by its owner unless created
   with `disableUpgrades = true`. With the timelock as owner an upgrade also
   waits and can be cancelled; `status` shows it as `upgradeToAndCall`.
5. **The veto follows pool membership** (decided 2026-11-14): joining the
   pool adds the person to the veto contract and leaving removes them. Not
   built yet: Router calling `add-member` when someone joins, and members'
   agents watching every scheduled operation and running `send-veto` on their
   own.
8. **Which entry point and which bundlers.** The default is entry point v0.9
   because the pinned OpenZeppelin release defaults to it and its code is on
   Base. One public bundler endpoint on Base listed it on 2026-11-14. How
   many bundlers serve it, and their rate limits, were not checked.
6. **Which key a member signs with.** The tool takes any key from
   `INSIGHTS_MEMBER_KEY`. Whether that is the key the member already signed
   the consent with, or one made for this, is not settled.
7. **`MemberVeto.sol` has not been audited** and has not been deployed
   anywhere but the local test chain.
