set -eu
IMAGE='pgvector/pgvector:pg18@sha256:c29f30688a9ad961691bdf0ec1650717cc132a5814619d80f80463d6e4c42e47'
DIR=/opt/velora/reel-indexing-standby
cd "$DIR"
echo "RAM before: $(free -m | awk '/Mem:/{print "used="$3" available="$7" MiB"}') $(free -m | awk '/Swap:/{print "swap_used="$3}')"
timeout 5 bash -c '</dev/tcp/100.102.228.48/15432' && echo "primary forwarder reachable"
umask 077
printf 'PGPASSWORD=%s\n' "$(cat replicator.pw)" > .basebackup.env
docker volume create reel-indexing-standby_reel_indexing_standby_data >/dev/null
start=$(date +%s)
docker run --rm --user root --env-file .basebackup.env --memory 512m \
  -v reel-indexing-standby_reel_indexing_standby_data:/var/lib/postgresql/data "$IMAGE" sh -c '
    chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data &&
    exec gosu postgres pg_basebackup -h 100.102.228.48 -p 15432 -U replicator_idx -D /var/lib/postgresql/data \
      -X stream -R -C -S idx_standby --checkpoint=fast --max-rate=10M' 2>&1 | tail -3
rm -f .basebackup.env
echo "base backup seconds: $(( $(date +%s) - start ))"
echo "RAM after base backup: $(free -m | awk '/Mem:/{print "used="$3" available="$7" MiB"}')"
docker compose up -d 2>&1 | tail -3
