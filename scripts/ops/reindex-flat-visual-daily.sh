#!/usr/bin/env bash
# Daily, quota-aware re-analysis of reels whose visual scenes are still in the older unlabelled form (caption, OCR text and
# object tags stored as one string). Meant to run from cron shortly after Cloudflare Workers AI resets its free allocation
# (00:00 UTC). It re-indexes a few reels, one at a time, through the normal indexing pipeline: a new index attempt that
# requires visual analysis, so a failure leaves the current active scenes untouched.
#
# Guards:
#   - at most MAX_REELS reels a day (default 4, roughly 100 frames, a third of the free daily allocation, which production
#     indexing shares);
#   - stops as soon as ai-service logs that the Cloudflare allocation is spent (the vision adapter would then use the lower
#     quality Groq fallback) or an attempt fails;
#   - never touches the paid Groq key or any production setting;
#   - stops for good, writing a "done" marker, once no reel with unlabelled scenes is left.
#
# Usage (cron, local machine with ssh access to the homelab): reindex-flat-visual-daily.sh
# Logs: ${XDG_STATE_HOME:-~/.local/state}/velora-flat-reindex/YYYYMMDD.log

set -u

HOST="${VELORA_HOST:-velora-homelab}"
MAX_REELS="${MAX_REELS:-4}"
WAIT_SECONDS="${WAIT_SECONDS:-900}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/velora-flat-reindex"
mkdir -p "$STATE_DIR"
exec >>"$STATE_DIR/$(date -u +%Y%m%d).log" 2>&1

log() { echo "[$(date -u +%T)Z] $*"; }
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=30 "$HOST")
REMOTE_PATH='export PATH=$PATH:/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:/opt/homebrew/opt/node/bin'
AI=microservices-boilerplate-ai-service-1
IDX=microservices-boilerplate-reel-indexing-service-1

if [ -e "$STATE_DIR/done" ]; then
  log "done marker present; nothing to do"
  exit 0
fi

LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
    rmdir "$LOCK" && mkdir "$LOCK"
  else
    log "another run is active; exiting"
    exit 0
  fi
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

SINCE="$(date -u +%Y-%m-%dT00:00:00Z)"
quota_spent() {
  "${SSH[@]}" "$REMOTE_PATH; docker logs --since '$SINCE' $AI 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -c 'Cloudflare vision daily allocation spent'" 2>/dev/null | tail -1
}

if ! "${SSH[@]}" "$REMOTE_PATH; docker ps --format '{{.Names}}' | grep -q '^$AI\$' && docker ps --format '{{.Names}}' | grep -q '^$IDX\$'"; then
  log "ai-service or reel-indexing-service is not running (or the host is unreachable); skipping today"
  exit 0
fi
if [ "$(quota_spent)" != "0" ]; then
  log "Cloudflare allocation already spent today (per ai-service logs since $SINCE); skipping"
  exit 0
fi

scp -q "$HERE/reindex-visual-cohort.cjs" "$HOST:/tmp/reindex-visual-cohort.cjs" || { log "could not copy the reindex tool"; exit 0; }

done_count=0
while [ "$done_count" -lt "$MAX_REELS" ]; do
  out="$("${SSH[@]}" "$REMOTE_PATH
cd ~/GitHub/microservices-boilerplate
for k in AI_EMBEDDING_MODEL AI_EMBEDDING_VERSION AI_EMBEDDING_DIMENSIONS; do export \$k=\"\$(docker exec $AI printenv \$k)\"; done
node /tmp/reindex-visual-cohort.cjs --apply --flat --limit=1 2>&1 | tail -1")"
  ids="$(printf '%s' "$out" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);if(j.failedCount>0)console.log("ERROR");else console.log(j.selected.map(r=>r.id).join(","))}catch(e){console.log("ERROR")}})')"
  if [ "$ids" = "ERROR" ]; then
    log "dispatch failed: $(printf '%s' "$out" | cut -c1-300)"
    exit 0
  fi
  if [ -z "$ids" ]; then
    log "no reel with unlabelled scenes is left; writing done marker"
    date -u +%FT%TZ >"$STATE_DIR/done"
    exit 0
  fi
  log "queued reel $ids"

  status=""
  waited=0
  while [ "$waited" -lt "$WAIT_SECONDS" ]; do
    sleep 30
    waited=$((waited + 30))
    status="$("${SSH[@]}" "$REMOTE_PATH
docker exec -e RID=$ids $IDX node -e '
const {PrismaClient}=require(\"@prisma/reel-indexing-client\");
(async()=>{const p=new PrismaClient();
 const a=await p.\$queryRawUnsafe(\`select \"status\" s from \"IndexingAttempt\" where \"reelId\"=\$1 order by \"createdAt\" desc limit 1\`,process.env.RID);
 console.log(a[0]?a[0].s:\"NONE\");await p.\$disconnect()})().catch(e=>console.log(\"ERR\"))' | tail -1" 2>/dev/null)"
    case "$status" in
      COMPLETED|DEGRADED|FAILED) break ;;
    esac
  done
  log "reel $ids attempt status: ${status:-unknown}"
  case "$status" in
    COMPLETED|DEGRADED) done_count=$((done_count + 1)) ;;
    *) log "stopping for today (attempt did not complete)"; exit 0 ;;
  esac
  if [ "$(quota_spent)" != "0" ]; then
    log "Cloudflare allocation spent after this reel; stopping for today"
    exit 0
  fi
done
log "reached the daily limit of $MAX_REELS reels"
