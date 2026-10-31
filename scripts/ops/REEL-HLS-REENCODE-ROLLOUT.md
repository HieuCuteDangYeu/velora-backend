# Existing Reel re-encoding rollout plan

Status: operator implementation authored, **not executed or verified**, 2026-10-30.
No production media replacement is authorized or executed by this document.
The coordinator reuses the existing [one-Reel replacement](REEL-HLS-REPLACEMENT.md).
The RAG hold below still applies; implementation is not rollout approval.

## Operator interface (after the hold and verification gates clear)

`scripts/ops/reencode-existing-reels.cjs` defaults to an offline dry-run. It loads
no environment, database, broker, storage or encoder in that mode. All operational
invocations select exactly one mode and require `--hold-released`, including
inventory and reconcile. Missing acknowledgement rejects before loading dotenv,
Prisma or storage dependencies, or accessing filesystem inventory state; direct
coordinator calls enforce the same hold. Only dry-run/help are available without
that acknowledgement. The flag acknowledges an actual release by the benchmark
owner; it does not release the hold itself. Inventory uses the installed Content Prisma
client with `CONTENT_DATABASE_URL`; use read-only credentials. Every query runs
in a repeatable-read, read-only transaction. Mutation uses only the reviewed
replacement CLI, its existing gate and existing credentials; no direct database
update or media/index job publication is added.

The following are future operator examples, **not commands run during authoring**:

```sh
node scripts/ops/reencode-existing-reels.cjs
node scripts/ops/reencode-existing-reels.cjs --inventory --run-dir=/private/new-run \
  --hold-released
node scripts/ops/reencode-existing-reels.cjs --prepare --run-dir=/private/new-run \
  --limit=1 --inventory-sha256=REVIEWED_INVENTORY_DIGEST \
  --media-origin=https://PUBLIC_MEDIA_HOST --hold-released
```

Inventory includes every Reel, regardless of visibility, using pages of 100 in
one consistent transaction (60 seconds, at most 100,000 rows). It records an
immutable `inventory.json`, its canonical digest and `progress.json` with private
permissions. No raw source URLs, transcripts, signed values or connection strings
are saved. The protected fingerprint covers every scalar Reel field except the
specific encoding fields the replacement is allowed to change. Live engagement
updates can therefore cause a conservative stale-snapshot stop too. Busy records
are `DEFERRED`, missing HLS is `OUT_OF_SCOPE`, and unsupported metadata/keys are
`BLOCKED`; these never silently count as successful replacements. Source/edit
metadata are fingerprints, never instructions to crop or trim the published video.

Preparation reads the exact inventoried owned master via the explicitly supplied
public media origin, selects the largest declared rendition and reconstructs
its complete MPEG-TS VOD. The materializer reuses `stage-source.cjs` public HTTPS
validation and DNS pinning for every request and redirect. Declared byte ranges
must receive exact HTTP 206/Content-Range/byte counts; implicit offsets require
the same preceding resource. TS packet validation excludes PNG masking bytes
without guessing their length. Unsupported keys/encryption, discontinuities,
initialization maps/fMP4, external audio groups, live playlists and unknown tags
stop preparation. Bounds are 8 master variants, 2,000 segments, 30 seconds per
segment, 600 seconds total, 1 MiB playlists, 64 MiB per segment and 512 MiB source
bytes. Source acquisition/remux has a 15-minute deadline. Local MP4 remuxing has
no crop/trim or external protocols. Decoded frame bytes and normalized frame
timing, full PCM audio, duration, framing, rotation and A/V offsets are compared
before/after remuxing; audio packet timing fills missing HLS stream durations.
The existing `prepareHls` then encodes and fully validates its adaptive output;
additional probes check each rendition's duration/framing/A/V offsets. Preparation
requires 8 GiB available disk; reviewed output is capped at 4 GiB. An unavailable
private delivery origin requires a separately reviewed acquisition extension,
not disabling HTTPS/ownership checks or exposing signed URLs.

Review each retained `REEL_ID/source/provenance.json`, `preparation.json`, and
`reviewed.json`, including visual quality, before approving a batch. Approval is
a private JSON array of at most five `{ "reelId": "UUID", "reviewedSha256":
"DIGEST_FROM_REVIEWED_JSON" }` objects. Its digest is `digest(approval)` exported
by the coordinator (SHA-256 over recursively key-sorted JSON, retaining array
order); it is **not** the hash of pretty-printed file bytes. The same immutable
approval and digest can be used for stage and apply. No command generates or
implicitly approves that operator decision.

```sh
node scripts/ops/reencode-existing-reels.cjs --stage --run-dir=/private/new-run \
  --limit=1 --approval-file=/private/approved-batch.json \
  --reviewed-sha256=REVIEWED_APPROVAL_DIGEST --hold-released
node scripts/ops/reencode-existing-reels.cjs --apply --run-dir=/private/new-run \
  --limit=1 --approval-file=/private/approved-batch.json \
  --reviewed-sha256=REVIEWED_APPROVAL_DIGEST --hold-released
node scripts/ops/reencode-existing-reels.cjs --reconcile \
  --run-dir=/private/new-run --limit=1 --hold-released
```

The limit is mandatory, 1–5, and operations are strictly sequential. Begin with
one canary; use five only after acceptance. Preparation happens before reservation.
Each stage/apply subprocess is bounded to 15 minutes and records intent before
starting. Remote object reconciliation has a 15-minute deadline and 60-second
per-object requests. After timeout/crash, run explicit reconciliation: read the
live row, owned pointer, attempts, pending pipeline outbox, lease and exact
Content receipt, and verify every existing remote object against reviewed bytes
and hashes. A complete reserved graph becomes `STAGED`; a partial but matching
graph becomes `RESERVED` and can be staged again using immutable conditional puts.
A committed apply with exact receipt/pointer/version becomes `APPLIED` or
`APPLIED_CACHE_PENDING`; neither retries the cutover. Missing/mismatched receipts,
unknown storage responses, expired leases, rollback receipts and changed rows
stop the batch. `--reconcile` keeps a durable cursor so successive bounded calls
visit the inventory, then start another sweep. It needs storage read credentials
when an attempt exists; it performs no remote writes. Its database and object
reads still require the hold to be released.

Files are atomically replaced with fsync and mode 0600 under mode 0700 run
directories. A `wx` lock rejects concurrent invocations. A process killed before
cleanup leaves `operator.lock`: establish that the process and all children have
exited and inspect live state before removing that lock manually. Completed source
and preparation artifacts can resume with hash/validation checks. Interrupted,
incomplete encode directories and stale/expired plans require operator review and
a new preparation/run; they are never silently removed or overwritten. Receipts
and old media remain available to the existing one-Reel rollback command, subject
to its live-version and lease checks. Re-staging a confirmed partial reservation
uses the existing reservation behavior, which renews its six-hour lease; never
use this to bypass an already expired lease.

The coordinator counts prepared/staged/applied and unresolved records and always
returns `complete: false`: public playback, visual/device acceptance, cache
delivery, protected/index evidence and a fresh whole-library inventory still
need operator acceptance. It does not infer `ALREADY_COMPLIANT` from database
encoding metadata; compliant-profile auditing and exemption require independent
media evidence before selecting a rollout inventory. It does not manufacture a
`VERIFIED` outcome. Compare subsequent inventories by Reel ID and receipts, and
report any new/deferred/blocked records explicitly. Automatic visual acceptance,
garbage collection, chat URL rewrites and semantic-index rebuilding are excluded.

Focused tests authored (not run during this dispatch):

```sh
node --test scripts/narto-scraper/materialize-existing-hls.test.cjs \
  scripts/ops/reencode-existing-reels.test.cjs
```

These use mocked downloads, subprocesses and Content/storage state; they do not
start FFmpeg or contact providers. After benchmark finalization, the coordinator
must authorize isolated test execution, synthetic FFmpeg/ffprobe validation,
disposable SQL/storage concurrency checks and independent review before rollout.

## Outcome and scope

Bring every eligible Reel in a recorded inventory onto the established adaptive
encoding profile, without rebuilding its semantic index. This means new encoded
segments and playlists, followed by a guarded playback-pointer update. Changing
playlist URLs alone cannot repair the original keyframe spacing.

Inventory every current Reel, including private Reels under operator authority.
Classify each as needing replacement, already compliant, temporarily deferred,
blocked, or outside the playable-media scope. Deleted records are not recreated;
missing/unreadable media and unfinished indexing are reported, not silently
counted as upgraded. Already-compliant encoding needs media evidence, not merely
an `encodedMaxHeight` or rendition-count value. Preserve valid existing profiles
rather than forcing every Reel through another lossy encode.

There is no schema migration and no new indexing job. Preserve the Reel ID,
owner, access rules, Series position, social relations, source/edit metadata,
thumbnail, transcript/VTT/segments, audio and visual evidence manifests, media
and index attempt IDs, and every index status/version/count/provider field.
The replacement updates playback/encoding fields and `updatedAt`, and writes
existing lease/outbox records. These changes are observable to consumers.

## RAG testing hold

Read-only checkpoint at 2026-10-30 15:49 UTC, in
`.benchmarks/rag-remediation-v8-20261027-01/evaluation-6d398087-candidate-20261030-02/`:

- Candidate: `COMPLETE`, 400/400 cases `COMPLETED`.
- Reused baseline: `COMPLETE_WITH_EXECUTION_FAILURES`, 368 completed, 32 failed.
- Post-primary: `RUNNING_SEMANTIC_JUDGE`, phase `candidate`.
- Live boundary: `NOT_RUN`.
- The local post-primary supervisor process was present. This does not prove
  provider progress or benchmark success.

The frozen runner uses fixture ports, but the post-primary supervisor still
performs live retrieval/ACL checks and pins deployed Gateway, Content and AI
image revisions. Index preservation alone does not establish zero benchmark
impact: deploying Content changes those revisions; replacement changes playback
paths, row versions, caches and shared resource use.

Until the benchmark owner releases the hold:

1. Allow planning, explicitly authorized source/tests/docs edits, and read-only
   local artifact inspection only. Do not run tests, builds, FFmpeg/ffprobe,
   inventory, preparation, staging, apply or reconciliation. Database, Content,
   object-storage and provider reads are also prohibited, including read-only
   inventory/reconcile operations. Do not supply `--hold-released` while the
   post-primary process waits for Langfuse billing proof. Preserve dependencies,
   environment, fixtures, compiled runtime and benchmark artifacts.
2. Do not deploy/restart services, enable the replacement feature, reserve leases,
   upload replacement objects, change production pointers, invalidate caches, or
   launch media/index jobs for this rollout.
3. Do not rerun completed benchmark cases, reconcile in-flight cases by guessing,
   invoke extra providers/judges, or alter the RAG run to accelerate media work.

Release requires the current run's remaining live checks and reporting to settle,
its evidence to be sealed, and its owner to confirm no more tests depend on that
environment. A successful quality verdict is not the only possible terminal
outcome; an explicitly archived/abandoned run can release the hold too. A pause,
quota wait, halted process, or completed primary cohort alone cannot release it.
Recheck current evidence at execution time; this checkpoint will become stale.

## Implementation sequence

### 1. Inventory and implementation checks

- Add one small operator coordinator and focused tests alongside
  `replace-reel-hls.cjs`. Its default invocation is offline and makes no
  connections; inventory/network/write phases must be explicitly selected and
  reject conflicting operation flags.
- After the hold is released, reuse the existing Content Prisma operator pattern
  for explicitly requested, read-only, cursor-paginated inventory. Require
  `--hold-released` for every operational mode before loading production
  dependencies or accessing inventory state. Restrict credentials to reads for
  this phase. All writes remain behind the existing Content replacement handlers.
- Freeze a private run manifest with inventory time, Reel IDs, current master
  keys, row versions, source-key hashes and media/index attempts. Store per-Reel
  protected-field fingerprints and record eligibility and exclusion reasons.
  Never write raw external source URLs, signed CDN URLs or credentials to logs.
- Keep the current uncommitted media work and unrelated edits intact. Workers
  must use a checkout that contains the exact implementation; a fresh worktree
  does not inherit it. Use explicit medium effort for focused implementation and
  tests; use high only if concurrency review warrants it. Never inherit max.

### 2. Materialize the current published video

The existing replacement accepts a local MP4. The current direct-MP4 downloader
does not reconstruct published HLS; bulk source acquisition still needs work.

- Add a bounded HLS materializer with tests. Read the exact current owned master,
  select a suitable source rendition, and download its complete VOD segment set.
  Reuse the downloader's HTTPS/DNS protections for each remote request/redirect.
- Support ordinary segments and existing TikTok byte-range playlists correctly:
  respect each declared offset/length, validate range responses and segment
  bytes, and do not feed PNG masking bytes into the decoder. Do not assume a
  hardcoded prefix length in place of the manifest's byte-range declaration.
- Bound redirects, playlists, segment counts, response sizes, total bytes,
  timeouts and disk use. Reject unsupported encryption, discontinuities or
  formats until handled explicitly; do not bypass validation for coverage.
- Build a local, network-free playlist and remux to MP4 without another crop or
  trim. Record source provenance and hashes privately. Verify duration, start
  offset, orientation/framing, audio synchronization and samples at indexed
  timestamps against the currently published video. A file hash alone cannot
  establish that these match.

### 3. Prepare and independently verify

- Call the existing `prepareHls`/replacement preparation path. Reuse the profile
  selector, FFmpeg adapter and validators; do not add a second encoding ladder.
  Keyframe/segment targets follow the established profile for that Reel's length.
- Default to one encoder and one Reel operation at a time on separate capacity.
  Reserve enough disk/storage for source, new renditions and retained old files.
- Validate the complete output graph, every object hash, segment independence,
  keyframe gaps, dimensions, timeline agreement, audio and full decode. Review
  visual quality before publication.
- Extend focused tests for ranged source acquisition, default no-side-effects,
  stable inventory/resume, duplicate invocation, stale snapshots, interrupted
  apply reconciliation, protected-field preservation and conflicting flags.
  Use disposable SQL/storage fixtures for failures and concurrency; do not use
  production RAG requests as test traffic.
- Have an independent reviewer verify the diff and evidence before rollout.
  Use Orca's implementation -> verification -> independent review -> gate flow.
  Tests/builds must have isolated output and must not overwrite RAG runtime files.

### 4. Release one canary after the RAG hold clears

- Confirm deployed operator/profile versions, storage capacity and the explicit
  approved inventory. Deploy/enable the minimum required services only after
  the RAG environment has been released and operational authorization exists.
- The implemented replacement stores new self-contained HLS objects in R2;
  current TikTok segment URLs and old media objects remain intact. This changes
  where playback bytes are served, so estimate library-wide storage and delivery
  cost before approval. Do not silently change this to TikTok uploads.
- Choose one affected Reel. Prepare first, then obtain a fresh Content snapshot,
  review its digest, reserve/stage immutable objects and apply using the existing
  row lock, compare-and-swap, lease and full artifact validation.
- Check playback via the normal public delivery path, seeking on Android,
  protected Content fields, index identity/counts/fingerprints and cache refresh.
  Leave iOS runtime explicitly unverified until an iOS device is available.
- Retain the rollback receipt. The existing rollback window is six hours from
  reservation, requires the applied row to remain current, and checks the old
  master. Separately verify old segments; master availability alone is not
  proof that all prior external segments remain playable.

### 5. Resume in bounded batches until coverage is complete

- After canary acceptance, expand from one Reel to batches of five, then larger
  batches only if resource and playback evidence justify it. Keep one operation
  active at a time initially; a batch is a checkpoint boundary, not parallelism.
- Track `PENDING -> PREPARED -> STAGED -> APPLIED -> VERIFIED` per Reel, with
  explicit `ALREADY_COMPLIANT`, `DEFERRED` and `BLOCKED` outcomes. Persist each
  transition atomically and retain the artifact digest and server receipt.
- Prepare before reserving. Obtain a fresh snapshot per cutover and perform
  stage/apply/verification within that Reel's six-hour lease; do not reserve
  the entire library at once.
- On restart or timeout, reconcile the actual pointer, receipt and object hashes
  before retrying. Resume valid preparations/staging; never reset attempts or
  blindly repeat an uncertain apply. Expired leases require a new reviewed plan.
- Revisit temporarily busy Reels after their existing work settles. Ownership,
  source or row changes require re-review; do not overwrite newer state to make
  the batch finish. Do not use the enrichment/reindex pipeline for this task.
- Stop new cutovers on media-validation failure, unexpected index/evidence
  changes, unreconciled writes, storage limits, sustained service degradation,
  or a new benchmark hold. Use the bounded rollback where eligible; preserve
  failures for review rather than deleting evidence or old media.
- Preserve existing chat messages and their saved URLs. They may keep playing
  the retained older encoding; upgrading saved message URLs is separate scope.

### 6. Reconcile the whole inventory

- Ensure future imports use the deployed fixed encoder, then perform another
  bounded inventory sweep to catch legacy Reels arriving during the initial scan.
- Reconcile the original and subsequent inventory counts: verified replacements,
  already-compliant media, explicitly excluded records and every unresolved Reel.
  Provide a private per-Reel report with old/new keys, verification evidence,
  protected-field checks, rollback status and failure reasons.
- Claim full eligible-library completion only when no eligible Reel remains
  pending, deferred or blocked and every applied replacement is verified. If
  unavailable media prevents this, report partial completion and the exact list;
  do not declare the whole database updated.
- Verify semantic index identities/content remain unchanged using authorized
  read-only evidence, without rerunning the sealed benchmark or overwriting its
  results. Any later live RAG comparison uses a separately identified run.
- Disable the temporary replacement gate after the rollout. Retain old media
  and receipts; garbage collection is a later separately reviewed operation.

## Completion evidence and present limits

Record coverage counts, media-validation results, protected-field/index checks,
service-health observations, storage use and device evidence separately. No
library count, duration estimate, storage budget, production cutover, live CDN
validation, iOS proof or zero-impact operational guarantee has been established
by this planning pass. The plan avoids changing the current RAG test environment
by sequencing the production rollout after its hold is explicitly released.
