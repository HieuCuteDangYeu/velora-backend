# Narto Drama Unified Sync & Ingestion Pipeline

All-in-one automation script that discovers new dramas from [narto-drama.com](https://narto-drama.com), scrapes metadata and direct video streams, uploads sliced HLS video segments to TikTok CDN with master playlists stored in Cloudflare R2, and indexes 1024-d vector embeddings (`BAAI/bge-m3`) into Velora's pgvector database for real-time RAG similarity search.

---

## Architecture & Data Flow

```
Narto Drama (Sitemap / Watch Page)
        │
        ▼
   [Discovery]  <── Compares slugs against existing Velora Database
        │
        ▼
   [Ingestion]  ──> content-service (ReelSeries + Reel records)
        │
        ▼
 [HLS & TikTok] ──> FFmpeg 5s slice -> PNG mask spoof -> TikTok CDN (.ts)
        │       ──> Rewritten .m3u8 with byte-ranges -> Cloudflare R2
        │       ──> Updates hlsMasterKey in content DB
        │
        ▼
[TEI Indexing]  ──> Text Embeddings Inference (BAAI/bge-m3 1024-d via SSH tunnel)
                ──> Inserts ReelDocument & ReelChunk in pgvector
                ──> Marks processingStage = 'READY'
```

---

## Prerequisites

1. **Environment Variables**:
   Configured in root `.env`:
   - `CONTENT_DATABASE_URL`: PostgreSQL connection string for `content-service`
   - `REEL_INDEXING_DATABASE_URL`: PostgreSQL connection string for `reel-indexing-service`
   - `TIKTOK_CDN_UPLOAD_ENDPOINT`, `TIKTOK_CDN_CSRF_TOKEN`, `TIKTOK_CDN_UUID`, `TIKTOK_CDN_COOKIE`
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

2. **Self-Hosted TEI SSH Tunnel** (for vector embeddings):
   To generate `BAAI/bge-m3` 1024-d embeddings on homelab hardware without rate limits or API costs:
   ```bash
   ssh -N -L 8088:192.168.97.3:80 velora-homelab
   ```
   _(If the tunnel is not running, the script still ingests and uploads to TikTok CDN, but leaves reels in `INDEX_QUEUED` stage so you can index them whenever convenient)._

---

## Usage

### 1. Automatic Incremental Sync (Discovers New Dramas)

Scans the latest episode sitemaps (highest numbered XML files), diffs them against existing series in Velora, and automatically syncs any brand new dramas end-to-end:

```bash
# Check latest sitemaps and sync new dramas
node scripts/narto-scraper/sync.cjs

# Scan the latest 5 sitemaps with up to 2 new dramas
node scripts/narto-scraper/sync.cjs --sitemaps=5 --max-dramas=2

# Dry-run preview without modifying database or uploading files
node scripts/narto-scraper/sync.cjs --dry-run
```

### 2. Sync a Specific Drama by URL Slug

If you find a specific drama on Narto Drama (e.g. `https://narto-drama.com/detail/watch/the-secret-behind-my-scoundrel-husband/1`):

```bash
node scripts/narto-scraper/sync.cjs --slug=the-secret-behind-my-scoundrel-husband

# Sync only first 5 episodes for testing
node scripts/narto-scraper/sync.cjs --slug=the-secret-behind-my-scoundrel-husband --limit=5
```

### 3. Maintenance & Recovery Modes

#### Enrich Existing HLS Reels with Transcript and Visual Evidence

For reels already stored with an `hlsMasterKey`, preview metadata-only reels
that still need transcript or visual evidence, then queue them through the
normal Content outbox and media/indexing workers. The worker reads the existing
R2 playlist and TikTok CDN segments; it does not rebuild or upload HLS.

```bash
# Preview one eligible reel (default; no work is queued)
pnpm ops:enrich:hls -- --dry-run

# Queue one reel, then inspect worker/indexing status and provider usage
pnpm ops:enrich:hls -- --resume --limit=1

# Resume a specific series in small batches
pnpm ops:enrich:hls -- --resume --series-id=<series-id> --limit=5
```

The command skips reels once both manifests have been persisted, so rerunning
it resumes from the remaining incomplete reels. HLS backfill index jobs fail
closed if any required sampled frame cannot be analyzed; after Cloudflare quota
resets, requeue that Reel's existing manifests with `pnpm ops:reindex:reel -- <reel-id>`.

#### Index Queued Reels

Computes vector embeddings and indexes any existing reels currently sitting in `INDEX_QUEUED` stage:

```bash
node scripts/narto-scraper/sync.cjs --index-queued [--limit=100]
```

#### Migrate Remaining Direct URLs to TikTok CDN

Slices and migrates any existing reels that have external `mediaKey` URLs but no `hlsMasterKey`:

```bash
node scripts/narto-scraper/sync.cjs --migrate-cdn [--limit=50]
```

---

## CLI Options

| Flag              | Default   | Description                                           |
| ----------------- | --------- | ----------------------------------------------------- |
| `--slug=SLUG`     | `null`    | Sync a specific drama by its URL slug                 |
| `--sitemaps=N`    | `2`       | Number of latest episode sitemaps to check            |
| `--all-sitemaps`  | `false`   | Scan all 1,000+ sitemaps on Narto Drama               |
| `--max-dramas=N`  | `0` (all) | Limit number of newly discovered dramas to process    |
| `--limit=N`       | `0` (all) | Limit total episodes to process                       |
| `--concurrency=N` | `3`       | Parallel workers for FFmpeg slicing and TikTok upload |
| `--crop`          | `false`   | Apply FFmpeg watermark crop filter (`iw:ih-110:0:40`) |
| `--index-queued`  | `false`   | Run vector indexing on reels in `INDEX_QUEUED`        |
| `--migrate-cdn`   | `false`   | Run TikTok CDN upload for reels without HLS           |
| `--dry-run`       | `false`   | Preview operations without writing to DB or CDN       |
| `--help`          | —         | Display CLI usage summary                             |
