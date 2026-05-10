#!/usr/bin/env bash
# Phase 3 + 4: reproduce the production bug + verify the fix.
#
# Scenario:
#   1. Baseline: bot sends "baseline-ping", user decrypts ok.
#   2. Arm MITM (drop m.room_key from federation /send).
#   3. forceDiscardSession on bot, send "stuck-1": fresh outbound megolm
#      session is created, its m.room_key to-device EDU is dropped by
#      the MITM, m.room.encrypted reaches user but they have no key.
#   4. Send "stuck-2" reusing the same broken session — also undecryptable.
#   5. Disarm MITM (federation now healthy).
#   6. Send "post-restore" reusing the broken session — STILL
#      undecryptable, because matrix-rust-sdk doesn't auto-rotate.
#      THIS REPRODUCES THE PRODUCTION BUG.
#   7. Briefly restart hs-a-core to trigger a sync interruption + recovery.
#   8. Send "after-recovery":
#      - WITHOUT FIX (MATRIX_DISABLE_MEGOLM_AUTOROTATE=1): same broken
#        session, still undecryptable.
#      - WITH FIX: sync-recovery hook fires forceDiscardSession on
#        reconnect → fresh session → m.room_key delivers cleanly → user
#        decrypts.
#
# Run modes:
#   bash run-bug.sh                       → with fix (default)
#   FIX=disabled bash run-bug.sh          → without fix
#
# Asserts:
#   FIX=disabled  exit nonzero unless step 6 stays broken AND step 8 stays broken
#   FIX=enabled   exit nonzero unless step 6 stays broken AND step 8 RECOVERS
set -euo pipefail
cd "$(dirname "$0")/.."

REPRO_DIR="$(pwd)"
SERVER_DIR="$(cd ../../server && pwd)"
FIX="${FIX:-enabled}"

: "${BOT_HANDLE:=repro-bot}"
: "${USER_HANDLE:=repro-user}"
: "${USER_PASS:=repro-user-pw}"
BOT_SECRET="repro-bot-secret"
BOT_PASS=$(node -e "
const c = require('crypto');
process.stdout.write(c.createHmac('sha256','$BOT_SECRET').update('matrix:hs-a').digest('base64url'));
")

eval "$(bash scripts/extract-bootstrap-tokens.sh)"

register_if_needed() {
  local hs="$1" user="$2" password="$3" token="$4"
  local login=$(curl -sS -X POST "$hs/_matrix/client/v3/login" \
    -H 'Content-Type: application/json' \
    -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$user\"},\"password\":\"$password\"}")
  if echo "$login" | grep -q '"access_token"'; then return 0; fi
  local init=$(curl -sS -X POST "$hs/_matrix/client/v3/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$password\"}")
  local session=$(echo "$init" | python3 -c 'import sys,json; print(json.load(sys.stdin).get("session",""))')
  curl -sS -X POST "$hs/_matrix/client/v3/register" \
    -H 'Content-Type: application/json' \
    -d "{\"username\":\"$user\",\"password\":\"$password\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$token\",\"session\":\"$session\"}}" \
    > /dev/null
}

register_if_needed http://localhost:8001 "$BOT_HANDLE"  "$BOT_PASS"  "$HS_A_BOOTSTRAP_TOKEN"
register_if_needed http://localhost:8002 "$USER_HANDLE" "$USER_PASS" "$HS_B_BOOTSTRAP_TOKEN"

TMP=$(mktemp -d)
mkfifo "$TMP/bot.in"
touch "$TMP/bot.replies"

cleanup() {
  echo
  echo "[run-bug] === bot.err (tail) ==="; tail -20 "$TMP/bot.err" 2>/dev/null || true
  echo "[run-bug] === user.out (tail) ==="; tail -20 "$TMP/user.out" 2>/dev/null || true
  echo "[run-bug] === bot.replies (tail) ==="; tail -20 "$TMP/bot.replies" 2>/dev/null || true
  echo "[run-bug] === mitm log (tail) ==="
  docker compose -f "$REPRO_DIR/docker-compose.yml" logs hs-b 2>/dev/null | grep -i mitm | tail -10 || true
  rm -rf "$TMP"
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup EXIT

# Helper: arm/disarm the MITM by recreating the hs-b service with a
# different MITM_DROP_TYPES env. Pass "" to disarm.
set_mitm_drop() {
  local types="$1"
  pushd "$REPRO_DIR" > /dev/null
  MITM_DROP_TYPES="$types" MITM_LOG_BODIES=1 docker compose up -d --force-recreate hs-b > /dev/null 2>&1
  popd > /dev/null
  # Wait for the proxy to be ready
  for i in $(seq 1 30); do
    if docker compose -f "$REPRO_DIR/docker-compose.yml" logs hs-b 2>&1 | tail -5 | grep -q '"event":"listening"'; then
      sleep 1
      break
    fi
    sleep 0.5
  done
}

start_user_inline() {
  # Cannot use $() to capture pid: the captured stdout would block the
  # caller until the bot's exec replaces stdout. So callers must use
  # USER_PID=$! immediately after.
  FED_REPRO_HS_B_URL=http://localhost:8002 \
  FED_REPRO_USER="$USER_HANDLE" \
  FED_REPRO_USER_PASS="$USER_PASS" \
  FED_REPRO_TOKEN="$HS_B_BOOTSTRAP_TOKEN" \
  FED_REPRO_USER_STORE="$TMP/user-store" \
  python3 repro/user.py > "$TMP/user.out" 2> "$TMP/user.err" &
}

start_bot_inline() {
  (
    cd "$SERVER_DIR"
    [ "$FIX" = "disabled" ] && export MATRIX_DISABLE_MEGOLM_AUTOROTATE=1
    export FED_REPRO_HS_A_URL=http://localhost:8001
    export FED_REPRO_HS_A_NAME=hs-a
    export FED_REPRO_TOKEN="$HS_A_BOOTSTRAP_TOKEN"
    export FED_REPRO_BOT_HANDLE="$BOT_HANDLE"
    export FED_REPRO_BOT_SECRET="$BOT_SECRET"
    export FED_REPRO_BOT_REPLY_FILE="$TMP/bot.replies"
    export MATRIX_CRYPTO_SNAPSHOT_PATH="$TMP/bot-snap.json"
    export MATRIX_CREDS_PATH="$TMP/bot-creds.json"
    export MATRIX_MEGOLM_ROTATION_INTERVAL_MS=0
    exec npx tsx "$REPRO_DIR/repro/bot.ts" < "$TMP/bot.in" > "$TMP/bot.out" 2> "$TMP/bot.err"
  ) &
}

read_until() {
  local file="$1" pattern="$2" timeout="${3:-30}"
  local start=$(date +%s)
  while true; do
    if grep -qE "$pattern" "$file" 2>/dev/null; then return 0; fi
    if [ $(( $(date +%s) - start )) -ge "$timeout" ]; then return 1; fi
    sleep 0.5
  done
}

count_decrypt_ok_with_body() {
  grep -c "\"event\": \"decrypt_ok\".*\"body\": \"$1\"" "$TMP/user.out" || true
}

count_decrypt_fail() {
  grep -c '"event": "decrypt_fail"' "$TMP/user.out" || true
}

echo "[run-bug] FIX=$FIX"
echo "[run-bug] disarming MITM (pass-through)"
set_mitm_drop ""

start_user_inline; USER_PID=$!
start_bot_inline;  BOT_PID=$!
echo "[run-bug] USER_PID=$USER_PID  BOT_PID=$BOT_PID  TMP=$TMP"
# Open the bot's stdin FIFO so its exec unblocks.
exec 7> "$TMP/bot.in"
echo "[run-bug] bot.in fd 7 opened"

read_until "$TMP/bot.replies" '"started":true'      90 || { echo "bot did not start"; exit 1; }
read_until "$TMP/user.out"    '"event": "ready"'    30 || { echo "user did not ready"; exit 1; }

echo "[run-bug] step 1: baseline"
echo '{"cmd":"create-room","name":"bug-repro"}' >&7
read_until "$TMP/bot.replies" '"room_id"' 30 || exit 1
ROOM_ID=$(grep -o '"room_id":"[^"]*"' "$TMP/bot.replies" | tail -1 | cut -d'"' -f4)
echo "  room: $ROOM_ID"
echo "{\"cmd\":\"invite\",\"user\":\"@${USER_HANDLE}:hs-b\"}" >&7
read_until "$TMP/user.out" '"event": "joined"' 30 || exit 1
echo '{"cmd":"send","text":"baseline-ping"}' >&7
read_until "$TMP/user.out" '"body": "baseline-ping"' 30 || { echo "  ✗ baseline failed"; exit 1; }
echo "  ✓ baseline decrypt_ok"

echo "[run-bug] step 2: arm MITM (drop all to-device — m.room_key is olm-wrapped inside)"
# matrix-rust-sdk encrypts m.room_key via olm into m.room.encrypted
# to-device messages, wrapped in m.direct_to_device EDUs. We can't
# selectively drop "the m.room_key for THIS session" without decrypting
# olm, so we drop ALL to-device traffic to simulate the production
# federation-queue-backoff window. matches the matrix.org → mtrx
# scenario from 2026-05-09 where the per-server queue backed off so
# hard that everything queued during the window failed to deliver.
set_mitm_drop "m.direct_to_device"

echo "[run-bug] step 3: bot rotates session, sends stuck-1"
echo '{"cmd":"rotate"}' >&7
read_until "$TMP/bot.replies" '"rotated"' 10
echo '{"cmd":"send","text":"stuck-1"}' >&7
sleep 8
STUCK1=$(count_decrypt_ok_with_body "stuck-1")
if [ "$STUCK1" -eq 0 ]; then
  echo "  ✓ stuck-1 NOT decrypted (m.room_key was dropped by MITM)"
else
  echo "  ✗ stuck-1 was decrypted unexpectedly — MITM may not be filtering"; exit 1
fi

echo "[run-bug] step 4: send stuck-2 (same broken session)"
echo '{"cmd":"send","text":"stuck-2"}' >&7
sleep 4
STUCK2=$(count_decrypt_ok_with_body "stuck-2")
if [ "$STUCK2" -eq 0 ]; then echo "  ✓ stuck-2 also undecryptable"; else echo "  ✗ stuck-2 decrypted"; exit 1; fi

if [ "${KEEP_ARMED:-0}" = "1" ]; then
  echo "[run-bug] step 5: KEEP_ARMED=1 — MITM stays armed (worst-case: federation never recovers for this device)"
else
  echo "[run-bug] step 5: disarm MITM (federation healthy again)"
  set_mitm_drop ""
fi
sleep 3

echo "[run-bug] step 6: send post-restore (still using broken session)"
echo '{"cmd":"send","text":"post-restore"}' >&7
sleep 6
POST=$(count_decrypt_ok_with_body "post-restore")
if [ "$POST" -eq 0 ]; then
  echo "  ✓ BUG REPRODUCED — post-restore still undecryptable on the broken session"
else
  echo "  ✗ post-restore decrypted — bug did not reproduce (matrix-rust-sdk auto-recovered, or test setup wrong)"
  exit 1
fi

echo "[run-bug] step 7: simulate sync interruption (restart hs-a-core)"
docker compose -f "$REPRO_DIR/docker-compose.yml" restart hs-a-core > /dev/null 2>&1
echo "  hs-a-core restarted; waiting for bot sync to recover..."
sleep 15

echo "[run-bug] step 8: send after-recovery"
echo '{"cmd":"send","text":"after-recovery"}' >&7
sleep 8
AFTER=$(count_decrypt_ok_with_body "after-recovery")

if [ "$FIX" = "disabled" ]; then
  if [ "$AFTER" -eq 0 ]; then
    echo "  ✓ FIX_DISABLED: after-recovery undecryptable (no auto-rotation, same broken session)"
    echo
    echo "[run-bug] ✅ WITHOUT FIX: bug confirmed — outbound session stays broken across sync recovery"
  else
    echo "  ✗ FIX_DISABLED: after-recovery decrypted unexpectedly (didn't expect recovery without the patch)"
    exit 1
  fi
else
  if [ "$AFTER" -gt 0 ]; then
    echo "  ✓ WITH FIX: after-recovery decrypted (sync-recovery hook rotated, fresh session, m.room_key delivered)"
    echo
    echo "[run-bug] ✅ WITH FIX: rotation patch unwedges the room on sync recovery"
  else
    echo "  ✗ WITH FIX: after-recovery still undecryptable — patch didn't fire or didn't help"
    exit 1
  fi
fi

echo '{"cmd":"exit"}' >&7
wait $BOT_PID 2>/dev/null || true
kill $USER_PID 2>/dev/null || true
wait 2>/dev/null || true
