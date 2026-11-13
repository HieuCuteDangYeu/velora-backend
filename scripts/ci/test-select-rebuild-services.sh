#!/usr/bin/env bash
# Tests the CD rebuild selection. Run from the repository root.
set -euo pipefail

script="$(dirname "$0")/select-rebuild-services.sh"
services=(api-gateway call-service conversation-service friend-service)
failures=0

expect() {
  local name="$1" expected="$2" input="$3" actual
  actual="$(printf '%b' "$input" | "$script" "${services[@]}")"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL $name: expected '$expected', got '$actual'" >&2
    failures=$((failures + 1))
  else
    echo "ok   $name"
  fi
}

expect 'no changes' '' ''
expect 'one service' 'call-service' 'apps/call-service/src/a.ts\n'
expect 'two services, deduplicated' 'api-gateway call-service' \
  'apps/api-gateway/src/a.ts\napps/call-service/src/b.ts\napps/api-gateway/src/c.ts\n'
expect 'prisma schema belongs to its service' 'conversation-service' \
  'apps/conversation-service/prisma/schema.prisma\n'
expect 'service-owned plus ignored files' 'call-service' \
  'apps/call-service/src/a.ts\ndocs/x.md\nscripts/deploy/velora-deploy\n'
expect 'deploy scripts only' '' 'scripts/deploy/velora-deploy-core\n'
expect 'infra and compose only' '' \
  'infra/loki-node/compose.yaml\ndocker-compose.yml\ninfra/monitoring/alloy/config.alloy\n'
expect 'CI workflow only' '' '.github/workflows/deploy.yml\n'
expect 'shared library rebuilds all' '*' 'libs/common/src/a.ts\napps/call-service/src/a.ts\n'
expect 'lockfile rebuilds all' '*' 'pnpm-lock.yaml\n'
expect 'tsconfig rebuilds all' '*' 'tsconfig.build.json\n'
expect 'CD workflow rebuilds all' '*' '.github/workflows/cd.yml\n'
expect 'unknown top-level path rebuilds all' '*' 'newdir/file.txt\n'
expect 'unknown app rebuilds all' '*' 'apps/brand-new-service/src/a.ts\n'
expect 'a Dockerfile of an app counts as that app' 'call-service' \
  'apps/call-service/Dockerfile\n'

((failures == 0)) || {
  echo "$failures failed" >&2
  exit 1
}
echo 'all passed'
