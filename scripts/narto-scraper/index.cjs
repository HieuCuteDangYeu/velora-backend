#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
} catch {
  // dotenv is optional if env vars are already exported
}

const CHECKPOINT_PATH = path.join(__dirname, 'checkpoint.json');
const OUTPUT_PATH = path.join(__dirname, 'scraped-data.json');

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_PATH)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'));
    }
  } catch {
    console.warn('[checkpoint] Failed to load, starting fresh');
  }
  return { phase: 'crawl', completedSitemaps: [], lastIngestedSeries: null };
}

function saveCheckpoint(state) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    phase: args.find((a) => ['crawl', 'build', 'ingest', 'index', 'queue-index', 'all', 'stats'].includes(a)) || 'all',
    concurrency: parseInt(process.env.CRAWL_CONCURRENCY || '3', 10),
    batchSize: parseInt(process.env.INGEST_BATCH_SIZE || '50', 10),
    maxSitemaps: parseInt(process.env.MAX_SITEMAPS || '0', 10) || undefined,
    maxSeries: parseInt(process.env.MAX_SERIES || '0', 10) || undefined,
    queueIndexing: process.env.QUEUE_INDEXING === '1',
    dryRun: process.env.DRY_RUN === '1',
    baseUrl: process.env.BASE_URL || 'https://narto-drama.com',
  };
}

async function phaseCrawl(config) {
  const { fetchSitemapIndex, crawlAllEpisodes } = require('./sitemap-crawler.cjs');

  console.log('\n=== Phase 1: Crawl Sitemaps ===');
  console.log(`Base URL: ${config.baseUrl}`);
  console.log(`Concurrency: ${config.concurrency}`);

  const sitemapUrls = await fetchSitemapIndex(config.baseUrl);
  const episodeUrls = sitemapUrls.filter((u) => u.includes('/episodes/'));

  console.log(`Found ${episodeUrls.length} episode sitemaps`);

  const limited = config.maxSitemaps
    ? episodeUrls.slice(0, config.maxSitemaps)
    : episodeUrls;

  console.log(`Crawling ${limited.length} sitemaps...`);

  const episodes = await crawlAllEpisodes({
    sitemapUrls: limited,
    concurrency: config.concurrency,
    delayMs: 500,
  });

  console.log(`\nCrawled ${episodes.length} total episodes`);

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(episodes, null, 2));
  console.log(`Saved to ${OUTPUT_PATH}`);

  return episodes;
}

async function phaseBuild(episodes) {
  const { buildSeriesMap, toSortedSeriesArray } = require('./series-builder.cjs');

  console.log('\n=== Phase 2: Build Series ===');

  if (!episodes) {
    if (!fs.existsSync(OUTPUT_PATH)) {
      throw new Error(`No scraped data found. Run 'crawl' phase first.`);
    }
    episodes = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
    console.log(`Loaded ${episodes.length} episodes from ${OUTPUT_PATH}`);
  }

  const seriesMap = buildSeriesMap(episodes);
  const seriesArray = toSortedSeriesArray(seriesMap);

  const totalEpisodes = seriesArray.reduce((sum, s) => sum + s.episodes.length, 0);
  console.log(`Built ${seriesArray.length} series with ${totalEpisodes} unique episodes`);

  const seriesOutputPath = path.join(__dirname, 'series-data.json');
  fs.writeFileSync(seriesOutputPath, JSON.stringify(seriesArray, null, 2));
  console.log(`Saved to ${seriesOutputPath}`);

  return seriesArray;
}

async function phaseIngest(seriesArray, config) {
  const { createIngester } = require('./velora-ingester.cjs');

  console.log('\n=== Phase 3: Ingest into Velora ===');

  if (!seriesArray) {
    const seriesPath = path.join(__dirname, 'series-data.json');
    if (!fs.existsSync(seriesPath)) {
      throw new Error(`No series data found. Run 'build' phase first.`);
    }
    seriesArray = JSON.parse(fs.readFileSync(seriesPath, 'utf-8'));
    console.log(`Loaded ${seriesArray.length} series from ${seriesPath}`);
  }

  if (config.maxSeries && seriesArray.length > config.maxSeries) {
    seriesArray = seriesArray.slice(0, config.maxSeries);
    console.log(`Limited to first ${config.maxSeries} series`);
  }

  if (config.dryRun) {
    console.log('[DRY RUN] Would ingest:');
    console.log(`  ${seriesArray.length} series`);
    console.log(`  ${seriesArray.reduce((s, sr) => s + sr.episodes.length, 0)} reels`);
    return;
  }

  if (!process.env.CONTENT_DATABASE_URL) {
    throw new Error('CONTENT_DATABASE_URL is required for ingest phase');
  }

  const ingester = createIngester();
  await ingester.connect();

  try {
    const botUserId = ingester.ensureBotUser();
    console.log(`Bot user ID: ${botUserId}`);

    const startTime = Date.now();
    let seriesDone = 0;
    let reelsDone = 0;

    await ingester.ingestAll(botUserId, seriesArray, {
      batchSize: config.batchSize,
      queueIndexing: config.queueIndexing,
      onProgress: (done, total, currentSeriesTitle) => {
        seriesDone = done;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (done / (elapsed || 1)).toFixed(1);
        process.stdout.write(
          `\r  [${done}/${total}] ${rate} series/s — ${currentSeriesTitle || ''}`.padEnd(80),
        );
      },
      onReelProgress: (done) => {
        reelsDone = done;
      },
    });

    console.log(`\n\nIngestion complete:`);
    console.log(`  Series: ${seriesDone}`);
    console.log(`  Reels: ${reelsDone}`);
    console.log(`  Time: ${((Date.now() - startTime) / 1000).toFixed(1)}s`);

    const stats = await ingester.getStats(botUserId);
    console.log(`\nDatabase totals (bot user):`);
    console.log(`  Series: ${stats.seriesCount}`);
    console.log(`  Reels: ${stats.reelCount}`);
    console.log(`  Indexing breakdown:`, stats.indexing);
    console.log(`  Pending outbox events: ${stats.pendingOutboxCount}`);
  } finally {
    await ingester.disconnect();
  }
}

async function phaseQueueIndex(config) {
  const { createIngester } = require('./velora-ingester.cjs');

  console.log('\n=== Phase 4: Queue Metadata-Only Indexing ===');

  if (!process.env.CONTENT_DATABASE_URL) {
    throw new Error('CONTENT_DATABASE_URL is required for index phase');
  }

  const ingester = createIngester();
  await ingester.connect();

  try {
    const botUserId = ingester.ensureBotUser();
    console.log(`Bot user ID: ${botUserId}`);

    const startTime = Date.now();
    const queuedCount = await ingester.queueIndexingForAll(botUserId, {
      onProgress: (done, total, title) => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const rate = (done / (elapsed || 1)).toFixed(1);
        process.stdout.write(
          `\r  [${done}/${total}] ${rate} reels/s — ${title || ''}`.padEnd(80),
        );
      },
    });

    console.log(`\n\nQueued ${queuedCount} reels for metadata-only indexing in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    console.log('Outbox events created. Content Service will dispatch them to Reel Indexing Service via RabbitMQ.');

    const stats = await ingester.getStats(botUserId);
    console.log(`\nDatabase totals (bot user):`);
    console.log(`  Series: ${stats.seriesCount}`);
    console.log(`  Reels: ${stats.reelCount}`);
    console.log(`  Indexing breakdown:`, stats.indexing);
    console.log(`  Pending outbox events: ${stats.pendingOutboxCount}`);
  } finally {
    await ingester.disconnect();
  }
}

async function phaseStats() {
  if (!process.env.CONTENT_DATABASE_URL) {
    throw new Error('CONTENT_DATABASE_URL is required');
  }

  const { createIngester } = require('./velora-ingester.cjs');
  const ingester = createIngester();
  await ingester.connect();

  try {
    const botUserId = ingester.ensureBotUser();
    const stats = await ingester.getStats(botUserId);
    console.log('\n=== Narto Scraper Stats ===');
    console.log(`Bot User: ${botUserId}`);
    console.log(`Series: ${stats.seriesCount}`);
    console.log(`Reels: ${stats.reelCount}`);
    console.log(`Indexing breakdown:`, stats.indexing);
    console.log(`Pending outbox events: ${stats.pendingOutboxCount}`);
  } finally {
    await ingester.disconnect();
  }
}

async function main() {
  const config = parseArgs();
  console.log('Narto Drama → Velora Scraper');
  console.log(`Phase: ${config.phase}`);

  try {
    let episodes = null;
    let seriesArray = null;

    if (config.phase === 'stats') {
      await phaseStats();
      return;
    }

    if (config.phase === 'queue-index' || config.phase === 'index') {
      await phaseQueueIndex(config);
      return;
    }

    if (config.phase === 'crawl' || config.phase === 'all') {
      episodes = await phaseCrawl(config);
    }

    if (config.phase === 'build' || config.phase === 'all') {
      seriesArray = await phaseBuild(episodes);
    }

    if (config.phase === 'ingest' || config.phase === 'all') {
      await phaseIngest(seriesArray, config);
    }

    console.log('\nDone!');
  } catch (error) {
    console.error('\nFatal error:', error.message || error);
    process.exit(1);
  }
}

main();
