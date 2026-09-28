#!/bin/sh
set -eu

model_dir="${JEFF_MODEL:-/models/gliformer-large-v1}"
model_repo="${JEFF_MODEL_REPO:-knowledgator/gliformer-large-v1}"

if [ ! -f "${model_dir}/gliner_config.json" ]; then
  mkdir -p "${model_dir}"
  MODEL_DIR="${model_dir}" MODEL_REPO="${model_repo}" python - <<'PY'
import os

from huggingface_hub import snapshot_download

snapshot_download(
    repo_id=os.environ['MODEL_REPO'],
    local_dir=os.environ['MODEL_DIR'],
    ignore_patterns=['*.gif', '*.md'],
)
PY
fi

exec jeff
