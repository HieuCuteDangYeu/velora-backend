#!/usr/bin/env bash
# Builds services from scratch and checks that Docker can share their layers:
# the node_modules layer must have the same digest in two different services and
# must survive a scripts-only change to package.json.
#
# Usage: scripts/docker/verify-layer-sharing.sh [service-a service-b]
# Needs docker buildx (BuildKit >= 0.13 for rewrite-timestamp) and jq. It runs
# every build with --no-cache, so expect a few minutes per build.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
service_a="${1:-auth-service}"
service_b="${2:-user-service}"
work_dir="$(mktemp -d)"
package_backup="$work_dir/package.json.orig"
cp "$repo_root/package.json" "$package_backup"
restore_package() { cp "$package_backup" "$repo_root/package.json"; rm -rf "$work_dir"; }
trap restore_package EXIT

build() {
  local service="$1" name="$2"
  docker buildx build \
    --file "$repo_root/apps/$service/Dockerfile" \
    --platform linux/arm64 \
    --no-cache \
    --provenance=false \
    --build-arg SOURCE_DATE_EPOCH=1767225600 \
    --output "type=oci,dest=$work_dir/$name.tar,rewrite-timestamp=true" \
    "$repo_root"
  mkdir "$work_dir/$name"
  tar -xf "$work_dir/$name.tar" -C "$work_dir/$name"
}

# Prints "<compressed size> <layer digest>" for every layer of the image.
layers() {
  local dir="$work_dir/$1" manifest
  manifest="$(jq -r '.manifests[0].digest | sub("sha256:"; "")' "$dir/index.json")"
  jq -r '.layers[] | "\(.size) \(.digest)"' "$dir/blobs/sha256/$manifest"
}

# The node_modules layer is by far the largest layer a service adds.
largest_layer() { layers "$1" | sort -rn | head -n 1; }

build "$service_a" a
build "$service_b" b
node -e '
const fs = require("fs");
const file = process.argv[1];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.scripts["layer-sharing-check"] = "true";
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$repo_root/package.json"
build "$service_a" c

for name in a b c; do
  echo "== $name: $(layers "$name" | wc -l | tr -d ' ') layers, largest: $(largest_layer "$name")"
done

status=0
if [ "$(largest_layer a)" != "$(largest_layer b)" ]; then
  echo "FAIL: $service_a and $service_b do not share their node_modules layer" >&2
  status=1
fi
if [ "$(largest_layer a)" != "$(largest_layer c)" ]; then
  echo "FAIL: a scripts-only package.json change produced a new node_modules layer" >&2
  status=1
fi
[ "$status" -eq 0 ] && echo "OK: node_modules layer is shared across services and builds"
exit "$status"
