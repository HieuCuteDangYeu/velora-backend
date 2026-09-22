#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$repo_root/scripts/deploy/velora-deploy-core"

tmp_dir="$(mktemp -d)"
trap 'rm -rf -- "$tmp_dir"' EXIT

base="$tmp_dir/base.json"
target="$tmp_dir/target.json"
unsafe="$tmp_dir/unsafe.json"

cat >"$base" <<'JSON'
{
  "services": {
    "rabbitmq": {
      "image": "rabbitmq:3.13-management",
      "expose": ["5672"],
      "environment": {"RABBITMQ_DEFAULT_VHOST": "/"},
      "volumes": [
        {"type":"volume","source":"rabbitmq_data","target":"/var/lib/rabbitmq","volume":{}}
      ]
    }
  }
}
JSON

cat >"$target" <<'JSON'
{
  "services": {
    "rabbitmq": {
      "image": "rabbitmq:3.13-management",
      "expose": ["5672", "15692"],
      "environment": {"RABBITMQ_DEFAULT_VHOST": "/"},
      "volumes": [
        {"type":"volume","source":"rabbitmq_data","target":"/var/lib/rabbitmq","volume":{}},
        {"type":"bind","source":"./infra/rabbitmq/enabled_plugins","target":"/etc/rabbitmq/enabled_plugins","read_only":true,"bind":{"create_host_path":true}}
      ]
    }
  }
}
JSON

jq '.services.rabbitmq.environment.RABBITMQ_DEFAULT_VHOST = "/changed"' "$target" >"$unsafe"

is_approved_rabbitmq_prometheus_migration "$base" "$target"
! is_approved_rabbitmq_prometheus_migration "$base" "$unsafe"

plugins="$tmp_dir/enabled_plugins"
printf '%s\n' '[rabbitmq_management,rabbitmq_prometheus].' >"$plugins"
is_expected_rabbitmq_plugins_file "$plugins"
printf '%s\n' '[rabbitmq_management,rabbitmq_prometheus,rabbitmq_shovel].' >"$plugins"
! is_expected_rabbitmq_plugins_file "$plugins"

echo "RabbitMQ Prometheus migration guard tests passed."
