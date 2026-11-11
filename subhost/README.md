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
  Router refuses to start if its identity changes (`server/src/tinycloud-identity.ts`).
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
node scripts/subhost-grant.mjs --url https://<app-id>-8091.dstack-pha-prod9.phala.network --new-owner --revoke
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

Edit `host.mjs`, `probe.mjs` or `probe.base.json`, then run `node subhost/embed.mjs`
to update the template. `node --test subhost/subhost.test.mjs` runs the tests.
