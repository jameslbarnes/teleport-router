#!/usr/bin/env bash
# Archive the TEE's attestation evidence into evidences/<date>/ for the repo.
# Prefers the TEE's own public report on port 8090. Phala closed public 8090 on
# CVMs still running unpatched OS images after the October 2026 guest-agent
# incident, so fall back to Phala's authenticated attestation API.
set -euo pipefail

: "${PHALA_APP_ID:?PHALA_APP_ID is required}"

TEE_HOST="${TEE_HOST:-${PHALA_APP_ID}-8090.dstack-pha-prod9.phala.network}"
DATE=$(date -u +%Y-%m-%d)
DIR="evidences/$DATE"
mkdir -p "$DIR"

SECRET_ENV_RE='(ANTHROPIC_API_KEY|SENDGRID_API_KEY|FIREBASE_SERVICE_ACCOUNT_BASE64|FIRECRAWL_API_KEY|CLOUDFLARE_API_TOKEN|TELEGRAM_BOT_TOKEN|TELEGRAM_BOT_SECRET_KEY|ROUTER_SECRET_KEY|HERMES_SECRET_KEY|HERMES_AGENT_SECRET_KEY|SHAPE_ROUTER_SECRET_KEY|SHAPE_MATRIX_AGENT_SECRET|SHAPE_MATRIX_SERVICE_KEY|MATRIX_SERVER_URL|MATRIX_HOMESERVER|MATRIX_SERVER_NAME|MATRIX_BOT_SECRET_KEY|MATRIX_ACCESS_TOKEN|MATRIX_USER_ID|MATRIX_DEVICE_ID|MATRIX_CRYPTO_SECRET|MATRIX_BOT_HANDLE|MATRIX_SPACE_ROOM_ID|MATRIX_REGISTRATION_TOKEN|MATRIX_SIGNUP_URL|GITHUB_TOKEN|GH_TOKEN)'

# Redact secret values before anything is committed to the public repo.
redact() {
  sed -E \
    -e "s/(${SECRET_ENV_RE}=)[^\",\\\\[:space:]]*/\\1[REDACTED]/g" \
    -e "s/(\"${SECRET_ENV_RE}\"[[:space:]]*:[[:space:]]*\")[^\"]*/\\1[REDACTED]/g" \
    -e "s/(\\\\\"${SECRET_ENV_RE}\\\\\"[[:space:]]*:[[:space:]]*\\\\\")[^\\\\\"]*/\\1[REDACTED]/g" \
    -e "s/(&#34;${SECRET_ENV_RE}&#34;[[:space:]]*:[[:space:]]*&#34;)[^&]*/\\1[REDACTED]/g" \
    "$1" >"$2"
}

source_used="none"
if curl -sf --max-time 30 "https://$TEE_HOST/" -o "$DIR/metadata-raw.json"; then
  redact "$DIR/metadata-raw.json" "$DIR/metadata.json"
  rm "$DIR/metadata-raw.json"
  curl -sf --max-time 30 "https://$TEE_HOST/quote" -o "$DIR/quote.json" || echo "Warning: could not fetch quote"
  source_used="public 8090 report"
elif phala api "/cvms/${PHALA_APP_ID}/attestation" >"$DIR/attestation-raw.json" 2>/dev/null; then
  redact "$DIR/attestation-raw.json" "$DIR/attestation.json"
  rm "$DIR/attestation-raw.json"
  source_used="Phala attestation API"
else
  rm -f "$DIR/metadata-raw.json" "$DIR/attestation-raw.json"
  echo "Warning: could not fetch attestation evidence from the public report or Phala's API"
fi
echo "Evidence source: ${source_used}"

# Record deployment context
cat >"$DIR/deploy-info.json" <<EOF
{
  "git_sha": "${GIT_SHA:-}",
  "git_sha_short": "$(echo "${GIT_SHA:-}" | cut -c1-7)",
  "image_digest": "${IMAGE_DIGEST:-}",
  "agent_image_digest": "${AGENT_IMAGE_DIGEST:-}",
  "app_id": "${PHALA_APP_ID}",
  "evidence_source": "${source_used}",
  "deployed_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "workflow_run": "${WORKFLOW_RUN_URL:-}"
}
EOF

ls -la "$DIR"
