#!/usr/bin/env bash
# Tests pair-offsite-copy.sh with a stub `ssh` that runs the remote command locally, once
# honestly and once with a corrupting remote, so the checksum gate is shown to fire.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin" "$TMP/src" "$TMP/remote"
cat >"$TMP/bin/ssh" <<'STUB'
#!/usr/bin/env bash
# stub: ignore options and host, run the command in a sandbox directory
while [ "$#" -gt 0 ]; do case "$1" in -o) shift 2 ;; -*) shift ;; *) break ;; esac; done
shift # host
cmd="$*"
cmd="${cmd//\/remote-root/$REMOTE_ROOT}"
if [ "${STUB_CORRUPT:-}" = 1 ]; then cmd="${cmd//cat >/head -c 5 >}"; fi
exec sh -c "$cmd"
STUB
chmod +x "$TMP/bin/ssh"
printf 'ciphertext-one' >"$TMP/src/reel-indexing-1.vqd"
printf 'ciphertext-two' >"$TMP/src/velora-qdrant-1-aa.vqb"
export PATH="$TMP/bin:$PATH" REMOTE_ROOT="$TMP/remote"

out="$("$HERE/pair-offsite-copy.sh" node-2 "$TMP/remote/pair-1" "$TMP/src/reel-indexing-1.vqd" "$TMP/src/velora-qdrant-1-aa.vqb")"
echo "$out" | grep -q "off-site verified reel-indexing-1.vqd" || { echo "FAIL: missing verification line"; exit 1; }
cmp "$TMP/src/reel-indexing-1.vqd" "$TMP/remote/pair-1/reel-indexing-1.vqd"
[ ! -e "$TMP/remote/pair-1/reel-indexing-1.vqd.partial" ] || { echo "FAIL: partial file left"; exit 1; }

if STUB_CORRUPT=1 "$HERE/pair-offsite-copy.sh" node-2 "$TMP/remote/pair-2" "$TMP/src/reel-indexing-1.vqd" 2>"$TMP/err"; then
  echo "FAIL: corrupted copy was accepted"; exit 1
fi
grep -q "checksum mismatch" "$TMP/err" || { echo "FAIL: no mismatch message"; exit 1; }

if "$HERE/pair-offsite-copy.sh" node-2 "/x;rm -rf" "$TMP/src/reel-indexing-1.vqd" 2>/dev/null; then
  echo "FAIL: unsafe remote directory accepted"; exit 1
fi
echo "pair-offsite-copy tests passed"
