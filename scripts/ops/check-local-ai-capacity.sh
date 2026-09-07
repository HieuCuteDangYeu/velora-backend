#!/usr/bin/env bash
set -euo pipefail

readonly DEFAULT_MIN_FREE_DISK_GB=12
readonly DEFAULT_DISK_PATH=/var/lib/docker

report_only=0
min_free_disk_gb="${LOCAL_AI_MIN_FREE_DISK_GB:-$DEFAULT_MIN_FREE_DISK_GB}"
disk_path="${LOCAL_AI_DISK_PATH:-$DEFAULT_DISK_PATH}"

usage() {
  cat <<'EOF'
Usage: bash scripts/ops/check-local-ai-capacity.sh [--report]
       [--min-free-disk-gb <integer>] [--disk-path <path>]

The default mode is a fail-closed preflight. --report prints the same
read-only diagnostics without failing when the capacity gate is closed.
No Docker cleanup or model startup is performed.
EOF
}

while (($# > 0)); do
  case "$1" in
    --report)
      report_only=1
      shift
      ;;
    --min-free-disk-gb)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      min_free_disk_gb="$2"
      shift 2
      ;;
    --disk-path)
      [[ $# -ge 2 ]] || { usage >&2; exit 2; }
      disk_path="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$min_free_disk_gb" =~ ^[0-9]+$ ]]; then
  printf 'MIN_FREE_DISK_GB must be a non-negative integer.\n' >&2
  exit 2
fi

if [[ -z "$disk_path" ]]; then
  printf 'LOCAL_AI_DISK_PATH must be non-empty.\n' >&2
  exit 2
fi

disk_row=''
if ! disk_row="$(df -Pk "$disk_path" 2>/dev/null | tail -n 1)" || [[ -z "$disk_row" ]]; then
  printf 'Could not inspect disk path: %s\n' "$disk_path" >&2
  exit 1
fi

read -r filesystem total_blocks used_blocks available_blocks usage_percent mountpoint <<<"$disk_row"
if ! [[ "$total_blocks" =~ ^[0-9]+$ && "$used_blocks" =~ ^[0-9]+$ && "$available_blocks" =~ ^[0-9]+$ ]]; then
  printf 'Could not parse df output for: %s\n' "$disk_path" >&2
  exit 1
fi

bytes_per_gib=$((1024 * 1024 * 1024))
bytes_per_block=1024
disk_total_bytes=$((total_blocks * bytes_per_block))
disk_used_bytes=$((used_blocks * bytes_per_block))
disk_free_bytes=$((available_blocks * bytes_per_block))
min_free_disk_bytes=$((min_free_disk_gb * bytes_per_gib))

memory_row=''
if ! memory_row="$(free -b 2>/dev/null | awk '/^Mem:/ {print $2, $3, $4, $5, $6, $7}')" || [[ -z "$memory_row" ]]; then
  printf 'Could not inspect host memory.\n' >&2
  exit 1
fi
read -r ram_total_bytes ram_used_bytes ram_free_bytes ram_shared_bytes ram_cache_bytes ram_available_bytes <<<"$memory_row"

swap_row="$(free -b 2>/dev/null | awk '/^Swap:/ {print $2, $3, $4}')"
read -r swap_total_bytes swap_used_bytes swap_free_bytes <<<"$swap_row"

docker_available=YES
running_local_models=''
if ! running_local_models="$(docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | awk '$1 ~ /rag-(embedding|reranker|vision)/')"; then
  docker_available=NO
  running_local_models=UNKNOWN
fi

docker_system_df='UNAVAILABLE'
docker_system_df_verbose='UNAVAILABLE'
if [[ "$docker_available" == YES ]]; then
  docker_system_df="$(docker system df 2>/dev/null || printf 'UNAVAILABLE\n')"
  docker_system_df_verbose="$(docker system df -v 2>/dev/null || printf 'UNAVAILABLE\n')"
fi

container_log_bytes=0
container_log_report=COMPLETE
if [[ "$docker_available" == YES ]]; then
  while IFS= read -r container_id; do
    [[ -n "$container_id" ]] || continue
    log_path="$(docker inspect --format '{{.LogPath}}' "$container_id" 2>/dev/null || true)"
    if [[ -z "$log_path" ]]; then
      container_log_report=PARTIAL
      continue
    fi
    log_bytes="$(stat -c '%s' "$log_path" 2>/dev/null || true)"
    if [[ "$log_bytes" =~ ^[0-9]+$ ]]; then
      container_log_bytes=$((container_log_bytes + log_bytes))
    else
      container_log_report=PARTIAL
    fi
  done < <(docker ps -aq 2>/dev/null || true)
else
  container_log_report=UNAVAILABLE
fi

disk_gate=NO
if ((disk_free_bytes >= min_free_disk_bytes)); then
  disk_gate=YES
fi

local_ai_start_allowed=NO
capacity_reasons=free_disk_below_threshold
if [[ "$disk_gate" == YES && "$docker_available" == YES ]]; then
  local_ai_start_allowed=YES
  capacity_reasons=none
elif [[ "$disk_gate" == YES ]]; then
  capacity_reasons=docker_status_unavailable
fi

printf 'LOCAL_AI_START_ALLOWED=%s\n' "$local_ai_start_allowed"
printf 'LOCAL_AI_START_REASONS=%s\n' "$capacity_reasons"
printf 'LOCAL_AI_DISK_PATH=%s\n' "$disk_path"
printf 'MIN_FREE_DISK_GB=%s\n' "$min_free_disk_gb"
printf 'DISK_FILESYSTEM=%s\n' "$filesystem"
printf 'DISK_TOTAL_BYTES=%s\n' "$disk_total_bytes"
printf 'DISK_USED_BYTES=%s\n' "$disk_used_bytes"
printf 'DISK_FREE_BYTES=%s\n' "$disk_free_bytes"
printf 'DISK_USAGE_PERCENT=%s\n' "$usage_percent"
printf 'RAM_TOTAL_BYTES=%s\n' "$ram_total_bytes"
printf 'RAM_USED_BYTES=%s\n' "$ram_used_bytes"
printf 'RAM_AVAILABLE_BYTES=%s\n' "$ram_available_bytes"
printf 'SWAP_TOTAL_BYTES=%s\n' "${swap_total_bytes:-UNKNOWN}"
printf 'SWAP_FREE_BYTES=%s\n' "${swap_free_bytes:-UNKNOWN}"
printf 'RUNNING_LOCAL_MODELS=%s\n' "${running_local_models:-none}"
printf 'DOCKER_AVAILABLE=%s\n' "$docker_available"
printf 'DOCKER_SYSTEM_DF_START\n%s\nDOCKER_SYSTEM_DF_END\n' "$docker_system_df"
printf 'MODEL_VOLUME_SIZES_START\n%s\nMODEL_VOLUME_SIZES_END\n' "$(printf '%s\n' "$docker_system_df_verbose" | grep -E 'rag_(embedding|reranker|vision)_cache' || printf 'none\n')"
printf 'CONTAINER_LOG_BYTES=%s\n' "$container_log_bytes"
printf 'CONTAINER_LOG_REPORT=%s\n' "$container_log_report"

if ((report_only == 0)) && [[ "$local_ai_start_allowed" != YES ]]; then
  exit 1
fi
