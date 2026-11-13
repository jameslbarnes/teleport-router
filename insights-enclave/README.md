# The insights enclave: what it is built from, and how an update is checked

The insights enclave is a small app in its own CVM. It holds the one key that can open people's extraction
copies, asks a model one listed question about each trace its owner authorized, and gives back counts. This
folder holds what makes that checkable by someone other than the operator. The program itself is in
`server/src/insights-enclave*.ts`, `insights-program.ts` and `insights-spec.ts`.

## What limits the program

These are rules in code and configuration. None of them depends on a model behaving well.

| Rule | Where it is enforced |
|---|---|
| A run asks only a question listed in the program, named by id. Nobody types a question. | `checkQuestion`, in Router and again in the enclave |
| The model never sees what tools returned (web pages, search results, files, mail, other people's notes): only that a call returned, how much, and whether it failed. | `renderLog` in the enclave; the capture client also leaves it out of the extraction copy |
| Nothing the model writes is kept except three fixed choices. | `parseAnswer` |
| The program has no route to the internet and no model key. | the `sealed` network in `docker-compose.insights-enclave.yml` |
| The only request that leaves is one message to the named model at one address. | `gate.mjs`, embedded in the compose file |
| The program's words have a hash that every consent names. | `insightsProgram`; a change means each owner signs again |

What they do not cover, said plainly:

- What the person typed and what the agent wrote are shown to the model, and can repeat words from outside
  (a paste, a quotation). The start of each tool call's input is shown too.
- A contributor can upload a made-up trace of their own. The three-person minimum and the per-person veto
  are the only guards against that, and three accounts are not proof of three people.
- The model provider sees the text it is sent.
- The sealed previews that go back to Router are opaque to the gate.
- Timing, and how much is sent to the model, can carry a little information.

## The image

`Dockerfile` builds one bundled file onto a stock Node image pinned by digest. The bundle is made by
`server/scripts/bundle-insights-enclave.mjs` from six source files and the locked dependencies; the build
fails if the program starts importing anything else of Router's. Two builds of the same commit on one
machine gave the same bundle hash. The deploy workflow builds the image twice and refuses to deploy if the
digests differ. That workflow has not run yet, and nobody has rebuilt the image on a second machine.

## The gate

`gate.mjs` uses only Node's standard library. `node insights-enclave/embed.mjs` writes it, whole, into the
compose file, to run on a stock Node image. The compose file is measured, so the gate and the network
layout are part of what an owner's client checks. `node --test insights-enclave/gate.test.mjs` covers the
gate and checks that the compose file carries this exact file.

Not yet tried in a CVM: whether dstack's Docker treats the `internal` network as stock Docker does. Check it
on the first deploy by asking the program's container to reach any outside address; it must fail.

## Checking an update

```
node insights-enclave/check-upgrade.mjs --from <approved commit> --to <proposed commit>
```

It compares text between the two commits and gives one of three verdicts:

- **nothing-changed** (exit 0): the enclave would be built from the same text.
- **words-only** (exit 10): only `server/src/insights-spec.ts` changed. The change is printed in full. The
  program's hash changes, so each owner signs a new consent before the new words are used on their traces.
- **needs-a-person** (exit 20): code, dependencies, the image recipe, the gate or the network layout changed.

No model reads anything, so nothing written in the code under review can talk the check round. It says what
changed between two commits; it does not prove an image was built from the proposed commit. For that,
build the image again and compare digests.

## How an update is meant to go

Updates are approved by a timelock that owns the app contract (`insights-upgrades/`). A new build's hash is
proposed in public and waits at least 48 hours. Anyone holding a cancel key can stop it during the wait;
every group member's agent holds one. Nothing can approve an update early or shorten the wait, so a
reviewer that is fooled can only fail to object.

1. The operator runs the check above and posts the proposal to the group: both commits, the report, the
   image digest and the compose hash.
2. Each member's agent runs the same check on the same two commits. On `needs-a-person`, it cancels unless
   its owner has said this update is fine.
3. After the wait, the update is executed, and the old build's hash is removed in the same operation.

This is the design. The contract and timelock are not deployed, the app still uses Phala's own key service
(the operator can update it at will, and the consent says so), and step 1 is done by hand.
