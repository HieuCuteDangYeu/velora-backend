#!/usr/bin/env bash
set -euo pipefail
export QDRANT__SERVICE__API_KEY="$(cat /run/secrets/qdrant_api_key)"
[[ -n "$QDRANT__SERVICE__API_KEY" ]] || exit 1
exec /qdrant/qdrant --config-path /qdrant/config/velora.yaml
