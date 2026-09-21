# Narto Drama → Velora Scraper

Scrapes series and episode metadata from [narto-drama.com](https://narto-drama.com) sitemaps and imports them into Velora's `ReelSeries` + `Reel` system.

## Prerequisites

```bash
pnpm add fast-xml-parser    # if not already installed
```

## Usage

### Full pipeline (crawl → build → ingest)

```bash
# Dry run — crawl + build only, no DB writes
DRY_RUN=1 node scripts/narto-scraper/index.cjs all

# Full run with DB
CONTENT_DATABASE_URL="postgresql://..." node scripts/narto-scraper/index.cjs all
```

### Individual phases

```bash
# Phase 1: Crawl sitemaps → scraped-data.json
node scripts/narto-scraper/index.cjs crawl

# Phase 2: Group episodes → series-data.json
node scripts/narto-scraper/index.cjs build

# Phase 3: Insert into Velora DB
CONTENT_DATABASE_URL="postgresql://..." node scripts/narto-scraper/index.cjs ingest

# Phase 4: Queue metadata-only indexing (0 bytes R2 storage)
CONTENT_DATABASE_URL="postgresql://..." node scripts/narto-scraper/index.cjs queue-index

# Check DB & indexing stats
CONTENT_DATABASE_URL="postgresql://..." node scripts/narto-scraper/index.cjs stats
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CONTENT_DATABASE_URL` | — | PostgreSQL connection string (required for `ingest`/`stats`/`queue-index`) |
| `CRAWL_CONCURRENCY` | `3` | Max concurrent sitemap fetches |
| `INGEST_BATCH_SIZE` | `50` | Series processed per batch during ingest |
| `MAX_SITEMAPS` | `0` (all) | Limit number of sitemaps to crawl (for testing) |
| `MAX_SERIES` | `0` (all) | Limit number of series to ingest (for testing) |
| `QUEUE_INDEXING` | `0` | Set to `1` during `ingest` to immediately queue indexing |
| `DRY_RUN` | `0` | Set to `1` to skip DB writes |
| `BASE_URL` | `https://narto-drama.com` | Override base URL |

### Quick test (5 sitemaps)

```bash
MAX_SITEMAPS=5 node scripts/narto-scraper/index.cjs crawl
node scripts/narto-scraper/index.cjs build
MAX_SERIES=2 QUEUE_INDEXING=1 node scripts/narto-scraper/index.cjs ingest
```

### Strategy 1: Metadata-Only Indexing (Zero R2 Usage)

By setting `sourceHasAudio: false` on the created `Reel` and `ReelIndexJob`, Velora's `reel-indexing-service` LangGraph workflow selects `route: 'NO_AUDIO'` and `chunkingStrategy: 'metadata-only'`:
- Indexes drama title, episode title, full synopsis, and tags.
- Bypasses audio/video extraction completely.
- Consumes **0 bytes** of Cloudflare R2 storage.
- Enables semantic search and RAG retrieval immediately.
- Dispatched asynchronously via Content Service's Outbox pattern to RabbitMQ.

## Data flow

```
sitemap.xml
  └── episodes/1.xml ... episodes/N.xml
        └── <url> entries with <image:image> + <video:video>
              │
              ▼
        scraped-data.json (flat episode list)
              │
              ▼
        series-data.json (grouped + deduplicated)
              │
              ▼
        Velora DB: ReelSeries + Reel rows
```

## Bot user

All imported content is owned by a dedicated bot user:
- **ID**: `b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7` (configurable via `BOT_USER_ID`)
- This user must exist in the `user-service` database if you want profiles to resolve.

## Deduplication

- Series are deduplicated by `(ownerId, title)` match
- Episodes are deduplicated by `(seriesId, episodeNumber)` unique constraint
- Re-running the scraper safely updates existing records

## Output files

| File | Description |
|------|-------------|
| `scraped-data.json` | Raw crawled episodes (~200k entries) |
| `series-data.json` | Grouped and deduplicated series |
| `checkpoint.json` | Crawl progress state |

These files are gitignored by default (add to `.gitignore` if needed).
