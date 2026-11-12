# CI deploys drop the Qdrant overlay from the reel-indexing services (2026-11-06)

Status: observed and worked around by hand. Not fixed in the repository.

## What happened

The CI deploy of `35dceff1` (about 15:34 local) recreated `reel-indexing-service` and `reel-indexing-long-service`
from the plain `docker-compose.yml`. Their Qdrant settings are not in that file or in `.github/workflows/deploy.yml`. They
are applied by hand with the overlay `/Users/quan/velora-operations/qdrant-staging/index-rollout.yml`, which sets:

- the image `velora-reel-indexing-qdrant:6ca1491e` (built locally, not from CI),
- `INDEX_VECTOR_SEARCH_BACKEND=qdrant`, `INDEX_VECTOR_PROJECTION_ENABLED=true`, `INDEX_VECTOR_PUBLICATION_REQUIRED=true`,
- `QDRANT_URL`, `QDRANT_COLLECTION`, the API key and TLS CA secrets, and the `reel-vector-net` network.

Without them the indexer rejects every job at the persist step with
`Qdrant vector publication must be enabled` (`prisma-semantic-index.repository.ts`), so no reel could be indexed or
reindexed after that deploy. No user reel hit it, because none was uploaded in that window.

## Work-around applied

```
docker compose -f docker-compose.yml -f /Users/quan/velora-operations/qdrant-staging/index-rollout.yml \
  up -d --no-deps --no-build --force-recreate reel-indexing-service reel-indexing-long-service
```

The next CI deploy will drop it again until the repository covers it.

## Options to fix it for good

1. Make the CI deploy apply the overlay (and build or tag the Qdrant indexing image) for the two indexing services.
2. Move the `INDEX_VECTOR_*`, `QDRANT_*` settings, networks and secrets into `docker-compose.yml`, so the plain compose is
   enough, and publish the indexing image from CI instead of building it locally.
3. As a guard, have the indexer fail fast at start-up, not at the first job, when `INDEX_VECTOR_PROJECTION_ENABLED` is not
   `true`, so a mis-deploy is visible immediately.

## Decision and recommended fix (2026-11-08)

The repository already has the supported path: `docker-compose.qdrant.yml` (profile `qdrant`) defines the Qdrant-enabled
`reel-indexing-service` and `reel-indexing-long-service`, and `scripts/deploy/velora-deploy-core` honours
`COMPOSE_FILE=docker-compose.yml:docker-compose.qdrant.yml` and runs `qdrant_deploy_preflight` for Qdrant releases. The gap is on
the host: it still uses the hand-built overlay and a locally built image (`velora-reel-indexing-qdrant:6ca1491e`), so the
deploy environment never selects the repo overlay.

Recommended fix, which is an ops change on the host and not a code change:

1. In the deploy environment on the host, set `COMPOSE_FILE=docker-compose.yml:docker-compose.qdrant.yml` and
   `COMPOSE_PROFILES=qdrant` once the gates named in that file's header are met (benchmark hold, disk, certificate,
   migration, backup).
2. Publish the indexing image from CI so the locally built `6ca1491e` tag is no longer needed, then retire
   `index-rollout.yml`.
3. Until then, after every CI deploy run `scripts/deploy/ensure-reel-indexing-qdrant --check`, and `--apply` if it reports a
   problem. It checks both indexing containers for the `velora-reel-indexing-qdrant:*` image, the `QDRANT_*` variables and
   `reel-vector-net`, and re-applies the overlay with the command above (tested in
   `scripts/deploy/test-ensure-reel-indexing-qdrant.sh`).

I did not change the host deploy environment or the compose files: that alters how every release deploys and is gated by the
repository's own Qdrant policy.

## Live benchmark test conversations (2026-11-08)

`scripts/ops/run-langfuse-live-benchmark.cjs` creates one bot conversation per case and has no cleanup step. The API has no
delete-conversation route (only message delete, member removal and `POST /conversations/:id/leave`), so the 220 conversations
from run `live-smoke-20261108-01` (ids in `/tmp/velora-langfuse-live-benchmark/live-smoke-20261108-01.state.json`) were left in
place instead of being removed with raw SQL on production.

## Mitigation in the deploy controller (2026-11-09)

`velora-deploy-core` now calls `reapply_reel_indexing_qdrant_overlay` after the application and infrastructure reconcile steps
and before health verification. It runs `scripts/deploy/ensure-reel-indexing-qdrant --apply` only when the private overlay file
exists on the host and `COMPOSE_FILE` does not already select `docker-compose.qdrant.yml`. It is a no-op when both indexers are
already Qdrant-enabled and only warns on failure, so it never blocks or rolls back a release. The controller is extracted from the
approved SHA, so this takes effect on the first deploy that includes it, with no launcher reinstall.

Not done, and why: switching the host to the repository overlay (`COMPOSE_FILE=docker-compose.yml:docker-compose.qdrant.yml`).
`scripts/deploy/test-qdrant-policy.sh` already fails on `master` because its fixture does not provide
`REEL_INDEXING_DATABASE_URL` or the private env file the overlay now requires, and `velora-qdrant-policy` still expects the
overlay's `INDEX_VECTOR_*` values to be the `postgres`/`false` pre-cutover ones, whereas the overlay defaults to `qdrant`/`true`.
Both need an explicit decision before the host can use that path.

## Indexer image pinned by the host overlay (2026-11-11)

`index-rollout.yml` on the host pins the indexer image (`velora-reel-indexing-qdrant:6ca1491e`, a build of the 2026-11-03 code), and the deploy
controller re-applies that overlay after every release. So indexing-service code merged after that build is not live until the pin is moved.
Rolled forward on 2026-11-11 to `velora-reel-indexing-qdrant:af7a7c1d`: `docker pull hieucutedangyeu/reel-indexing-service:<full sha>`, tag it
`velora-reel-indexing-qdrant:<short sha>`, edit the `image:` line in the overlay, then
`VELORA_IMAGE_TAG=<full sha> docker compose -f docker-compose.yml -f <overlay> up -d --no-deps --no-build --force-recreate reel-indexing-service reel-indexing-long-service`.
Checked afterwards with `scripts/deploy/ensure-reel-indexing-qdrant --check` (ok), a real re-index (COMPLETED in about 90 seconds) and the bundled
`dist/apps/reel-indexing-service/main.js` (contains the deferred visual retry worker). Rollback: copy the backup
`index-rollout.yml.bak-20261111T095552Z` back over `index-rollout.yml` and run the same compose command; the old image is still on the host.
Each indexing-service change needs the same pin move, or the host moves to the repo overlay as recommended above.
