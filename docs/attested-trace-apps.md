# Trace requests that carry an attested app

Status: design and local prototype on branch `brin-attested-trace-apps`, Nov 21, 2026. Not deployed. Revised the same day after an independent review.

## What changes

Since Nov 20, a person whose agent can read a note can ask its author for the private trace behind it. The request names a key from the requester's own device. If the owner allows it, that device can decrypt the whole session slice for 24 hours and keep a copy. The owner only learns of a request by opening the trace access page.

With this change, every request carries a small app, and the requester never gets the trace itself, only an answer the owner has read and released:

1. The requester's agent writes the app: a JavaScript function that reads the trace and returns a short answer, plus one sentence on what it is for, and a public key for receiving the answer. A request without an app is refused. Router checks that the code parses before accepting it.
2. The owner is told that a request is waiting: by email when they have a verified address (it names no requester, purpose or code), and in a notice at the start of their agent's next session.
3. The owner reads the app's code and purpose, then presses Run.
4. The trace runner, a fixed program in an enclave, prepares a run of that exact code for this request and this version of the trace, with a fresh key. The enclave's attestation commits to a description of the run and to the key. The owner's side checks it, then lets that key read this one trace for a few minutes.
5. The runner decrypts the trace, runs the app in a sandbox that can only return a string, and seals the result to the owner. Router holds only ciphertext.
6. The owner reads the answer. To release it, the owner's side seals that exact answer to the requester's key; to withhold it, it does nothing.

An answer can contain parts of the trace; that is the owner's call when releasing. What the design guarantees is narrower: no direct access to the trace, and nothing leaves except what the owner released.

The owner can also set their own agent to do this for them, under whatever conditions they give it. Router does not decide either way. The agent uses the same owner tool on the owner's machine, so every check below still applies.

## The app

```js
// purpose: Count which tools the agent called while writing this note.
function analyze(trace, info) {
  const counts = {};
  for (const line of trace.split('\n')) {
    const m = line.match(/"name":"(\w+)"/);
    if (m) counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  return JSON.stringify(counts);
}
```

- `trace` is the decrypted session slice as text. `info` holds the note ID and the trace's size.
- The return value must be a string of at most 8 KB. Anything else fails the run.
- The code is at most 32 KB of plain JavaScript, run by QuickJS compiled to WebAssembly. The sandbox gives it no network, files, processes, timers or keys. It gets 256 MB of memory and 10 seconds. If the engine's own checks miss, the runner gives up a few seconds later and the host removes the app's container.
- The app's hash is SHA-256 of `{"code":…,"runtime":"quickjs-wasm/v1"}` as canonical JSON. The runtime's own version is fixed by the runner's code hash.

## Where the code lives

With the request. A deploy ships only the runner, which the enclave measures when it starts. The app's code is data that Router stores with the request, shows to the owner and hands to the runner. The run's attestation commits to the hash of that code, and the owner's side compares it with the hash of the code it displayed. A new app never needs a deploy; a change to the runner does.

The app is attached when the request is sent, but it is attested when it runs: the attestation is a statement about code running now with a fresh key, so it cannot usefully be made earlier.

## The run, and what its attestation says

Router asks the runner to prepare a run with the app's code and a run description:

```
request ID and revision, requester, owner DID, note ID, trace part, SHA-256 of the trace ciphertext,
app hash, run ID, expiry, answer limit, owner's public key (the answer is sealed to it),
requester's public key (only an answer sealed to it can be released)
```

The runner recomputes the app hash from the code, checks it matches, makes a key in memory and registers `{run_id, description hash, public key}` with the host. The bundle's report data is SHA-512 of canonical `{domain: "teleport-router/trace-run/v1", app_id, name, code_hash, run_hash, public_key, nonce}`, where `code_hash` is the runner's and `nonce` is the owner's fresh nonce. A different domain from the probe's binding means a probe quote can never pass as a run quote.

The owner's side checks the quote (the TDX signature with Phala's verifier, then the checks in `subhost/verify.mjs`), reads the trace's record from the owner's own storage rather than from Router, recomputes the description and the app hash from what it showed the owner, wraps the trace's content key to the run key and signs a TinyCloud grant for that key: get-only, this trace's folder, 15 minutes.

When it runs, the runner refuses a trace whose ciphertext hash differs from the description, refuses a second run with the same key, seals the result to the owner's key and signs it with the run's key. Anyone can seal text to the owner's public key, so the signature is what shows the owner that the attested run produced it. A trace read that stalls is abandoned after a minute, so it cannot hold a run slot. A run that is not approved within 10 minutes is dropped with its key. One run at a time per owner and two overall.

## Answers and failures

The runner seals the result, answer or error, to the owner with the same envelope as traces (`trace-envelope.ts`, part `answer`). Router stores only that ciphertext, so the operator cannot read it and Router cannot release it on its own. App errors and stack traces can quote the trace, so they are sealed too. Neither the runner nor Router logs them.

The owner's tool remembers the run, the answer's hash and the requester's key it reviewed, and `release` refuses unless all three are unchanged. `show` prints a pin covering the request as read: its version, requester, note, purpose, the code's hash computed on the owner's machine, and the requester's key. `run` refuses without that pin or if any of it changed, so Router cannot swap the request between reading and running. It shows code, purposes and answers with control and text-direction characters escaped, so a stranger's text cannot hide or rewrite what the terminal shows.

The requester sees only `pending`, `released`, `declined` or `withdrawn`, with no timing or failure detail before release. Asking again gets the same reply before and after the app has run, and changing the app means withdrawing the request first, so neither can reveal when it ran. Errors from the runner reach the owner only as fixed sentences. Release is the owner's side opening the sealed answer and sealing those exact bytes to the requester's key. Router records the release in one transaction, with the sealed answer's own hash as the receipt, and checks again that the requester can still read the note. No hash of the plain answer is sent: Router could test guesses against it, and a yes, a no or a small count is easy to guess. Withholding shows the requester `declined`.

## Who has to be trusted

- **The runner and its enclave**, through the attestation.
- **Whatever checks the attestation on the owner's side.** The trace access page is served by Router, and today it already handles the owner's private key to rewrap trace keys. A page that lied could show one app and approve another. So the first version checks and approves with a command-line tool on the owner's machine (or their agent's), like `server/scripts/subhost-grant.mjs`. A browser version can follow once we decide how much to trust a Router-served page.
- **Not Router, for answers.** Router only ever holds them sealed.

## Where runs happen

Decided Nov 21: inside Router's own enclave, through the sub-container host (the owner's decision). Requesters never run infrastructure in either design; the alternative was one separate enclave run by Router for everyone, which would have kept strangers' code off the machine that holds Router's keys.

Inside Router's enclave, two safeguards make up for that closeness. The part that holds the run key and reads the trace (the runner container) never executes an app. Each app runs in a fresh sandbox container of its own with no network and no keys, inside the WebAssembly sandbox. See "Trace app runs" in `subhost/README.md`.

Turning it on takes two deploys, each with the owner's approval: the first ships the code, so CI builds a Router image carrying it; the second pins that image in `subhost/runner.base.json` and `subhost/sandbox.base.json`, updates the compose template and approved template, and sets `TRACE_APPS=subhost` on Router.

## Changes to the Nov 20 release

- `router_trace_access` `request` takes `app: {code, purpose}` and `answer_public_key` instead of `reader_public_key`, and refuses requests without an app.
- Requests made before this change can still be declined, but not approved.
- `inbox` returns each request's purpose and code, so the owner's agent can review it.
- New owner actions: `prepare`, `approve` (now with a run), `release` and `withhold`. `status` returns the sealed answer once released.
- Requesters can `withdraw` a request, which they must do before sending a different app.

## Not in this round

- A limited approval key. An agent that approves for its owner works with the owner's storage key today. A key that can only grant short reads of traces to attested runs would let it approve with less, and while the owner's machine is off. This is the same question as the open proposal on delegating insights runs while the owner is offline.
- AI model calls from an app. With no network an app cannot ask a model to read the trace. Allowing one would send the trace to that provider, and the owner would have to be told which.
- The browser approval page.

## Prototype

Local only, with synthetic traces. The attestation is simulated: bundles say so, and `checkRunBundle` refuses them unless the caller opts in for a local test. `checkRunBundle` checks the binding, not the attestation: for a real bundle it refuses to pass unless given the report data read from a quote the caller has already verified. No runner is deployed, so on a real server `prepare` answers that trace apps cannot run there yet; `TRACE_APPS=local-simulated` (never in production) runs them in Router's own process for local development.

- `server/src/trace-app.ts`: app checks and hash; the QuickJS sandbox and its limits.
- `server/src/trace-run.ts`: the run description, its binding, the owner-side check, sealed answers, the runner's prepare and run steps, the worker that kills a stuck app, and the TinyCloud reader.
- `server/src/trace-access.ts`: requests with apps; `prepare`, `approve`, `release`, `withhold`; requests made before apps can only be declined.
- `server/src/http.ts`: the tool's description and schema; the owner-only steps are refused over MCP, because they need keys the agent does not hold.
- `trace-access.html`, `browser/src/trace-access.mjs`: the page shows each app's purpose and code, with Decline or Withhold. Running and releasing are not on the page yet.
- `server/scripts/trace-reader.mjs`: the requester's tool sends an app and opens a released answer.
- `server/scripts/trace-app-demo.mjs`: one request end to end, printing what each side sees.
- `server/scripts/trace-app-sandbox-check.mjs`: hostile apps against the worker's hard stop, timed.
- Tests (`trace-app.test.ts`, `trace-access.test.ts`): an app that reaches for the outside, loops forever, exhausts memory, recurses or returns too much; a swapped app, a swapped trace, a grant for another key or longer than 15 minutes, a replayed run, an expired run, another owner, a release of another run's answer or sealed to the wrong key, a requester who lost access, withholding, and old requests.

Found while testing: this QuickJS build shares storage between concatenated strings, so an app that piles up repeated strings uses almost no memory and is stopped by the time limit instead. Arrays and objects count in full against the memory limit.

## Reviews

Four independent reviews by another model, Nov 21. The first, of the design, led to sealing answers to the owner, binding the run description into the attestation, single-use runs, fixed requester states, and checking approvals outside the Router-served page. It also recommended a separate enclave for runs. The second, of the code, found that a finished run could overwrite a request declined or replaced meanwhile, that re-sending a request revealed when the app had run, that the local server path skipped the worker's hard stop, that runner errors could pass through, and that the bundle check could be mistaken for verifying attestation. All five are fixed and tested. A third, of the in-enclave code, asked to hold activation until results were signed by the run's key and release was pinned to what the owner reviewed, real attestations fit the reply limit, the owner's tool read the trace version from the owner's own storage, stalled reads and orphaned sandboxes could not exhaust the runner, and a runner failure could not take the host (and Router's keys) down. All five are fixed; the host's own test of runs needs Linux and has not run yet. A fourth, of the owner tool, found that Router was sent a hash of each plain answer and that `run` was not pinned to the request the owner had read; both are fixed. Running the owner tool against real storage then showed that Router refused the read grant it made. It now makes the grant the way the tested path does, and the hosted-storage check runs the tool itself.

## Next

1. The two deploys above, after a review of the in-enclave code and a run of `subhost/runs.test.mjs` on Linux.
2. A first real run with the owner tool (`server/scripts/trace-app-owner.mjs`) against the deployed runner, with a throwaway trace.
3. The browser approval page, once the trust question above is settled.
