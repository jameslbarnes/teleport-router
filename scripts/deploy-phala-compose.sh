#!/usr/bin/env bash
# Private logs and the encrypted environment carry over in both deployment phases.
set -euo pipefail
for attempt in {1..20}; do
  echo "Phala deploy attempt ${attempt}/20"
  set +e
  phala deploy --wait --cvm-id "${PHALA_APP_ID:?missing CVM}" -c "$1" -e /tmp/phala.env --no-public-logs 2>&1 | tee /tmp/phala-deploy.log
  status=${PIPESTATUS[0]}
  set -e

  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  if grep -q "Another operation is already in progress" /tmp/phala-deploy.log; then
    if [ "$attempt" -eq 20 ]; then
      echo "Phala deploy is still locked after ${attempt} attempts"
      exit "$status"
    fi
    echo "Phala reports an operation in progress; waiting 60s before retrying"
    sleep 60
    continue
  fi

  exit "$status"
done
