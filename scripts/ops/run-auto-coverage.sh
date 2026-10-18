#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$DIR"

FROZEN_DIR=".benchmarks/rag-coverage-440-20261006-01/frozen"
RUN_DIR=".benchmarks/rag-coverage-440-20261006-01/run-01"
COMPILED_BASE="dist/apps/ai-service/apps/ai-service/src"
ENV_FILE=".env"
LEDGER="$RUN_DIR/usage-ledger.jsonl"
STATE_FILE="$RUN_DIR/state.json"

mkdir -p "$RUN_DIR"

echo "=========================================================="
echo " Starting 440 Questions RAG Coverage Evaluation"
echo " Zero Cost Mode with Groq Key Pool (13 Keys)"
echo " Run Directory: $RUN_DIR"
echo "=========================================================="

while true; do
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Launching evaluation batch..."
  node scripts/ops/run-rag-coverage-evaluation.cjs \
    "$FROZEN_DIR" \
    "$RUN_DIR" \
    "$COMPILED_BASE" \
    "$ENV_FILE" \
    "$LEDGER" || true

  if [ ! -f "$STATE_FILE" ]; then
    echo "State file not found. Check error output above."
    exit 1
  fi

  STATUS=$(node -e "const s = JSON.parse(require('fs').readFileSync('$STATE_FILE')); console.log(s.status);")
  COMPLETED_COUNT=$(node -e "const s = JSON.parse(require('fs').readFileSync('$STATE_FILE')); const c = Object.values(s.cases||{}).filter(x => x.status === 'COMPLETED').length; const t = Object.keys(s.cases||{}).length; console.log(c + '/' + t);")

  echo "[$(date '+%Y-%m-%d %H:%M:%S')] Batch finished. Status: $STATUS ($COMPLETED_COUNT cases completed)"

  if [ "$STATUS" = "COMPLETE" ] || [ "$STATUS" = "COMPLETE_WITH_EXECUTION_FAILURES" ]; then
    echo "==> ALL 440 QUESTIONS COMPLETED!"
    break
  fi

  if [ "$STATUS" = "WAITING_FOR_UTC_RESET" ]; then
    NEXT_RESUME=$(node -e "const s = JSON.parse(require('fs').readFileSync('$STATE_FILE')); console.log(s.nextResumeAt || 'next reset');")
    echo "==> Quota reached for today. Waiting for UTC midnight reset ($NEXT_RESUME)..."
    echo "==> Will automatically resume at 07:00 AM local time."
  fi

  # Sleep 15 minutes before checking / retrying
  sleep 900
done
