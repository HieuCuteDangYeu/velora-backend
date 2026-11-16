# Reel pipeline capacity (measured 2026-11-16)

What limits how many reels can be published and indexed, how it was measured, and which knob to turn.
Numbers come from `scripts/ops/reel-integration-load.cjs` (through the gateway, real 106 s episodes) and
`scripts/ops/reel-create-burst.cjs` (below the gateway, synthetic users). Both create private reels
titled `[IT:<run>] ...`; clean up with their own `cleanup` mode, never with `purge-content-reels.cjs`.
Do not run them while a model benchmark is using the same machines.

## Measured

| Scenario | Result |
|---|---|
| 12 simultaneous `content.create_reel` | 12/12 ok, p50 2.8 s, max 4.5 s (1 DB connection and a 2 s wait: 9 of 12 failed) |
| One 106 s reel, alone | 215 s: media 97 s, index 117 s |
| 4 concurrent 106 s reels, 1 short media consumer | 710-870 s |
| 4 concurrent 106 s reels, 2 short media consumers | 429-510 s |
| One 708 s reel | 1,347 s |
| Short worker killed mid-encode | redelivered, completed 3 min after the kill, DLQ stayed 0 |

One media worker handles roughly 30 short reels per hour. Adding a consumer scales the media stage
almost linearly; indexing then becomes the limit.

## Where the time goes and what limits it

1. **Media transcode CPU.** The HLS encode is x264 on three renditions (360p, 540p, 720p). CPU seconds for
   a 96 s 1080x1920 clip, same settings otherwise:

   | Preset | Renditions | CPU seconds | vs `faster` x3 | SSIM (540p) |
   |---|---|---|---|---|
   | faster (old default) | 3 | 322 | - | 0.9060 |
   | veryfast (new default) | 3 | 220 | -32% | 0.9057 |
   | superfast | 3 | 137 | -58% | 0.9039 |
   | faster | 2 | 155 | -52% | not measured |
   | veryfast | 2 | 111 | -66% | not measured |

   Size is set by the bitrate targets, so presets barely change it (59 MB for the 3-rendition ladder).
   The clip was a looped 6 s sample; use real content before trusting the absolute figures. Since
   2026-11-16 the homelab `.env` and the laptop `media.env` both set `MEDIA_HLS_X264_PRESET=veryfast`
   (keep them equal, see `LAPTOP-MEDIA-WORKER.md`).
   `MEDIA_HLS_MAX_VARIANTS=2` is the next lever and drops the 720p rendition.
2. **Stream validation.** It checked every HLS object with its own request, one after another. A
   96 s reel has 151 objects, so on R2 (0.2-0.3 s per call) it took 39 s with the old code (laptop) and
   9 s with storage keys checked 16 at a time (homelab). 6 s clips only have ~19 objects, which is why
   they showed a steady 4.6-5.3 s either way.
   Reels whose segments are on the TikTok CDN are different: their 147 URLs took 36 s when checked
   one by one (0.25-0.5 s each on a cold CDN edge), and four parallel requests once got a TLS
   "internal error" back, which would count as a missing segment. The upload API already confirms each
   segment (code 0 and a URL), so CDN URLs are now spot-checked, six per rendition (first, last and
   evenly spaced), one at a time; R2 objects are still checked in full (decision of 2026-11-16).
   Change `CDN_SEGMENT_SAMPLE_SIZE` in `validate-reel-stream.use-case.ts` to check more.
3. **Groq vision, a daily token budget.** See below.
4. **Embedding service.** TEI answers 429 above `TEI_EMBEDDING_MAX_CONCURRENT_REQUESTS` (8); ai-service
   retries with backoff (`AI_EMBEDDING_OVERLOAD_RETRIES`, default 4).
5. **Shared Postgres connections.** See below.
6. **TikTok CDN.** Uploads were all rejected (error 40102) until the session credentials were
   refreshed, and jobs fell back to R2 instantly. With a valid session, three runs of a 96 s reel on
   the homelab gave: a hang (the upload request had no timeout, three connections sat idle and the
   worker, which takes one job at a time, was lost to the lane), a stalled segment that fell back to
   R2 after the 20 s timeout (upload stage 47 s), and a clean upload of 151 segments in 24 s. Each
   request now times out after 20 s (`TIKTOK_CDN_REQUEST_TIMEOUT_MS`) and the whole CDN upload has
   120 s (`TIKTOK_CDN_UPLOAD_BUDGET_MS`), after which the job falls back to R2. A healthy CDN answers a
   150 KB upload in 0.3-0.5 s. Stalls appear intermittently, possibly tied to the 3 parallel uploads;
   not established. The keep-alive job logs `TikTok CDN session keep-alive failed` when the session
   dies again; watch for it.

## Groq vision budget

Each Groq organization has 200,000 tokens/day for `qwen/qwen3.8-27b`, and one frame request costs
about 2,400-2,500 tokens (from the `Requested` figure in the 429 text). That is about 80 frames per
organization per day. `GroqKeyPool` tracks exhaustion per key and rotates, so the daily capacity is
the number of **distinct organizations** among `GROQ_VISION_API_KEYS`, not the number of keys.

```text
frames per day  = distinct orgs x 200,000 / 2,450
reels per day   = frames per day / frames per reel
frames per reel = min(MEDIA_VISUAL_MAX_FRAMES (24), duration / 4 s + scene changes)
```

With the 16 vision keys configured on 2026-11-16, if each key is its own organization: about 1,300
frames per day, i.e. about 54 reels of 96 s or longer, or about 650 reels of 6 s (2 frames). If some
keys share an organization the figure is lower. Skipped frames are retried by the deferred visual
retry worker. To stretch the budget: lower `MEDIA_VISUAL_MAX_FRAMES` (12 halves the cost), raise
`MEDIA_VISUAL_PERIODIC_INTERVAL_SECONDS` (4 to 8 s), add organizations, or configure the vision
fallback provider. Evaluation runs and tests draw from the same budget.

## Postgres connection budget (Aiven)

The Aiven instance allows 20 connections with 3 reserved, so 17 usable, shared by the content, user,
auth, AI and friend databases plus the provider's agent. Idle baseline was 8-9 before 2026-11-16;
content-service now holds 6 (two Prisma clients with 3 each, `CONTENT_DB_POOL_SIZE`), total 12 of 17.
Every additional service replica adds its pool, so replicas or larger pools run into this limit before
CPU does. Before scaling out, add a connection pooler (PgBouncer in transaction mode) or move to a
larger plan; `CONTENT_DB_POOL_SIZE=2` is the quick way to give connections back. The peak during a
burst has not been measured.

## Scaling the media stage

- Another consumer on `reel_media_short_jobs` or `reel_media_long_jobs` is all it takes: RabbitMQ
  hands each job to whichever consumer is free (prefetch 1). See `LAPTOP-MEDIA-WORKER.md`.
- Which lane a job takes depends on `clientObservedDurationMs`; a publish without it is queued as
  LONG.
- Watch the Grafana dashboard "Velora / Reel Pipeline": media and index backlog, jobs in flight,
  consumers per queue, dead-letter depth and publish-to-ready p95.

## Not covered yet

Feed, playback and HLS read load; AI chat under load; more than 12 simultaneous creates; a multi-hour
soak; homelab memory under parallel transcodes; Aiven connection peak during a burst.
