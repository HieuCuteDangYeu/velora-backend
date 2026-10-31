#!/usr/bin/env node

/**
 * sync.cjs - Unified Narto Drama Ingestion, TikTok CDN Slicing & Vector Indexing Pipeline
 *
 * Capabilities:
 *  - Discovers new dramas from the latest Narto Drama sitemaps or by specific slug
 *  - Extracts direct high-resolution video streams & thumbnails from watch pages
 *  - Upserts series and episode records into Velora's content-service database
 *  - Slices videos into HLS segments with FFmpeg, masks PNG headers, and uploads to TikTok CDN
 *  - Uploads master .m3u8 playlists to Cloudflare R2 and updates hlsMasterKey
 *  - Generates 1024-d BAAI/bge-m3 vector embeddings via self-hosted TEI and indexes into pgvector
 *  - Updates processingStage to 'READY'
 *
 * Usage:
 *  node scripts/narto-scraper/sync.cjs [--slug=drama-slug] [--sitemaps=2] [--concurrency=3] [--limit=10] [--dry-run]
 *  node scripts/narto-scraper/sync.cjs --index-queued [--limit=100]
 *  node scripts/narto-scraper/sync.cjs --migrate-cdn [--limit=100]
 */

'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const os = require('node:os');
const { prepareHls } = require('./hls.cjs');
const { stageSource } = require('./stage-source.cjs');
const { publishImportedHls, s3Storage } = require('./publish-hls.cjs');
const { ConfigService } = require('@nestjs/config');
const {
  TikTokCdnService,
} = require('../../apps/media-processing-service/src/infrastructure/services/tiktok-cdn.service.ts');
const { XMLParser } = require('fast-xml-parser');
const { PrismaClient: ContentPrisma } = require('@prisma/content-client');
const {
  PrismaClient: IndexPrisma,
  Prisma,
} = require('@prisma/reel-indexing-client');
const { S3Client } = require('@aws-sdk/client-s3');

// Constants & Credentials
const BOT_USER_ID =
  process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';
const TEI_EMBED_URL =
  process.env.TEI_EMBEDDING_URL || 'http://localhost:8088/embed';
const TEI_INFO_URL = TEI_EMBED_URL.replace(/\/embed$/, '/info');

// XML parser for sitemaps
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  isArray: (name) => ['url', 'sitemap'].includes(name),
});

// Configure Prisma clients with connection limits
const contentDbUrl = new URL(process.env.CONTENT_DATABASE_URL);
contentDbUrl.searchParams.set('connection_limit', '2');
const contentPrisma = new ContentPrisma({
  datasources: { db: { url: contentDbUrl.toString() } },
});

let indexPrisma = null;
if (process.env.REEL_INDEXING_DATABASE_URL) {
  const indexDbUrl = new URL(process.env.REEL_INDEXING_DATABASE_URL);
  indexDbUrl.searchParams.set('connection_limit', '2');
  indexPrisma = new IndexPrisma({
    datasources: { db: { url: indexDbUrl.toString() } },
  });
}

// Cloudflare R2 S3 Client
const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

// CLI Options Parser
function parseOptions() {
  const args = process.argv.slice(2);
  const opts = {
    slug: null,
    lang: 'en-US',
    sitemaps: 2,
    allSitemaps: false,
    maxDramas: 0,
    concurrency: 3,
    limit: 0,
    crop: false,
    indexQueuedOnly: false,
    migrateCdnOnly: false,
    dryRun: false,
    help: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--slug=')) opts.slug = arg.split('=')[1].trim();
    else if (arg.startsWith('--lang=')) opts.lang = arg.split('=')[1].trim();
    else if (arg.startsWith('--sitemaps='))
      opts.sitemaps = parseInt(arg.split('=')[1], 10);
    else if (arg === '--all-sitemaps') opts.allSitemaps = true;
    else if (arg.startsWith('--max-dramas='))
      opts.maxDramas = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--concurrency='))
      opts.concurrency = parseInt(arg.split('=')[1], 10);
    else if (arg.startsWith('--limit='))
      opts.limit = parseInt(arg.split('=')[1], 10);
    else if (arg === '--crop') opts.crop = true;
    else if (arg === '--index-queued') opts.indexQueuedOnly = true;
    else if (arg === '--migrate-cdn') opts.migrateCdnOnly = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

// HTTP Helper with redirect following and timeout
function fetchUrl(url, maxRedirects = 5, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (maxRedirects === 0)
      return reject(new Error(`Too many redirects for ${url}`));

    const protocol = url.startsWith('https') ? https : http;
    const req = protocol.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        },
        timeout: timeoutMs,
      },
      (res) => {
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          const redirectUrl = new URL(res.headers.location, url).href;
          return fetchUrl(redirectUrl, maxRedirects - 1, timeoutMs)
            .then(resolve)
            .catch(reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
    req.on('error', reject);
  });
}

// Check if TEI embedding service is available
async function checkTeiAvailability() {
  try {
    const res = await fetch(TEI_INFO_URL, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const info = await res.json();
      return { available: true, model: info.model_id || 'BAAI/bge-m3' };
    }
  } catch {}
  return { available: false, model: null };
}

// Fetch embeddings in safe sub-batches with exponential backoff
async function getEmbeddings(texts) {
  const SUB_BATCH = 2;
  const results = [];

  for (let i = 0; i < texts.length; i += SUB_BATCH) {
    const chunk = texts.slice(i, i + SUB_BATCH);
    let success = false;

    for (let retry = 0; retry < 6; retry++) {
      try {
        const res = await fetch(TEI_EMBED_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ inputs: chunk }),
        });

        if (res.ok) {
          const data = await res.json();
          results.push(...data);
          success = true;
          break;
        }

        if (res.status === 429) {
          await new Promise((r) => setTimeout(r, 600 * (retry + 1)));
          continue;
        }
        const errorText = await res.text();
        throw new Error(`TEI error (${res.status}): ${errorText}`);
      } catch (err) {
        if (retry < 5) {
          await new Promise((r) => setTimeout(r, 600 * (retry + 1)));
          continue;
        }
        throw err;
      }
    }
    if (!success)
      throw new Error('TEI embedding generation failed after retries');
  }
  return results;
}

// Normalize imports through the service profile, then publish an immutable validated version.
async function transcodeAndUploadToTikTokCdn(reel, options) {
  if (options.dryRun) {
    console.log(`[DRY-RUN] Normalize and upload Reel ${reel.id}`);
    return;
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-sync-hls-'));
  const startTime = Date.now();
  try {
    const source = path.join(workDir, 'source.mp4');
    const outputDir = path.join(workDir, 'hls');
    await stageSource(reel.mediaKey, source);
    const prepared = await prepareHls({
      source,
      outputDir,
      crop: options.crop,
    });
    const hlsMasterKey = await publishImportedHls({
      reel,
      prepared,
      outputDir,
      db: contentPrisma,
      storage: s3Storage(s3Client, process.env.R2_BUCKET_NAME),
      cdn: new TikTokCdnService(new ConfigService()),
    });
    console.log(
      `  [CDN OK] Reel ${reel.id} -> ${hlsMasterKey} (${((Date.now() - startTime) / 1000).toFixed(1)}s)`,
    );
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

// Generate TEI embeddings and index into pgvector
async function indexReelsMetadata(reels, options) {
  if (!reels || reels.length === 0) return;
  if (!indexPrisma) {
    console.warn(
      '[WARN] REEL_INDEXING_DATABASE_URL not configured. Skipping vector indexing.',
    );
    return;
  }

  const teiHealth = await checkTeiAvailability();
  if (!teiHealth.available) {
    console.warn(
      '[WARN] TEI embedding service not reachable at ' + TEI_EMBED_URL,
    );
    console.warn('       Run: ssh -N -L 8088:192.168.97.3:80 velora-homelab');
    console.warn('       Reels remain in INDEX_QUEUED stage.');
    return;
  }

  const texts = reels.map((r) => {
    const title = (r.title || '').trim();
    const description = (r.description || '').trim();
    const tags = Array.isArray(r.tags) ? r.tags.join(' ') : '';
    return `${title}\n${description}\n${tags}`.trim();
  });

  console.log(`  Computing TEI embeddings for ${reels.length} reels...`);
  const embeddings = await getEmbeddings(texts);

  const reelIds = reels.map((r) => r.id);
  const attemptRows = [];
  const docRows = [];
  const chunkRows = [];

  for (let i = 0; i < reels.length; i++) {
    const reel = reels[i];
    const retrievalText = texts[i];
    const attemptId = reel.indexAttemptId || crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const docId = `reel:${reel.id}`;
    const chunkId = `reel:${reel.id}:chunk:0`;
    const retrievalHash = crypto
      .createHash('sha256')
      .update(retrievalText)
      .digest('hex');
    const inputHash = crypto
      .createHash('sha256')
      .update(`self-hosted-tei:BAAI/bge-m3:1024:bge-m3-tei-v1:${retrievalText}`)
      .digest('hex');
    const tokenCount = Math.ceil(retrievalText.split(/\s+/).length * 1.3);
    const tags = Array.isArray(reel.tags) ? reel.tags : [];
    const durationMs = reel.sourceDurationMs || 60000;
    const orientation = reel.sourceOrientation || 'PORTRAIT';
    const lengthClass = reel.sourceLengthClass || 'SHORT';
    const vectorStr = `[${embeddings[i].join(',')}]`;

    attemptRows.push({
      indexAttemptId: attemptId,
      jobId,
      reelId: reel.id,
      mediaAttemptId: reel.mediaAttemptId || attemptId,
      indexVersion: 'durable-index-v1',
      status: 'COMPLETED',
      stage: 'PERSISTING',
      extractedMetadata: {
        title: reel.title,
        description: reel.description,
        tags,
      },
    });

    docRows.push(Prisma.sql`(
      ${crypto.randomUUID()}, ${docId}, ${reel.id}, ${attemptId}, true, false,
      ${reel.userId}, NULL, 0, ${reel.title}, ${reel.description},
      NULL, ${retrievalText}, NULL,
      ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], NULL,
      ${retrievalHash}, 'METADATA_ONLY'::"EvidenceQuality", NULL, 'metadata-only-v1',
      ${tokenCount}, ${tags}::text[], NULL, NULL, ${durationMs},
      ${orientation}, ${lengthClass}, ${vectorStr}::vector, 'self-hosted-tei',
      'BAAI/bge-m3', 1024, 'bge-m3-tei-v1', ${inputHash},
      'durable-index-v1', 'metadata-only-v1', 'metadata-only-v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`);

    chunkRows.push(Prisma.sql`(
      ${crypto.randomUUID()}, ${chunkId}, ${reel.id}, ${attemptId}, true, false,
      ${reel.userId}, ${docId}, 0, ${reel.title}, ${reel.description},
      NULL, ${retrievalText}, NULL,
      ARRAY[]::text[], ARRAY[]::text[], ARRAY[]::text[], NULL,
      ${retrievalHash}, 'METADATA_ONLY'::"EvidenceQuality", NULL, 'metadata-only-v1',
      ${tokenCount}, ${tags}::text[], 0, ${durationMs / 1000}, ${durationMs},
      ${orientation}, ${lengthClass}, ${vectorStr}::vector, 'self-hosted-tei',
      'BAAI/bge-m3', 1024, 'bge-m3-tei-v1', ${inputHash},
      'durable-index-v1', 'metadata-only-v1', 'metadata-only-v1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`);
  }

  // Persist to indexing DB
  await indexPrisma.indexingAttempt.createMany({
    data: attemptRows,
    skipDuplicates: true,
  });
  await indexPrisma.reelDocument.deleteMany({
    where: { reelId: { in: reelIds } },
  });
  await indexPrisma.reelChunk.deleteMany({
    where: { reelId: { in: reelIds } },
  });

  await indexPrisma.$executeRaw`
    INSERT INTO "ReelDocument" (
      "rowId", "id", "reelId", "indexAttemptId", "isActive", "isLegacyImport", "userId", "parentId", "ordinal",
      "title", "description", "evidenceText", "retrievalText", "derivedSummary",
      "sourceSectionIds", "sourceSegmentIds", "sourceAudioArtifactIds", "evidenceHash",
      "retrievalHash", "evidenceQuality", "transcriptVersion", "sectioningVersion",
      "tokenCount", "tags", "startTime", "endTime", "sourceDurationMs",
      "sourceOrientation", "sourceLengthClass", "embedding", "embeddingProvider",
      "embeddingModel", "embeddingDimensions", "embeddingVersion", "embeddingInputHash",
      "indexVersion", "chunkingVersion", "summaryVersion", "createdAt", "updatedAt"
    ) VALUES ${Prisma.join(docRows, ',')}
  `;

  await indexPrisma.$executeRaw`
    INSERT INTO "ReelChunk" (
      "rowId", "id", "reelId", "indexAttemptId", "isActive", "isLegacyImport", "userId", "parentId", "ordinal",
      "title", "description", "evidenceText", "retrievalText", "derivedSummary",
      "sourceSectionIds", "sourceSegmentIds", "sourceAudioArtifactIds", "evidenceHash",
      "retrievalHash", "evidenceQuality", "transcriptVersion", "sectioningVersion",
      "tokenCount", "tags", "startTime", "endTime", "sourceDurationMs",
      "sourceOrientation", "sourceLengthClass", "embedding", "embeddingProvider",
      "embeddingModel", "embeddingDimensions", "embeddingVersion", "embeddingInputHash",
      "indexVersion", "chunkingVersion", "summaryVersion", "createdAt", "updatedAt"
    ) VALUES ${Prisma.join(chunkRows, ',')}
  `;

  // Mark READY in content-service DB
  await contentPrisma.reel.updateMany({
    where: { id: { in: reelIds } },
    data: {
      processingStage: 'READY',
      indexStatus: 'COMPLETED',
      indexDocumentCount: 1,
      indexSectionCount: 0,
      indexChunkCount: 1,
      indexEmbeddingProvider: 'self-hosted-tei',
      indexEmbeddingModel: 'BAAI/bge-m3',
      indexEmbeddingDimensions: 1024,
      indexEmbeddingVersion: 'bge-m3-tei-v1',
      indexCompletedAt: new Date(),
    },
  });

  console.log(
    `  [INDEX OK] Indexed ${reels.length} reels into pgvector & marked READY`,
  );
}

function decodeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&#039;|&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

// Scrapes a single drama series by slug directly from watch page
async function fetchDramaDetails(slug, lang = 'en-US') {
  const watchUrl = `https://narto-drama.com/detail/watch/${slug}/1?lang=${lang}`;
  const html = await fetchUrl(watchUrl);

  const match = html.match(/const\s+episodeItemsRaw\s*=\s*(\[.*?\]);/s);
  if (!match) throw new Error(`Could not find episodeItemsRaw on ${watchUrl}`);

  const episodeItems = JSON.parse(match[1]);

  let title = slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  if (titleMatch) {
    title = decodeHtml(
      titleMatch[1].replace(/\s*Episode\s*\d+.*$/i, '').trim(),
    );
  }

  let description = '';
  const descMatch = html.match(
    /<meta\s+name="description"\s+content="([^"]+)"/i,
  );
  if (descMatch) {
    description = decodeHtml(
      descMatch[1]
        // Strip "Episode N/total — " or "Episode N — " prefix Narto injects
        .replace(/^Episode\s+\d+\/\d+\s*[—\-–]\s*/i, '')
        .replace(/^Episode\s+\d+\s*[—\-–]\s*/i, '')
        // Strip trailing "Narto Drama - ..." attribution
        .replace(/\s*Narto Drama - .*$/i, '')
        .trim(),
    );
  }

  let posterUrl = '';
  if (episodeItems[0]?.thumb_url) {
    posterUrl = episodeItems[0].thumb_url.startsWith('http')
      ? episodeItems[0].thumb_url
      : `https://narto-drama.com${episodeItems[0].thumb_url}`;
  }

  return { slug, title, description, posterUrl, episodes: episodeItems };
}

// Discovers new drama slugs from the latest sitemaps
async function discoverDramaSlugsFromSitemaps(sitemapsCount, all = false) {
  console.log(
    `Fetching sitemap index from https://narto-drama.com/sitemap.xml...`,
  );
  const indexXml = await fetchUrl('https://narto-drama.com/sitemap.xml');
  const parsedIndex = xmlParser.parse(indexXml);
  const sitemaps = (parsedIndex.sitemapindex?.sitemap || [])
    .map((s) => s.loc)
    .filter((u) => u.includes('/episodes/'));

  // Sort descending by episode sitemap number (e.g. 1019, 1018, ...)
  sitemaps.sort((a, b) => {
    const numA = parseInt(a.match(/(\d+)\.xml/)?.[1] || '0', 10);
    const numB = parseInt(b.match(/(\d+)\.xml/)?.[1] || '0', 10);
    return numB - numA;
  });

  const selectedSitemaps = all ? sitemaps : sitemaps.slice(0, sitemapsCount);
  console.log(
    `Scanning ${selectedSitemaps.length} latest episode sitemaps for dramas...`,
  );

  // Query database for all drama slugs already ingested in Velora
  const existingRows = await contentPrisma.$queryRawUnsafe(`
    SELECT DISTINCT unnest(tags) AS tag FROM "Reel" WHERE 'narto-drama' = ANY(tags);
  `);
  const existingSlugs = new Set(
    existingRows
      .map((r) => r.tag)
      .filter((t) => t !== 'narto-drama' && t !== 'short-drama'),
  );
  console.log(
    `Found ${existingSlugs.size} drama series already registered in Velora database.`,
  );

  const newSlugs = new Set();
  for (const smUrl of selectedSitemaps) {
    try {
      console.log(`  Downloading sitemap: ${smUrl}...`);
      const xml = await fetchUrl(smUrl);
      const regex = /\/detail\/watch\/([^/]+)\//g;
      let m;
      let count = 0;
      while ((m = regex.exec(xml)) !== null) {
        const slug = m[1];
        if (!existingSlugs.has(slug)) {
          newSlugs.add(slug);
        }
        count++;
      }
      console.log(
        `  Parsed ${count} URLs in ${smUrl} -> ${newSlugs.size} brand new drama slugs identified.`,
      );
    } catch (err) {
      console.warn(`  Failed to read ${smUrl}:`, err.message);
    }
  }

  return Array.from(newSlugs);
}

// Ingests series and episodes, then handles CDN + indexing
async function syncDramaSeries(dramaInfo, options) {
  console.log(`\n========================================`);
  console.log(`Syncing Drama: "${dramaInfo.title}" (${dramaInfo.slug})`);
  console.log(`Total episodes on Narto: ${dramaInfo.episodes.length}`);
  console.log(`========================================`);

  if (options.dryRun) {
    console.log(
      `[DRY-RUN] Would upsert series and ${dramaInfo.episodes.length} episodes.`,
    );
    return;
  }

  // 1. Upsert ReelSeries in content database
  let series = await contentPrisma.reelSeries.findFirst({
    where: { ownerId: BOT_USER_ID, title: dramaInfo.title },
  });

  if (!series) {
    series = await contentPrisma.reelSeries.create({
      data: {
        ownerId: BOT_USER_ID,
        title: dramaInfo.title,
        description: dramaInfo.description || undefined,
      },
    });
    console.log(`Created new series in database: ID=${series.id}`);
  } else {
    console.log(`Found existing series in database: ID=${series.id}`);
  }

  // 2. Fetch existing reels for this series
  const existingReels = await contentPrisma.reel.findMany({
    where: { seriesId: series.id },
    select: {
      id: true,
      episodeNumber: true,
      hlsMasterKey: true,
      processingStage: true,
    },
  });
  const existingMap = new Map(existingReels.map((r) => [r.episodeNumber, r]));

  // 3. Upsert episodes — sort by episode number first to guarantee correct order
  //    (Narto may return episodes newest-first on some series)
  const sortedEpisodes = [...dramaInfo.episodes].sort((a, b) => {
    const numA = a.number || a.route_episode_number || 0;
    const numB = b.number || b.route_episode_number || 0;
    return numA - numB;
  });

  const reelsToProcess = [];
  for (const ep of sortedEpisodes) {
    if (options.limit > 0 && reelsToProcess.length >= options.limit) break;

    const epNum = ep.number || ep.route_episode_number;
    const playUrl = ep.direct_play_url || ep.play_url;
    if (!playUrl || !playUrl.startsWith('http')) continue;

    const poster = ep.thumb_url
      ? ep.thumb_url.startsWith('http')
        ? ep.thumb_url
        : `https://narto-drama.com${ep.thumb_url}`
      : dramaInfo.posterUrl;

    const existing = existingMap.get(epNum);
    let reelRecord;

    if (!existing) {
      reelRecord = await contentPrisma.reel.create({
        data: {
          userId: BOT_USER_ID,
          seriesId: series.id,
          episodeNumber: epNum,
          title: ep.title
            ? `${dramaInfo.title} ${decodeHtml(ep.title)}`
            : `${dramaInfo.title} Episode ${epNum}`,
          description: dramaInfo.description
            ? `Episode ${epNum} of ${dramaInfo.title}: ${decodeHtml(dramaInfo.description)}`.slice(
                0,
                2000,
              )
            : `${dramaInfo.title} Episode ${epNum}`,
          tags: ['narto-drama', 'short-drama', dramaInfo.slug],
          thumbnailKey: poster,
          mediaKey: playUrl,
          status: 'COMPLETED',
          mediaStatus: 'COMPLETED',
          indexStatus: 'NOT_REQUESTED',
          processingStage: 'MEDIA_QUEUED',
          visibility: 'public',
          sourceDurationMs: 60000,
          outputDurationMs: 60000,
          sourceOrientation: 'PORTRAIT',
          sourceLengthClass: 'SHORT',
          sourceHasAudio: false,
        },
      });
      console.log(
        `  [NEW REEL] Ingested Episode ${epNum} (ID=${reelRecord.id})`,
      );
    } else {
      reelRecord = await contentPrisma.reel.findUnique({
        where: { id: existing.id },
      });
    }

    // Check if CDN or indexing needed
    if (!reelRecord.hlsMasterKey || reelRecord.processingStage !== 'READY') {
      reelsToProcess.push(reelRecord);
    }
  }

  console.log(
    `Episodes needing CDN upload / indexing: ${reelsToProcess.length}`,
  );

  // 4. Concurrently transcode to TikTok CDN & upload master m3u8 to R2
  for (let i = 0; i < reelsToProcess.length; i += options.concurrency) {
    const batch = reelsToProcess.slice(i, i + options.concurrency);
    await Promise.all(
      batch.map(async (reel) => {
        if (!reel.hlsMasterKey) {
          await transcodeAndUploadToTikTokCdn(reel, options);
        }
      }),
    );
  }

  // 5. Vector index new reels with TEI
  const unindexedReels = await contentPrisma.reel.findMany({
    where: {
      seriesId: series.id,
      processingStage: {
        in: ['INDEX_QUEUED', 'PERSISTING', 'VALIDATING', 'MEDIA_QUEUED'],
      },
      hlsMasterKey: { not: null },
    },
  });

  if (unindexedReels.length > 0) {
    console.log(
      `Indexing ${unindexedReels.length} reels for series ${dramaInfo.title}...`,
    );
    const INDEX_BATCH = 50;
    for (let i = 0; i < unindexedReels.length; i += INDEX_BATCH) {
      const batch = unindexedReels.slice(i, i + INDEX_BATCH);
      await indexReelsMetadata(batch, options);
    }
  }

  console.log(`Done syncing drama: "${dramaInfo.title}"!`);
}

// Mode: Index all currently queued reels in the database
async function runIndexQueuedMode(options) {
  console.log('=== Mode: Index All Queued Reels ===');
  const teiHealth = await checkTeiAvailability();
  if (!teiHealth.available) {
    console.error(
      'ERROR: TEI embedding service is not running at ' + TEI_EMBED_URL,
    );
    console.error('Please run: ssh -N -L 8088:192.168.97.3:80 velora-homelab');
    process.exit(1);
  }
  console.log(`TEI service healthy (Model: ${teiHealth.model})`);

  const queuedCount = await contentPrisma.reel.count({
    where: {
      processingStage: { in: ['INDEX_QUEUED', 'PERSISTING', 'VALIDATING'] },
    },
  });
  console.log(`Total reels awaiting metadata indexing: ${queuedCount}`);

  let processed = 0;
  const BATCH_SIZE = 50;

  while (true) {
    if (options.limit > 0 && processed >= options.limit) break;
    const take =
      options.limit > 0
        ? Math.min(BATCH_SIZE, options.limit - processed)
        : BATCH_SIZE;

    const reels = await contentPrisma.reel.findMany({
      where: {
        processingStage: { in: ['INDEX_QUEUED', 'PERSISTING', 'VALIDATING'] },
      },
      take,
      select: {
        id: true,
        userId: true,
        title: true,
        description: true,
        tags: true,
        sourceDurationMs: true,
        sourceOrientation: true,
        sourceLengthClass: true,
        mediaAttemptId: true,
        indexAttemptId: true,
      },
    });

    if (!reels.length) break;

    await indexReelsMetadata(reels, options);
    processed += reels.length;
    console.log(`Progress: ${processed}/${queuedCount} reels indexed.`);
  }
  console.log(`Index Queued Mode Finished! Total: ${processed} reels.`);
}

// Mode: Migrate any existing reels missing hlsMasterKey to TikTok CDN
async function runMigrateCdnMode(options) {
  console.log('=== Mode: Migrate Reels Missing TikTok CDN ===');
  const count = await contentPrisma.reel.count({
    where: { mediaKey: { startsWith: 'http' }, hlsMasterKey: null },
  });
  console.log(`Reels missing TikTok CDN: ${count}`);

  const reels = await contentPrisma.reel.findMany({
    where: { mediaKey: { startsWith: 'http' }, hlsMasterKey: null },
    take: options.limit > 0 ? options.limit : undefined,
    orderBy: { createdAt: 'asc' },
  });

  for (let i = 0; i < reels.length; i += options.concurrency) {
    const batch = reels.slice(i, i + options.concurrency);
    await Promise.all(
      batch.map((r) => transcodeAndUploadToTikTokCdn(r, options)),
    );
  }
  console.log('Migrate CDN Mode Finished!');
}

function showHelp() {
  console.log(`
Narto Drama Sync Pipeline - Unified Ingestion, TikTok CDN & pgvector Indexer

Usage:
  node scripts/narto-scraper/sync.cjs [options]

Options:
  --slug=SLUG            Sync a specific drama by its Narto URL slug
  --sitemaps=N           Number of latest episode sitemaps to scan (default: 2)
  --all-sitemaps         Scan all sitemaps on Narto Drama
  --concurrency=N        Concurrency for video slicing & upload (default: 3)
  --limit=N              Limit total episodes to process
  --crop                 Apply FFmpeg watermark crop filter
  --index-queued         Only index existing reels currently in INDEX_QUEUED
  --migrate-cdn          Only upload existing reels missing hlsMasterKey to TikTok CDN
  --dry-run              Preview actions without writing to DB or CDN
  --help, -h             Show this help message

Examples:
  # Check latest sitemaps for newly added dramas and sync them completely:
  node scripts/narto-scraper/sync.cjs

  # Sync a specific new drama:
  node scripts/narto-scraper/sync.cjs --slug=the-secret-behind-my-scoundrel-husband

  # Resume indexing any unindexed reels:
  node scripts/narto-scraper/sync.cjs --index-queued --limit=200
  `);
}

// Main Runner
async function main() {
  const options = parseOptions();
  if (options.help) {
    showHelp();
    return;
  }

  console.log('======================================================');
  console.log('Velora - Narto Drama Sync Pipeline');
  console.log('======================================================');

  try {
    if (options.indexQueuedOnly) {
      await runIndexQueuedMode(options);
      return;
    }

    if (options.migrateCdnOnly) {
      await runMigrateCdnMode(options);
      return;
    }

    if (options.slug) {
      // Sync specific drama
      console.log(`Fetching details for drama slug: "${options.slug}"...`);
      const dramaInfo = await fetchDramaDetails(options.slug, options.lang);
      await syncDramaSeries(dramaInfo, options);
      return;
    }

    // Discover new dramas from latest sitemaps
    let slugs = await discoverDramaSlugsFromSitemaps(
      options.sitemaps,
      options.allSitemaps,
    );
    console.log(
      `Discovered ${slugs.length} new drama slugs not yet in Velora database.`,
    );

    if (options.maxDramas > 0) {
      slugs = slugs.slice(0, options.maxDramas);
      console.log(`Limited to first ${options.maxDramas} new dramas.`);
    }

    // Process each new drama
    for (let i = 0; i < slugs.length; i++) {
      const slug = slugs[i];
      try {
        console.log(
          `\n[${i + 1}/${slugs.length}] Processing drama "${slug}"...`,
        );
        const dramaInfo = await fetchDramaDetails(slug, options.lang);
        await syncDramaSeries(dramaInfo, options);
      } catch (err) {
        console.warn(`Failed to sync drama "${slug}":`, err.message);
      }
    }

    console.log('\nAll sync tasks completed successfully!');
  } finally {
    await contentPrisma.$disconnect();
    if (indexPrisma) await indexPrisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
