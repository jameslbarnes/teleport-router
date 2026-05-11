#!/usr/bin/env bash
# Continuwuity 0.5.x prints a one-time bootstrap registration token on
# first boot and refuses to honor CONDUWUIT_REGISTRATION_TOKEN until at
# least one account is created using that bootstrap token. Extract both
# HSes' tokens from compose logs so the runner can pre-register the
# bot+user accounts.
set -euo pipefail
cd "$(dirname "$0")/.."

# Wait for both HSes to print their welcome banner (token included).
for hs in hs-a-core hs-b-core; do
  for i in $(seq 1 60); do
    if docker compose logs "$hs" 2>/dev/null | grep -q 'registration token'; then break; fi
    sleep 1
  done
done

extract() {
  docker compose logs "$1" 2>/dev/null \
    | sed -E 's/\x1b\[[0-9;]*m//g' \
    | grep -oE 'registration token [A-Za-z0-9]+' \
    | head -n1 \
    | awk '{print $NF}'
}

A=$(extract hs-a-core)
B=$(extract hs-b-core)
[ -n "$A" ] || { echo "[bootstrap] hs-a-core token not found in logs" >&2; exit 1; }
[ -n "$B" ] || { echo "[bootstrap] hs-b-core token not found in logs" >&2; exit 1; }

cat <<EOF
HS_A_BOOTSTRAP_TOKEN=$A
HS_B_BOOTSTRAP_TOKEN=$B
EOF
