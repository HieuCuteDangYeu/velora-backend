#!/usr/bin/env bash
# Decides which application images the CD must rebuild for a release.
#
# Reads the changed file paths (one per line) on stdin and prints either
#   *                    every image must be rebuilt, or
#   <service> <service>  the images whose build inputs changed (may be empty).
#
# An image that is not listed is byte-for-byte what the last release already
# has, so the CD re-tags that image with the new commit SHA instead of building
# it again. The rules are deliberately conservative: anything that is not known
# to be irrelevant to the images rebuilds everything.
#
# Usage: select-rebuild-services.sh <service>...   (the services that exist)
set -euo pipefail

(($# > 0)) || {
  echo 'usage: select-rebuild-services.sh <service>...' >&2
  exit 2
}
services=("$@")
selected=()

select_service() {
  local candidate="$1" existing
  for existing in "${selected[@]:-}"; do
    [[ "$existing" == "$candidate" ]] && return
  done
  selected+=("$candidate")
}

while IFS= read -r file; do
  [[ -n "$file" ]] || continue

  case "$file" in
    # Shared inputs of every Nest build and of the image layers.
    libs/*|package.json|pnpm-lock.yaml|pnpm-workspace.yaml|nest-cli.json|tsconfig*.json|.npmrc|.dockerignore|Dockerfile|Dockerfile.*|docker/*|infra/docker/*|.github/workflows/cd.yml)
      echo '*'
      exit 0
      ;;
    # Never part of an application image.
    docs/*|scripts/*|infra/*|eval/*|.github/*|docker-compose*.yml|docker-compose*.yaml|compose.yml|compose.yaml|.env.example|*.md|LICENSE*|.gitignore|.prettierrc|eslint.config.mjs|jest.config.cjs|.vscode/*|.claude/*|.agents/*|.codex/*|.archify/*|AGENTS.md)
      continue
      ;;
  esac

  matched=false
  for service in "${services[@]}"; do
    if [[ "$file" == "apps/${service}/"* ]]; then
      select_service "$service"
      matched=true
      break
    fi
  done

  if [[ "$matched" == false ]]; then
    # Unknown path (new top-level folder, another app): do not guess.
    echo '*'
    exit 0
  fi
done

printf '%s\n' "${selected[*]:-}"
