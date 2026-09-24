#!/usr/bin/env bash
# validate_mermaid.sh — extract every ```mermaid block from a file and render it,
# so syntax errors are caught before the diagram reaches the user.
#
# Usage:  bash validate_mermaid.sh path/to/doc.md [more.md ...]
# Exit:   0 = all blocks render, 1 = at least one failed, 2 = renderer unavailable
set -uo pipefail

[ $# -ge 1 ] || { echo "usage: bash validate_mermaid.sh <file.md> [...]" >&2; exit 2; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if command -v mmdc >/dev/null 2>&1; then
  RENDER="mmdc"
elif command -v npx >/dev/null 2>&1; then
  RENDER="npx --yes @mermaid-js/mermaid-cli"
else
  cat >&2 <<'EOF'
mermaid-cli not found — cannot validate.
Install one of:
  npm i -g @mermaid-js/mermaid-cli     # then: mmdc
  npx @mermaid-js/mermaid-cli          # no install
Do not deliver the diagram claiming it was validated. Say it was not.
EOF
  exit 2
fi

# headless chrome config (needed in most containers/CI)
cat > "$TMP/puppeteer.json" <<'EOF'
{ "args": ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] }
EOF

FAIL=0
TOTAL=0

for SRC in "$@"; do
  [ -f "$SRC" ] || { echo "SKIP  $SRC (not found)"; FAIL=1; continue; }

  # A raw .mmd/.mermaid file is one block; a .md is scanned for fenced blocks.
  case "$SRC" in
    *.mmd|*.mermaid)
      cp "$SRC" "$TMP/block_01.mmd"; echo 1 > "$TMP/count" ;;
    *)
  awk -v dir="$TMP" -v src="$SRC" '
    /^[ \t]*```[ \t]*mermaid[ \t]*$/ { n++; f=sprintf("%s/block_%02d.mmd", dir, n); inb=1; next }
    inb && /^[ \t]*```[ \t]*$/       { inb=0; close(f); next }
    inb                               { print > f }
    END { print n+0 > (dir "/count") }
  ' "$SRC" ;;
  esac

  N=$(cat "$TMP/count" 2>/dev/null || echo 0)
  if [ "$N" -eq 0 ]; then
    echo "WARN  $SRC — no mermaid blocks found"
    continue
  fi

  for i in $(seq 1 "$N"); do
    BLOCK=$(printf '%s/block_%02d.mmd' "$TMP" "$i")
    [ -f "$BLOCK" ] || continue
    TOTAL=$((TOTAL+1))
    if OUT=$($RENDER -i "$BLOCK" -o "$TMP/out_$i.svg" -p "$TMP/puppeteer.json" 2>&1); then
      echo "OK    $SRC block #$i  ($(head -1 "$BLOCK" | tr -d '\r'))"
    elif printf '%s' "$OUT" | grep -qiE 'Could not find Chrome|Failed to launch|browser was not found|ENOENT.*chrome'; then
      cat >&2 <<'ENVERR'

ENVIRONMENT ERROR — this is NOT a diagram syntax problem.
mermaid-cli is installed but its headless browser is missing. Install it:

  npx puppeteer browsers install chrome-headless-shell
  # or:  npx puppeteer browsers install chrome
  # Linux may also need:  sudo apt-get install -y libnss3 libatk-bridge2.0-0 \
  #     libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 \
  #     libgbm1 libpango-1.0-0 libcairo2 libasound2

Alternative: use the mermaid-validator MCP server instead of this script.
Until one of them works, state in the delivery that the diagram was NOT validated.
ENVERR
      exit 2
    else
      FAIL=1
      echo "FAIL  $SRC block #$i"
      echo "$OUT" | sed 's/^/        /' | head -20
      echo "      --- block source ---"
      nl -ba "$BLOCK" | sed 's/^/        /' | head -60
    fi
  done
  rm -f "$TMP"/block_*.mmd "$TMP/count"
done

echo
if [ "$FAIL" -eq 0 ]; then
  echo "All $TOTAL mermaid block(s) rendered successfully."
else
  echo "Validation failed. Fix the blocks above before delivering."
  echo "Most common causes: unquoted label containing ()[]{},  the reserved word 'end',"
  echo "node ids with spaces/dots, or a node id starting with o/x right after an edge."
fi
exit $FAIL
