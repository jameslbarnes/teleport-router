# Sub-container host (prototype)

A test of granting TinyCloud access to one container's code, inside Router's own
enclave, without a separate CVM. It follows the pattern of Andrew Miller's
[dstack-webhost](https://github.com/amiller/dstack-webhost): an outer program
subdivides one CVM, and each inner container's attestation carries its own code
hash in the quote's report data.

## What runs

- **`subhost`** (`host.mjs`), a service in Router's compose file. It runs on the
  official Node image and uses no packages. The compose file embeds its code as
  base64, so the code is part of what the CVM measures at boot. It is the only
  service, apart from the two TLS ingress containers, that mounts dstack's socket.
- **Router's keys.** Router no longer mounts dstack's socket. `subhost` gives it a
  socket that answers exactly two requests: the two keys Router has always used,
  at the same paths, so Router's TinyCloud identity and record key do not change.
  If either key disagrees with its saved pin, Router starts read-only. Linked authors’ records stay locked and the waiting queue stays on disk (`server/src/tinycloud-identity.ts`).
- **One sub-container** (`probe.mjs` on a pinned Router image, to reuse Router's
  TinyCloud client). Its code hash is the SHA-256 of its spec: image digest,
  command, working directory, settings. It makes a key that exists only in its
  memory and registers the public half with `subhost` over a socket only it can reach.
  It has no dstack access, no privileges and no host network.

## The binding

`GET :8091/bundle?nonce=<64 hex>` returns a TDX quote whose report data is
SHA-512 of `{domain, app_id, name, code_hash, public_key, nonce}`, with the event
log and the measured app-compose file. `POST :8091/use` hands the container a
grant; it reads one file and answers with the size and SHA-256, never the contents.

## The grant check (`server/scripts/subhost-grant.mjs`)

Before any grant, on the grantor's machine:

1. Phala's verifier accepts the TDX signature.
2. Boot measurements (MRTD, RTMR0-2 and the OS image hash) are an approved set
   (`approved.json`, today's values).
3. RTMR3 replays from the event log, and each event matches its digest.
4. The measured compose file is this checkout's `docker-compose.template.yml`
   with only the four deploy values filled in (Router's image versions). So the
   check does not care which Router release is running, and anything else that
   changes the CVM's layout, such as a new socket mount, fails it.
5. The pre-launch script is approved.
6. The report data commits to the approved code hash, the container's key and
   the caller's fresh nonce.

Then it grants that key `tinycloud.kv/get` on one folder for a short time, and
asks the container to read a file. `--revoke` then shows the read failing.

```
cd server
node scripts/subhost-grant.mjs --url https://<app-id>-8091.dstack-pha1-prod9.phala.network --new-owner --revoke
```

`--new-owner` uses a throwaway TinyCloud account. `--check-only` stops before the grant.

## Limits

- Containers share the CVM's kernel, and this uses Docker's ordinary isolation
  (gVisor is used only if the CVM offers it). A Router release that carries a
  kernel exploit could escape its container and reach the socket.
- The OS check pins today's measurements; it does not rebuild Phala's image.
- The TDX signature check trusts Phala's public verifier.
- A TinyCloud delegation still names only a key. The code hash is checked by the
  grantor before granting; TinyCloud does not see it.
- Each Router deploy restarts the CVM, so the container gets a new key and needs
  a new grant.
- Changing any part of the compose template other than Router's image versions
  means the grant check refuses until a grantor approves the new template.

## Trace app runs

Trace requests carry a small app that the owner reads, runs and whose answer they
release or withhold (`docs/attested-trace-apps.md`). The host runs those apps when
the compose file carries a runner spec and a sandbox spec:

- **`trace-runner`** (`runner.mjs` on a pinned Router image). It holds each run's
  key in memory, reads the trace with the owner's 15-minute grant, seals the
  result to the owner and signs it with the run's key, and never runs an app itself. It reaches the host only
  through `runner/host.sock`, to ask for a sandbox, and answers on `runner.sock`.
- **`trace-sandbox`** (`sandbox.mjs`), one container per run, started on the
  runner's request and removed after. No network at all (`NetworkMode: none`), no
  keys, no kept logs, only its own directory. It runs the app in QuickJS compiled
  to WebAssembly, in a worker it kills if the app overruns, answers once and exits.
- **Router** reaches the runner through `router/runs.sock`, in the directory only
  Router mounts: `/prepare` and `/run`. For `/prepare` the host computes the run
  description's hash itself and returns a quote whose report data is SHA-512 of
  `{domain: "teleport-router/trace-run/v1", app_id, name, code_hash, run_hash,
  public_key, nonce}`. `code_hash` covers both specs (`runnersCodeHash`).

The host never sees a trace or an answer: only descriptions, app code, grants and
sealed results pass through it. A bad runner or sandbox spec, or a failure setting
up runs, turns runs off without touching Router's key socket or the probe, and the
runner's supervisor runs beside the probe's rather than after it. Sandboxes left
by an earlier host are removed when the runner starts, and one that Docker would
not remove is retried. Owners check runs with
`server/scripts/trace-app-owner.mjs`, which uses `verifyRunBundle` here and
Phala's verifier before granting anything.

`runner.base.json` and `sandbox.base.json` say PENDING until a Router image that
carries the trace app code exists to pin; until then `embed.mjs` leaves both specs
out and runs stay off. Turning them on: pin that image's digest in both files, run
`node subhost/embed.mjs`, approve the new template, and set `TRACE_APPS=subhost`
on Router.

The apps share the CVM's kernel with Router, as the probe does. The WebAssembly
sandbox and the sandbox container's missing network are what stand between a
stranger's code and that kernel.

Edit `host.mjs`, `probe.mjs`, `runner.mjs`, `sandbox.mjs` or a `*.base.json`, then
run `node subhost/embed.mjs` to update the template.
`node --test subhost/subhost.test.mjs subhost/runs.test.mjs` runs the tests.
