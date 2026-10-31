# One-Reel HLS replacement

This operator path replaces only playback/encoding output. It keeps the Reel ID,
owner, visibility, Series position, source metadata, thumbnail, media/index
attempt IDs, transcripts and evidence/index state. It does not queue reindexing.
Default invocation is offline dry-run. The internal Content RMQ handlers have no
HTTP/gateway route and are disabled unless `REEL_HLS_REPLACEMENT_ENABLED=true`.
Do not enable them or run remote operations without the normal operational approval.

Prepare a local MP4 remuxed from the **current published HLS**, without applying
crop/trim again. Source provenance and identical timeline/framing must be reviewed;
the file hash binds that reviewed input but does not itself prove provenance.
The command deliberately accepts no external source URL or mass-backfill option.
Future imports use the same service encoding profile, FFmpeg adapter and validation.

```sh
# Offline default: no dotenv, broker, storage or provider access.
node scripts/ops/replace-reel-hls.cjs --dry-run

# Local encode/validate; creates a new directory and preparation.json.
node scripts/ops/replace-reel-hls.cjs --prepare \
  --reel-id=ad989463-021e-496d-8345-bc9e91f00a13 \
  --source=/tmp/velora-seek-canary/source.mp4 \
  --output-dir=/tmp/velora-seek-canary/normalized
```

Only after the prepared renditions, keyframe/segment evidence and source timeline
have been reviewed, obtain an explicit snapshot from Content and bind it locally.
Snapshot mode is read-only; it requires the internal feature gate. Snapshot files
contain a source-key hash, never the external source URL or credentials.

```sh
node scripts/ops/replace-reel-hls.cjs --snapshot \
  --reel-id=ad989463-021e-496d-8345-bc9e91f00a13 \
  --snapshot-file=/tmp/velora-seek-canary/snapshot.json
node scripts/ops/replace-reel-hls.cjs --review \
  --artifact=/tmp/velora-seek-canary/normalized/preparation.json \
  --snapshot-file=/tmp/velora-seek-canary/snapshot.json
node scripts/ops/replace-reel-hls.cjs --dry-run \
  --artifact=/tmp/velora-seek-canary/normalized/reviewed.json
```

Inspect `reviewed.json` and use its printed `reviewedSha256` in each following
explicit command. `SHA256_FROM_REVIEW` below must be replaced with that actual
digest. None of these remote operations are part of local validation.

```sh
# Reserve six-hour leases and stage conditional immutable R2 objects; pointer stays intact.
node scripts/ops/replace-reel-hls.cjs --stage \
  --artifact=/tmp/velora-seek-canary/normalized/reviewed.json \
  --reviewed-sha256=SHA256_FROM_REVIEW

# Content hashes every staged object, validates the complete VOD graph, then CAS-applies.
node scripts/ops/replace-reel-hls.cjs --apply \
  --artifact=/tmp/velora-seek-canary/normalized/reviewed.json \
  --reviewed-sha256=SHA256_FROM_REVIEW

# Within six hours of reservation, and only while the applied row version is current.
node scripts/ops/replace-reel-hls.cjs --rollback \
  --artifact=/tmp/velora-seek-canary/normalized/reviewed.json \
  --reviewed-sha256=SHA256_FROM_REVIEW
```

Content serializes replacement operations with a row lock and CAS on the expected
pointer/row version, owner and media/index attempts. Active media/index work,
pending pipeline outbox events, another replacement lease, expired leases,
stale snapshots and changed checksums block cutover. Apply stores the previous
encoding fields and output manifest in the existing outbox event, transactionally
with the pointer. That event retries cache invalidation after crashes or cache
failures; it creates no media or indexing job. Retry is idempotent only while
that operation's version is still current. Rollback uses the server receipt,
checks the prior master remains available and refuses to overwrite a later update.

Existing objects are never deleted or overwritten. Staging can resume after a
partial upload only if existing objects match byte-for-byte. Failed validation
or a lost CAS leaves the previous stream active; retain the reviewed artifact
for investigation. After the rollback lease expires, stop and review a new
operation rather than forcing the old artifact or bypassing the Content fence.
