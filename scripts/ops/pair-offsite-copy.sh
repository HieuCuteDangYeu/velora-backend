#!/usr/bin/env bash
# Copies already-encrypted pair artifacts to an off-site host over ssh and verifies each file
# by SHA-256 on the far side. Used for velora-node-2 (France); the node only ever stores
# ciphertext and never receives the encryption key.
#
#   pair-offsite-copy.sh <ssh-target> <remote-dir> <file> [file...]
set -euo pipefail
umask 077
TARGET="${1:?ssh target}"
REMOTE_DIR="${2:?remote directory}"
shift 2
[ "$#" -gt 0 ] || { echo "no files" >&2; exit 64; }
SSH_OPTS="${SSH_OPTS:--o BatchMode=yes -o ConnectTimeout=20}"
case "$REMOTE_DIR" in *[!a-zA-Z0-9/_.-]*) echo "unsafe remote directory" >&2; exit 64 ;; esac
sha256_file() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
for file in "$@"; do
  base="$(basename "$file")"
  case "$base" in *[!a-zA-Z0-9_.-]*) echo "unsafe file name" >&2; exit 64 ;; esac
  # shellcheck disable=SC2086
  ssh $SSH_OPTS "$TARGET" "umask 077; mkdir -p '$REMOTE_DIR' && cat > '$REMOTE_DIR/$base.partial' && mv '$REMOTE_DIR/$base.partial' '$REMOTE_DIR/$base'" <"$file"
  want="$(sha256_file "$file")"
  # shellcheck disable=SC2086
  got="$(ssh $SSH_OPTS "$TARGET" "sha256sum '$REMOTE_DIR/$base'" | cut -d' ' -f1)"
  [ "$want" = "$got" ] || { echo "off-site checksum mismatch for $base" >&2; exit 1; }
  echo "off-site verified $base $want"
done
