#!/usr/bin/env bash
# Generate a shared CA + per-homeserver TLS certs so two continuwuity
# instances can federate over HTTPS on a docker bridge network. Both HSes
# trust the same CA, so federation handshakes succeed without going
# through Let's Encrypt or a public DNS chain.
set -euo pipefail
cd "$(dirname "$0")/../certs"

# Idempotent: only regenerate if missing.
[ -f ca.pem ] && [ -f hs-a.crt ] && [ -f hs-b.crt ] && {
  echo "[gen-certs] already present, skipping"
  exit 0
}

echo "[gen-certs] creating CA"
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout ca.key -out ca.pem -subj "/CN=fed-repro-ca"

for h in hs-a hs-b; do
  echo "[gen-certs] $h"
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$h.key" -out "$h.csr" -subj "/CN=$h"
  cat > "$h.cnf" <<EOF
subjectAltName = DNS:$h, DNS:$h.fedrepro.test, DNS:localhost, IP:127.0.0.1
extendedKeyUsage = serverAuth
EOF
  openssl x509 -req -in "$h.csr" \
    -CA ca.pem -CAkey ca.key -CAcreateserial \
    -out "$h.crt" -days 365 \
    -extfile "$h.cnf"
  rm "$h.csr" "$h.cnf"
done
rm -f ca.srl

echo "[gen-certs] done"
ls -la
