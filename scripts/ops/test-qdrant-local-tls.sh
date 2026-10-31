#!/usr/bin/env bash
set -Eeuo pipefail
root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
socket="${QDRANT_LOCAL_DOCKER_SOCKET:-unix:///var/run/docker.sock}"
[[ "$socket" == unix:///* ]] || { printf 'Only a verified local Unix Docker socket is allowed\n' >&2; exit 1; }
docker_local() { docker --host "$socket" "$@"; }
[[ "$(docker_local info --format '{{.OSType}}')" == linux ]]
tmp="$(mktemp -d)"
name="velora-qdrant-tls-test-$$"
volume="${name}-storage"
cleanup() {
  docker_local rm -f "$name" >/dev/null 2>&1 || true
  docker_local volume rm "$volume" >/dev/null 2>&1 || true
  rm -rf -- "$tmp"
}
trap cleanup EXIT
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$tmp/server.key" -out "$tmp/server.crt" -days 1 \
  -subj /CN=qdrant -addext 'subjectAltName=DNS:qdrant,DNS:localhost,IP:127.0.0.1' >/dev/null 2>&1
cp "$tmp/server.crt" "$tmp/ca.crt"
printf 'disposable-local-tls-key\n' >"$tmp/api-key"
docker_local volume create --label velora.test=qdrant-tls "$volume" >/dev/null
start() {
  docker_local run -d --name "$name" --label velora.test=qdrant-tls --cpus=1 --memory=768m -p 127.0.0.1::6333 \
    -v "$volume:/qdrant/storage" -v "$root/infra/qdrant/config.yaml:/qdrant/config/velora.yaml:ro" \
    -v "$tmp/api-key:/run/secrets/qdrant_api_key:ro" -v "$tmp/server.crt:/run/secrets/qdrant_tls_cert:ro" \
    -v "$tmp/server.key:/run/secrets/qdrant_tls_key:ro" -v "$tmp/ca.crt:/run/secrets/qdrant_tls_ca:ro" \
    -v "$root/infra/qdrant/ready.sh:/qdrant/velora-ready.sh:ro" \
    -v "$root/infra/qdrant/entrypoint.sh:/qdrant/velora-entrypoint.sh:ro" \
    --entrypoint bash qdrant/qdrant:v1.20.0@sha256:9bfc89f9914fc14876a88c05270685921a55b8877b254a98bcc1cc2f0a424cd2 /qdrant/velora-entrypoint.sh >/dev/null
  port="$(docker_local port "$name" 6333/tcp | sed 's/.*://')"
  for ((i=0;i<50;i++)); do
    if docker_local exec "$name" bash /qdrant/velora-ready.sh >/dev/null 2>&1; then return; fi
    sleep 0.2
  done
  docker_local logs "$name" >&2
  return 1
}
start
NODE_EXTRA_CA_CERTS="$tmp/ca.crt" QDRANT_TLS_TEST_PORT="$port" node - <<'JS'
(async () => {
  const base = `https://127.0.0.1:${process.env.QDRANT_TLS_TEST_PORT}`;
  const unauth = await fetch(`${base}/collections`); if (unauth.status !== 401 && unauth.status !== 403) throw new Error('Unauthenticated request accepted');
  const response = await fetch(`${base}/collections/persistence`, { method:'PUT', headers:{'api-key':'disposable-local-tls-key','content-type':'application/json'}, body:JSON.stringify({vectors:{size:1024,distance:'Cosine',memory:'cached'},payload:{memory:'cached'}}) });
  if (!response.ok) throw new Error('Authenticated TLS collection creation failed');
})();
JS
docker_local rm -f "$name" >/dev/null
start
NODE_EXTRA_CA_CERTS="$tmp/ca.crt" QDRANT_TLS_TEST_PORT="$port" node - <<'JS'
(async () => { const response = await fetch(`https://127.0.0.1:${process.env.QDRANT_TLS_TEST_PORT}/collections/persistence`, {headers:{'api-key':'disposable-local-tls-key'}}); if (!response.ok) throw new Error('Named-volume state was lost on recreation'); const body=await response.json(); if(body.result.config.params.vectors.memory!=='cached') throw new Error('Effective memory tier mismatch'); })();
JS
printf 'local pinned Qdrant TLS/auth/readiness/config/named-volume recreation: PASS\n'
