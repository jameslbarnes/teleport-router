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
BRIDGE_CONTAINER="${BRIDGE_CONTAINER:-dstack-shape-matrix-bridge-1}"

metadata_file="$(mktemp)"
containers_file="$(mktemp)"
status_file="$(mktemp)"
router_health_file="$(mktemp)"
hermes_health_file="$(mktemp)"
bridge_log_file="$(mktemp)"
bridge_err_file="$(mktemp)"
trap 'rm -f "$metadata_file" "$containers_file" "$status_file" "$router_health_file" "$hermes_health_file" "$bridge_log_file" "$bridge_err_file"' EXIT

# The TEE's own report on port 8090 is the first choice. Phala closed public 8090
# on CVMs still running unpatched OS images after the October 2026 guest-agent
# incident, so fall back to Phala's authenticated attestation API.
fetch_metadata() {
  if curl -fsS --max-time 30 "https://${TEE_HOST}/" >"$metadata_file" 2>/dev/null; then
    metadata_source="public"
    return 0
  fi
  if phala api "/cvms/${PHALA_APP_ID}/attestation" >"$metadata_file" 2>/dev/null; then
    metadata_source="api"
    return 0
  fi
  return 1
}

# Container status comes with the public report; otherwise ask Phala's API.
fetch_containers() {
  if [ "$metadata_source" = "public" ]; then
    cp "$metadata_file" "$containers_file"
    return 0
  fi
  phala api "/cvms/${PHALA_APP_ID}/composition" >"$containers_file" 2>/dev/null
}

# Bridge logs are read with the API key, because public logs are off. The CLI's
# error (never log content) is kept so a failure can be explained.
fetch_bridge_logs() {
  phala logs "$BRIDGE_CONTAINER" --cvm-id "$PHALA_APP_ID" -n "${BRIDGE_LOG_TAIL:-1000}" -t >"$bridge_log_file" 2>"$bridge_err_file" ||
    phala logs shape-matrix-bridge --cvm-id "$PHALA_APP_ID" -n "${BRIDGE_LOG_TAIL:-1000}" -t >"$bridge_log_file" 2>>"$bridge_err_file"
}

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
  metadata_source=""

  if fetch_metadata; then
    echo "TEE metadata source: ${metadata_source}"
    if grep -Fq "GIT_SHA=${EXPECTED_GIT_SHA}" "$metadata_file" &&
      grep -Fq "${EXPECTED_IMAGE_DIGEST}" "$metadata_file" &&
      grep -Fq "${EXPECTED_AGENT_IMAGE_DIGEST}" "$metadata_file"; then
      metadata_ok=1
      echo "TEE metadata contains expected git SHA and image digests"
    else
      echo "TEE metadata does not yet contain the expected git SHA/image digests"
    fi

    if fetch_containers; then
      if grep -Eiq 'Exited \(|"(state|status)" *: *"exited"' "$containers_file"; then
        echo "At least one container has exited"
      else
        containers_ok=1
        echo "No exited containers"
      fi
    else
      echo "Container status is not reachable yet"
    fi

    if grep -q "shape-matrix-bridge" "$containers_file"; then
      bridge_ok=0
      bridge_uptime=""
      if [ "$metadata_source" = "public" ]; then
        bridge_uptime="$(
          awk -v name="$BRIDGE_CONTAINER" '
            index($0, name) {
              getline
              gsub(/<[^>]+>/, "")
              gsub(/^[[:space:]]+|[[:space:]]+$/, "")
              print
              exit
            }
          ' "$containers_file"
        )"
      fi

      if [[ "$bridge_uptime" == "Up Less than"* ]]; then
        echo "Shape Matrix bridge is still too fresh/restarting: ${bridge_uptime}"
      elif fetch_bridge_logs; then
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
        # With public logs off, the CLI may not reach them. The Shape Matrix
        # smoke step that follows tests the bridge end to end instead.
        bridge_ok=1
        echo "Warning: Shape Matrix bridge logs are not readable ($(head -n1 "$bridge_err_file" | cut -c1-160)); relying on the smoke test"
      fi
    fi
  else
    echo "TEE metadata is not reachable yet (public report and attestation API)"
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
    echo "Deployment verified (TEE metadata from ${metadata_source})"
    exit 0
  fi

  sleep "$POLL_SECONDS"
done

echo "Deployment verification timed out after ${VERIFY_TIMEOUT_SECONDS}s"
echo "Last Phala status:"
cat "$status_file" || true
exit 1
