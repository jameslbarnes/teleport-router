#!/usr/bin/env bash
set -euo pipefail

: "${PHALA_APP_ID:?PHALA_APP_ID is required}"
: "${EXPECTED_GIT_SHA:?EXPECTED_GIT_SHA is required}"
: "${EXPECTED_IMAGE_DIGEST:?EXPECTED_IMAGE_DIGEST is required}"
: "${EXPECTED_AGENT_IMAGE_DIGEST:?EXPECTED_AGENT_IMAGE_DIGEST is required}"

TEE_HOST="${TEE_HOST:-${PHALA_APP_ID}-8090.dstack-pha-prod9.phala.network}"
ROUTER_HEALTH_URL="${ROUTER_HEALTH_URL:-https://router.teleport.computer/health}"
HERMES_HEALTH_URL="${HERMES_HEALTH_URL:-https://hermes.teleport.computer/health}"
VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-900}"
POLL_SECONDS="${POLL_SECONDS:-15}"

metadata_file="$(mktemp)"
status_file="$(mktemp)"
router_health_file="$(mktemp)"
hermes_health_file="$(mktemp)"
bridge_log_file="$(mktemp)"
trap 'rm -f "$metadata_file" "$status_file" "$router_health_file" "$hermes_health_file" "$bridge_log_file"' EXIT

deadline=$((SECONDS + VERIFY_TIMEOUT_SECONDS))
attempt=0

while [ "$SECONDS" -lt "$deadline" ]; do
  attempt=$((attempt + 1))
  echo "Deployment verification attempt ${attempt}"

  if phala api "/cvms/${PHALA_APP_ID}" \
    -q '{status,in_progress,progress,updated_at,app_url}' >"$status_file"; then
    cat "$status_file"
  else
    echo "Warning: could not read Phala CVM status yet"
  fi

  metadata_ok=0
  containers_ok=0
  bridge_ok=1
  health_ok=0

  if curl -fsS --max-time 30 "https://${TEE_HOST}/" >"$metadata_file"; then
    if grep -Fq "GIT_SHA=${EXPECTED_GIT_SHA}" "$metadata_file" &&
      grep -Fq "${EXPECTED_IMAGE_DIGEST}" "$metadata_file" &&
      grep -Fq "${EXPECTED_AGENT_IMAGE_DIGEST}" "$metadata_file"; then
      metadata_ok=1
      echo "TEE metadata contains expected git SHA and image digests"
    else
      echo "TEE metadata does not yet contain the expected git SHA/image digests"
    fi

    if grep -q "Exited (" "$metadata_file"; then
      echo "TEE metadata still reports at least one exited container"
    else
      containers_ok=1
      echo "TEE metadata reports no exited containers"
    fi

    if grep -q "shape-matrix-bridge" "$metadata_file"; then
      bridge_ok=0
      bridge_uptime="$(
        awk '
          /dstack-shape-matrix-bridge-1/ {
            getline
            gsub(/<[^>]+>/, "")
            gsub(/^[[:space:]]+|[[:space:]]+$/, "")
            print
            exit
          }
        ' "$metadata_file"
      )"

      if [ -z "$bridge_uptime" ]; then
        echo "Shape Matrix bridge container is not listed in TEE metadata yet"
      elif [[ "$bridge_uptime" == "Up Less than"* ]]; then
        echo "Shape Matrix bridge is still too fresh/restarting: ${bridge_uptime}"
      elif curl -fsS --max-time 20 "https://${TEE_HOST}/logs/dstack-shape-matrix-bridge-1?text&bare&timestamps&tail=${BRIDGE_LOG_TAIL:-1000}" >"$bridge_log_file"; then
        auth_failure_line="$(
          grep -En 'Error: .* is required|Matrix auth failed|Matrix access token whoami failed|Signup wrapper failed|Registration failed' "$bridge_log_file" |
            tail -n1 |
            cut -d: -f1 || true
        )"
        private_auth_line="$(
          grep -Fn "[shape-matrix-bridge] Private Router auth OK" "$bridge_log_file" |
            tail -n1 |
            cut -d: -f1 || true
        )"
        matrix_sync_line="$(
          grep -Fn "[Matrix] Initial sync complete" "$bridge_log_file" |
            tail -n1 |
            cut -d: -f1 || true
        )"
        auth_failure_line="${auth_failure_line:-0}"
        private_auth_line="${private_auth_line:-0}"
        matrix_sync_line="${matrix_sync_line:-0}"

        if [ "$auth_failure_line" -gt "$private_auth_line" ] || [ "$auth_failure_line" -gt "$matrix_sync_line" ]; then
          echo "Shape Matrix bridge logs contain a startup/auth failure after the latest readiness signal"
        elif [ "$private_auth_line" -gt 0 ] && [ "$matrix_sync_line" -gt 0 ]; then
          bridge_ok=1
          echo "Shape Matrix bridge authenticated to private Router and completed Matrix sync"
        else
          echo "Shape Matrix bridge logs do not yet show private Router auth and Matrix initial sync"
        fi
      else
        echo "Shape Matrix bridge logs are not reachable yet"
      fi
    fi
  else
    echo "TEE metadata endpoint is not reachable yet"
  fi

  if curl -fsS --max-time 20 "$ROUTER_HEALTH_URL" >"$router_health_file" &&
    curl -fsS --max-time 20 "$HERMES_HEALTH_URL" >"$hermes_health_file" &&
    grep -Fq '"status":"ok"' "$router_health_file" &&
    grep -Fq '"status":"ok"' "$hermes_health_file"; then
    health_ok=1
    echo "Public health endpoints are healthy"
  else
    echo "Public health endpoints are not healthy yet"
  fi

  if [ "$metadata_ok" -eq 1 ] && [ "$containers_ok" -eq 1 ] && [ "$bridge_ok" -eq 1 ] && [ "$health_ok" -eq 1 ]; then
    echo "Deployment verified"
    exit 0
  fi

  sleep "$POLL_SECONDS"
done

echo "Deployment verification timed out after ${VERIFY_TIMEOUT_SECONDS}s"
echo "Last Phala status:"
cat "$status_file" || true
exit 1
