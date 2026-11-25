# Model calls from trace apps

Status: built Nov 22, 2026; switched on for RedPill after a real call through this gateway code, made from outside the enclave on Nov 25, 2026 (UTC), returned a reply with a verified signed receipt. No model run inside the production enclave had been made when this was written. Tinfoil is built and stays off. It adds to `docs/attested-trace-apps.md`, which left model calls out of its first round. Router accepts requests that declare a model only when `TRACE_MODELS` names the provider, and the runner calls RedPill only for a gateway release listed in its spec.

## What it adds

A trace app is a small function that reads one private trace in an enclave and returns a short answer. On its own it has no network, so it cannot ask a language model to read the trace. This change lets it, under limits the owner sees before approving.

For now only attested providers are accepted: ones that prove by attestation, before anything is sent, that the endpoint runs a known release in confidential compute. The runner checks that proof and sends nothing if the check fails. RedPill and Tinfoil qualify today. A request that names any other provider is refused when it is made, with a sentence saying that only attested providers are accepted. Named labs (OpenAI, Anthropic and others), which are trusted rather than verified, are a later step; nothing for them is built.

## The declaration

A request that wants a model carries a declaration with fixed fields and nothing else:

```json
{"provider": "redpill", "model": "z-ai/glm-5.3", "calls": 2, "prompt_bytes": 20000, "reply_tokens": 500}
```

- `provider` is `redpill` or `tinfoil`. There is no field for an address: the runner knows each provider's endpoint.
- `calls` is at most 8, `prompt_bytes` at most 256 KB, `reply_tokens` at most 4096.
- Unknown fields are refused.
- `reply_tokens` covers the model's reasoning as well as its answer. A model that reasons first can spend a small reply size before it writes anything; the call then fails with a sentence saying the reply ran out of its tokens. A few hundred is a sensible floor.

Router writes what the owner reads from these fields (`describeModelUse`): the model and provider, the limits, that the provider is attested and what that does and does not prove, that the calls are billed to the requester's own account, and that the requester's account shows when the calls are made and how many tokens they use, so the requester can tell that the app has run. Because the app's code decides how many calls it makes and how large they are, and the requester sees those numbers, approving a run can tell the requester a little about the trace even if the answer is withheld. The requester's free-text purpose is shown separately, as their claim. The owner's own tool writes these lines again from the declaration rather than taking Router's.

## How an app asks

The sandbox stays as it is: no network, timers or keys. The app's function is `analyze(trace, info, replies)`. `replies` holds the model's replies so far, and is empty the first time. Returning a string is the answer, as before. Returning `{ask: prompt}` asks the model one thing: the runner sends the prompt through the gateway and runs the function again from the start, in a fresh sandbox container, with the reply added (`runWithModel`). The model sees only the prompts the app returned, and the app sees replies only as arguments. Apps that never return `{ask}` behave exactly as before; an app that asks without declaring a model fails with "The app asked for a model but declared none."

The sandbox measures a prompt before copying it out, as it does an answer, and refuses one over 256 KB, an empty one, or one with a lone surrogate (which could not be sent unchanged). The gateway then holds it to the declared size.

A model's reply is untrusted text. It reaches only the sandboxed app, never the runner's own logic.

## The run description

A request without a model keeps the version 1 run description field for field, so runners built before model calls still run it. A request with a model gets version 2, which adds one field, `model_hash`: the SHA-256 of the declaration as canonical JSON. The runner refuses to prepare a version 2 run unless it is handed a declaration with that hash, and refuses at prepare if it has no connector for the provider, so the owner learns before granting anything. The owner's tool checks that a request shown with a declaration has a version 2 description with that declaration's hash, and that one shown without has version 1. Its pin covers the declaration, so it cannot be swapped between `show` and `run`.

## The gateway

`modelGateway` holds the requester's key and enforces the declaration:

- It refuses a call beyond the declared number, or a prompt beyond the declared size, before sending. A call that fails part-way still counts.
- It sends one fixed request shape to one fixed path: the declared model, the prompt, the reply limit, no streaming.
- It reports failures as fixed sentences. A provider's error text can quote the prompt, and the key must never appear, so neither is passed on.
- It keeps a record for the run: provider, model, calls made, the release that was verified, the verifier's verdict, and receipt IDs. No prompt, reply or key. The runner seals this record to the owner with the answer, inside what the run's key signs.

One deadline covers a whole run: 140 seconds from the moment the runner is handed its grant. Reading the trace keeps its own 60-second limit. The attestation check, each model call, reading its reply (a bounded read that stops once the reply passes its limit) and checking its receipt all end by the smaller of 60 seconds and the time left, and closing the connection takes at most 3 seconds. Past the deadline the run ends with "The run ran out of time". Whatever a provider's code is doing, the run settles a few seconds after its deadline and frees its slot in the runner.

## Attested providers

The rule is a standard, not a supplier: a provider qualifies if the runner can verify, before sending, that the endpoint is an enclave running a known release, and can bind the connection to it. Two qualify today, each with its own verifier (`trace-model-providers.ts`).

- **RedPill** (`tee.redpill.ai`, which serves confidential models only). The runner verifies the gateway's TDX quote to Intel's root and checks that the release is one Router accepts, then pins TLS to a key from the attestation. Every call demands a verified model provider and returns a signed receipt, which the runner verifies before using the reply. RedPill's gateway reads the prompt inside its own enclave and verifies the model's enclave on the caller's behalf; the owner is told this.
- **Tinfoil.** Its client checks the enclave's attestation against the release named in Tinfoil's public transparency log. The runner uses the client's TLS transport, which sends each whole request, headers and the requester's key included, over TLS pinned to the key the attestation names, and fails if the attestation names none. (The client's default transport encrypts only the request body to the enclave and sends the headers, key included, over ordinary HTTPS.) Each run uses a fresh cache secret, so runs do not share the provider's prompt cache. It issues no receipts. Router does not review Tinfoil's releases; the owner is told this. The TLS transport has not yet been checked against the live service with a real key, so Tinfoil stays off until it has been.

What the app puts in a prompt leaves Router's enclave for the provider's. That the provider keeps none of it is the provider's promise; attestation proves which code is running, not what its operator keeps. Limits the providers state themselves: the models are open-weight; where the weights came from is not attested; RedPill's verifier does not yet check how the gateway's keys are held.

### Upkeep

The runner reads its accepted RedPill releases from `REDPILL_RELEASES` (comma-separated sha256 hashes) in its own environment, which is part of its measured spec. Without any, runs that declare RedPill are refused at prepare. RedPill publishes each gateway release at least three days before it rolls out. The list has to include a release before that rollout, or RedPill calls stop until it does (they fail closed). This is a routine like the approvals for containers in Router's enclave.

The routine: once a day `.github/workflows/redpill-releases.yml` runs `scripts/redpill-releases.mjs`, which reads RedPill's gateway releases on GitHub, computes each one's hash from its published `app_compose.json`, asks the gateway's app contract on Base whether it allows that hash, and opens a pull request when the list should change. A person reviews and merges it; nothing is accepted automatically. The list holds the release that is live, the one before it (replicas run both during a rollout), and any that is announced, so it changes once per release. Each change is a deploy and gives the runner a new measured identity, and RedPill has shipped a gateway release about twice a week, so this is a frequent routine.

## The requester's key

The requester creates and funds a key at the provider, for this purpose and with a small spending limit; Router never pays. They send it with the request as `model_key`, which is required exactly when a model is declared. The key stays in the requester's own conversation log, which is why it should be made for this with a small spending limit. Router seals it at once and stores only the sealed form: AES-256-GCM under a key derived (HKDF-SHA256) from a secret that exists only inside Router's enclave, with the request's ID, its revision and the declaration's hash as associated data. Router also keeps a keyed hash of the key, so the same request sent again is recognised whether or not the app has run; it cannot be turned back into the key. The key appears in no view, error, log or notice. Approving a run opens it, hands it to the runner with the grant, and drops it from the record in the same step that claims the run, so one request pays for at most one run: preparing again afterwards is refused, and the owner declines so the requester can ask again. It is also dropped when the request is released, declined, withheld or withdrawn, and when a new request replaces it. Router's operator cannot read it outside the enclave; Router itself, inside the enclave, can.

While no provider is enabled, the tool's description and schema say nothing about models or keys, so an agent never sends a key only to have it refused.

The requester's own agent tooling must keep the key out of their uploaded traces too: the capture client replaces the `model_key` field of every recorded call to `router_trace_access`.

## Switching it on

- Router: `TRACE_MODELS=redpill,tinfoil` (or one of them). Unset, every request that declares a model is refused.
- The runner and sandbox: an image that contains this code, pinned in `subhost/runner.base.json` and `subhost/sandbox.base.json`, and `REDPILL_RELEASES` in the runner's spec for RedPill. Both base files pin an image that has this code. Production sets `TRACE_MODELS=redpill` in `docker-compose.template.yml`.
- A change to `REDPILL_RELEASES` changes the runner's measured spec, so it needs `node subhost/embed.mjs`, a deploy, and owners' tools on a checkout with the same list.

## Code

- `server/src/trace-model.ts`: the declaration and its hash, the owner-facing wording, the gateway, the loop that lets an app ask, and the vault for requesters' keys.
- `server/src/trace-model-providers.ts`: the RedPill and Tinfoil connectors.
- `server/src/trace-app.ts`: `runAppStep`, one run of the function that returns an answer, an error or a prompt.
- `server/src/trace-run.ts`: version 2 descriptions, the runner's model runs, the deadline, and the record of model use in the sealed result.
- `server/src/trace-access.ts`: declarations and keys on requests, what owners and requesters see.
- `server/scripts/trace-model-check.mjs`: a live check of both providers' attestations; with a key set, it also makes one call.
