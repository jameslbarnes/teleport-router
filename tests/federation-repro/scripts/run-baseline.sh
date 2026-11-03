#!/usr/bin/env bash
# Phase 2: federated encrypted-room baseline.
#
# Steps:
#   1. Bring up hs-a, hs-b and their TLS proxies (assumed already up)
#   2. Extract bootstrap tokens, register bot on hs-a + user on hs-b
#   3. Spawn bot.ts (matrix-js-sdk + rust crypto), spawn user.py (matrix-nio)
#   4. Bot creates encrypted room, invites @user:hs-b
#   5. User auto-accepts invite
#   6. Bot sends "baseline ping"
#   7. Assert user.py emits decrypt_ok with body "baseline ping"
#   8. Tear down processes
#
# Exits 0 on baseline success.

set -euo pipefail
cd "$(dirname "$0")/.."

REPRO_DIR="$(pwd)"
SERVER_DIR="$(cd ../../server && pwd)"

: "${BOT_HANDLE:=repro-bot}"
: "${USER_HANDLE:=repro-user}"
: "${USER_PASS:=repro-user-pw}"

echo "[run-baseline] extracting bootstrap tokens"
eval "$(bash scripts/extract-bootstrap-tokens.sh)"
echo "  hs-a bootstrap: $HS_A_BOOTSTRAP_TOKEN"
echo "  hs-b bootstrap: $HS_B_BOOTSTRAP_TOKEN"

# Derive the bot password the same way MatrixPlatform.start() does, so its
# subsequent login succeeds.
BOT_SECRET="repro-bot-secret"
BOT_PASS=$(node -e "
const c = require('crypto');
process.stdout.write(c.createHmac('sha256','$BOT_SECRET').update('matrix:hs-a').digest('base64url'));
")

register_if_needed() {
  local label="$1" hs="$2" user="$3" password="$4" token="$5"
  local login=$(curl -sS -X POST "$hs/_matrix/client/v3/login" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$password\"}")
  if echo "$login" | grep -q '"access_token"'; then
    echo "  $label: $user already exists (login OK)"
    return 0
  fi
  local init=$(curl -sS -X POST "$hs/_matrix/client/v3/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$password\"}")
  local session=$(echo "$init" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session",""))')
  local resp=$(curl -sS -X POST "$hs/_matrix/client/v3/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$password\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$token\",\"session\":\"$session\"}}")
  if echo "$resp" | grep -q '"user_id"'; then
    echo "  $label: $user registered"
    return 0
  fi
  if echo "$resp" | grep -q M_USER_IN_USE; then
    echo "  $label: $user already exists (M_USER_IN_USE)"
    return 0
  fi
  echo "[run-baseline] $label register failed: $resp" >&2
  return 1
}

register_if_needed "bot"  http://localhost:8001 "$BOT_HANDLE"  "$BOT_PASS"  "$HS_A_BOOTSTRAP_TOKEN" || exit 1
register_if_needed "user" http://localhost:8002 "$USER_HANDLE" "$USER_PASS" "$HS_B_BOOTSTRAP_TOKEN" || exit 1

# Output FIFOs for sync between the two scripts.
TMP=$(mktemp -d)
cleanup() {
  echo
  echo "=== bot.err (tail) ==="; tail -40 "$TMP/bot.err" 2>/dev/null || true
  echo "=== bot.out (tail) ==="; tail -20 "$TMP/bot.out" 2>/dev/null || true
  echo "=== user.err (tail) ==="; tail -40 "$TMP/user.err" 2>/dev/null || true
  echo "=== user.out (tail) ==="; tail -20 "$TMP/user.out" 2>/dev/null || true
  rm -rf "$TMP"
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

mkfifo "$TMP/bot.in"
touch "$TMP/bot.replies" "$TMP/user.out"

echo "[run-baseline] starting user.py (background)"
FED_REPRO_HS_B_URL=http://localhost:8002 \
FED_REPRO_USER="$USER_HANDLE" \
FED_REPRO_USER_PASS="$USER_PASS" \
FED_REPRO_TOKEN="$HS_B_BOOTSTRAP_TOKEN" \
FED_REPRO_USER_STORE="$TMP/user-store" \
python3 repro/user.py > "$TMP/user.out" 2>"$TMP/user.err" &
USER_PID=$!

echo "[run-baseline] starting bot.ts (background)"
(
  cd "$SERVER_DIR"
  FED_REPRO_HS_A_URL=http://localhost:8001 \
  FED_REPRO_HS_A_NAME=hs-a \
  FED_REPRO_TOKEN="$HS_A_BOOTSTRAP_TOKEN" \
  FED_REPRO_BOT_HANDLE="$BOT_HANDLE" \
  FED_REPRO_BOT_SECRET="$BOT_SECRET" \
  FED_REPRO_BOT_REPLY_FILE="$TMP/bot.replies" \
  MATRIX_CRYPTO_SNAPSHOT_PATH="$TMP/bot-snap.json" \
  MATRIX_CREDS_PATH="$TMP/bot-creds.json" \
  npx tsx "$REPRO_DIR/repro/bot.ts" < "$TMP/bot.in" > "$TMP/bot.out" 2>"$TMP/bot.err"
) &
BOT_PID=$!

# Open the bot's stdin FIFO for write
exec 7> "$TMP/bot.in"

read_until() {
  local file="$1" pattern="$2" timeout="${3:-30}"
  local start=$(date +%s)
  while true; do
    if grep -q "$pattern" "$file" 2>/dev/null; then return 0; fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then return 1; fi
    sleep 0.5
  done
}

echo "[run-baseline] waiting for bot to start..."
read_until "$TMP/bot.replies" '"started":true' 60 || { echo "bot failed to start"; cat "$TMP/bot.err"; exit 1; }

echo "[run-baseline] waiting for user.py ready..."
read_until "$TMP/user.out" '"event": "ready"' 30 || { echo "user failed to ready"; cat "$TMP/user.err"; exit 1; }

echo "[run-baseline] bot creates encrypted room"
echo '{"cmd":"create-room","name":"phase2-baseline"}' >&7
read_until "$TMP/bot.replies" '"room_id"' 30 || { echo "bot create-room timeout"; exit 1; }
ROOM_ID=$(grep -o '"room_id":"[^"]*"' "$TMP/bot.replies" | tail -1 | cut -d'"' -f4)
echo "  room: $ROOM_ID"

echo "[run-baseline] bot invites @${USER_HANDLE}:hs-b"
echo "{\"cmd\":\"invite\",\"user\":\"@${USER_HANDLE}:hs-b\"}" >&7
sleep 2  # give federation a moment to deliver the invite

echo "[run-baseline] waiting for user to auto-accept and join"
read_until "$TMP/user.out" '"event": "joined"' 30 || { echo "user did not join"; cat "$TMP/user.err"; exit 1; }

echo "[run-baseline] bot sends 'baseline ping'"
echo '{"cmd":"send","text":"baseline ping"}' >&7
sleep 1

echo "[run-baseline] waiting for user to receive + decrypt"
read_until "$TMP/user.out" 'decrypt_ok.*baseline ping' 30 \
  || { echo "user did not decrypt 'baseline ping'"; tail -30 "$TMP/user.out"; exit 1; }

echo
echo "[run-baseline] ✅ BASELINE PASSED — federated encrypted round-trip works"
echo
echo '{"cmd":"exit"}' >&7
wait $BOT_PID 2>/dev/null || true
kill $USER_PID 2>/dev/null || true
wait 2>/dev/null || true
