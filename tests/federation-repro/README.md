# Federation repro harness — megolm rotation bug

Reproduces the silent-decrypt-failure bug Router exhibits when a federation
hiccup drops the `m.room_key` to-device EDU that distributes a freshly-created
outbound megolm session.

## Status

- [x] Phase 1 — two continuwuity HSes federate locally over TLS (this commit)
- [ ] Phase 2 — bot on hs-a + user on hs-b complete an encrypted-room baseline
- [ ] Phase 3 — federation interruption simulation (drop m.room_key in flight)
- [ ] Phase 4 — assert bug without fix, recovery with fix

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
