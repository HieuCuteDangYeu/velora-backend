/**
 * update-stream-urls.cjs
 *
 * Fetches the direct video stream URLs (CDN .mp4 or .m3u8) and thumbnail URLs
 * for all ingested Narto Drama series and updates the Reel records in Velora's database.
 *
 * Each Narto Drama watch page contains the full `episodeItemsRaw` array for that series,
 * so we only need to fetch 1 page per series.
 */

require('dotenv').config();
const https = require('https');
const { PrismaClient } = require('@prisma/content-client');

const BOT_USER_ID = process.env.BOT_USER_ID || 'b6ddf921-c87c-4f68-8d71-f1b1fd33f3e7';
const CONCURRENCY = 5;

function fetchUrl(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        },
        (res) => {
          if (
            (res.statusCode === 301 || res.statusCode === 302) &&
            res.headers.location &&
            maxRedirects > 0
          ) {
            return fetchUrl(res.headers.location, maxRedirects - 1)
              .then(resolve)
              .catch(reject);
          }

          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => resolve(data));
        },
      )
      .on('error', reject);
  });
}

function extractEpisodeItems(html) {
  const match = html.match(/const\s+episodeItemsRaw\s*=\s*(\[.*?\]);/s);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

async function updateSeriesReels(prisma, series, index, total) {
  const needsUpdate = series.reels.some((r) =>
    r.mediaKey.includes('/detail/watch/'),
  );

  if (!needsUpdate) {
    console.log(
      `[${index}/${total}] "${series.title}": All ${series.reels.length} reels already have direct stream URLs. Skipping.`,
    );
    return { seriesId: series.id, updated: 0, skipped: series.reels.length };
  }

  // Find a watch URL to fetch
  const sampleReel =
    series.reels.find((r) => r.mediaKey.includes('/detail/watch/')) ||
    series.reels[0];

  let watchUrl = sampleReel.mediaKey;
  if (!watchUrl.includes('/detail/watch/')) {
    // If mediaKey was already updated on sampleReel, construct from series slug if known, or skip
    console.warn(`[${index}/${total}] Cannot find watch URL for "${series.title}". Skipping.`);
    return { seriesId: series.id, updated: 0, skipped: series.reels.length };
  }

  try {
    const html = await fetchUrl(watchUrl);
    const items = extractEpisodeItems(html);

    if (!items || items.length === 0) {
      console.warn(
        `[${index}/${total}] "${series.title}": Could not extract episodeItemsRaw from ${watchUrl}`,
      );
      return { seriesId: series.id, updated: 0, error: 'no_episode_items' };
    }

    let updatedCount = 0;
    for (const item of items) {
      const epNum = item.number || item.route_episode_number;
      const streamUrl =
        item.direct_play_url ||
        (item.play_url?.startsWith('http')
          ? item.play_url
          : item.play_url
            ? `https://narto-drama.com${item.play_url}`
            : null) ||
        item.schema_content_url;
      const thumbUrl = item.thumb_url;

      if (!streamUrl) continue;

      const reel = series.reels.find((r) => r.episodeNumber === epNum);
      if (reel && reel.mediaKey !== streamUrl) {
        await prisma.reel.update({
          where: { id: reel.id },
          data: {
            mediaKey: streamUrl,
            thumbnailKey: thumbUrl || reel.thumbnailKey,
          },
        });
        updatedCount++;
      }
    }

    console.log(
      `[${index}/${total}] "${series.title}": Updated ${updatedCount}/${series.reels.length} reels with direct stream URLs.`,
    );
    return { seriesId: series.id, updated: updatedCount };
  } catch (err) {
    console.error(
      `[${index}/${total}] "${series.title}": Error updating reels: ${err.message}`,
    );
    return { seriesId: series.id, updated: 0, error: err.message };
  }
}

async function runInPool(items, limit, worker) {
  const results = [];
  let index = 0;

  async function next() {
    while (index < items.length) {
      const currentIndex = index++;
      const res = await worker(items[currentIndex], currentIndex + 1, items.length);
      results[currentIndex] = res;
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(workers);
  return results;
}

async function main() {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.CONTENT_DATABASE_URL } },
  });

  console.log(`Querying series for ownerId: ${BOT_USER_ID}...`);
  const seriesList = await prisma.reelSeries.findMany({
    where: { ownerId: BOT_USER_ID },
    include: {
      reels: {
        select: {
          id: true,
          episodeNumber: true,
          mediaKey: true,
          thumbnailKey: true,
        },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${seriesList.length} series in database.`);

  const results = await runInPool(seriesList, CONCURRENCY, (series, idx, total) =>
    updateSeriesReels(prisma, series, idx, total),
  );

  const totalUpdated = results.reduce((sum, r) => sum + (r?.updated || 0), 0);
  console.log(`\nAll done! Total reels updated with direct stream URLs: ${totalUpdated}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('Fatal error in update-stream-urls:', err);
  process.exit(1);
});
