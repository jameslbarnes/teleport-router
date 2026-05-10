# Federation repro harness — megolm rotation bug

Reproduces the silent-decrypt-failure bug Router exhibits when a federation
hiccup drops the `m.room_key` to-device EDU that distributes a freshly-created
outbound megolm session.

## Status

- [x] Phase 1 — two continuwuity HSes federate locally over TLS (this commit)
- [ ] Phase 2 — bot on hs-a + user on hs-b complete an encrypted-room baseline
- [ ] Phase 3 — federation interruption simulation (drop m.room_key in flight)
- [ ] Phase 4 — assert bug without fix, recovery with fix

## Phase 2 plan (next commit)

Goal: prove federation-side crypto round-trip works when nothing is broken.
Without this baseline, phase 3's "we broke it" assertion is meaningless.

- `tests/federation-repro/repro/bot.ts` — uses `MatrixPlatform` from
  `server/src/platform/matrix.ts` pointed at `http://localhost:8001`.
  Registers fresh on hs-a with the `fedrepro` token, joins/creates an
  encrypted room, exposes a small CLI surface for the test driver.
- `tests/federation-repro/repro/user.py` — uses `matrix-nio` (or `mautrix`)
  pointed at `http://localhost:8002`. Registers on hs-b, accepts the
  invite from the bot's room, syncs, prints decrypted message bodies.
- `tests/federation-repro/repro/run-baseline.sh` — orchestrates: start
  bot, register user, send invite, accept, send "baseline ping", verify
  user.py prints the decrypted ping.

Commit gate: a clean "baseline ping → received as decrypted text"
round-trip across the federation, repeatable from `make baseline` (or
similar entry point).

## Phase 3 plan

Goal: simulate "m.room_key for a freshly-created outbound megolm session
got dropped in transit," matching the production failure mode.

- Insert a small HTTP MITM (e.g. a Node script using `http-mitm-proxy`
  or a stripped-down `mitmproxy` script) on the federation path between
  hs-a-proxy and hs-b. Configure hs-a-core's outbound federation to
  route through it (probably via docker network alias rebind so the
  proxy intercepts hs-a → hs-b traffic).
- Add a kill-switch: when armed, the MITM drops POST
  `/_matrix/federation/v1/send/{txnId}` requests whose body contains
  `"m.room_key"` to-device events. (Specifically: filter the EDUs
  inside `edus[]`, drop only the to-device ones for the test recipient,
  pass the rest through. So sync still works, only the key share is
  dropped.)
- Test driver: arm the MITM, force a session rotation on the bot
  (`forceDiscardSession()` then send), un-arm. Verify the m.room_key
  for that session never reached hs-b's queue.

## Phase 4 plan

Goal: prove the rotation patch unwedges things.

- Without the patch (a separate compiled artifact, e.g. a flag-gated
  "noop installMegolmAutoRotation"): after phase 3, every subsequent
  bot send is undecryptable for the user, indefinitely.
- With the patch: trigger a sync interruption (briefly stop hs-a-core,
  restart). On reconnect, the rotation hook fires, the bot's next
  message uses a fresh outbound session, and the m.room_key for that
  session delivers cleanly (federation healthy now). User decrypts.
- The test asserts: undecryptable count before fix > 0,
  undecryptable count after fix === 0 (modulo the exact stuck batch).

## Topology

```
peer query hs-a:8448 ──TLS──▶ hs-a (nginx) ──HTTP──▶ hs-a-core (continuwuity :6167)
peer query hs-b:8448 ──TLS──▶ hs-b (nginx) ──HTTP──▶ hs-b-core (continuwuity :6167)
```

Both HSes trust a shared self-signed CA generated under `certs/` so federation
TLS handshakes succeed without going through public DNS / Let's Encrypt.

## Use

```bash
# 1. generate the shared CA + per-HS certs (idempotent; skips if present)
bash scripts/gen-certs.sh

# 2. bring up both homeservers + their TLS proxies
docker compose up -d hs-a-core hs-b-core hs-a hs-b

# 3. sanity check
curl -fsS http://localhost:8001/_matrix/client/versions | head -c 80
curl -fsS http://localhost:8002/_matrix/client/versions | head -c 80

# 4. cross-HS federation check (curlimages/curl on the fednet bridge)
docker run --rm --network federation-repro_fednet \
  -v "$(pwd)/certs:/certs:ro" curlimages/curl \
  --cacert /certs/ca.pem -fsS https://hs-b:8448/_matrix/federation/v1/version

# 5. tear down (also drops volumes)
docker compose down -v
```

## Notes

- continuwuity 0.5.8 is built without `direct_tls`, so each HS sits behind an
  nginx TLS proxy. The proxy listens on port 8448 (federation default) and
  forwards `/_matrix/` traffic to conduwuit's plain-HTTP port. Each HS also
  serves a `.well-known/matrix/server` from the proxy.
- `SSL_CERT_FILE=/certs/ca.pem` is set on the conduwuit containers so their
  outbound federation client trusts the test CA when verifying peer certs.
- The peers' federation hostname (`hs-a`, `hs-b`) is just the docker network
  alias of the proxy. No DNS dance needed inside `fednet`.
