// Usage: node scripts/narto-scraper/migrate-to-tiktok-cdn.cjs [--concurrency=3] [--crop] [--limit=100] [--dry-run] [--series=slug]
// Migrates existing Narto Drama reels from external CDN URLs to TikTok CDN via the video-hls-api Rust tool.

require('dotenv').config();
const { PrismaClient } = require('@prisma/content-client');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const execAsync = util.promisify(exec);

// Parse CLI args
const args = process.argv.slice(2);
const CONCURRENCY = parseInt(args.find(a => a.startsWith('--concurrency='))?.split('=')[1] || '3', 10);
const CROP = args.includes('--crop');
const LIMIT = parseInt(args.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const DRY_RUN = args.includes('--dry-run');
const SERIES_SLUG = args.find(a => a.startsWith('--series='))?.split('=')[1];

const TIKTOK_CDN_UPLOAD_ENDPOINT =
  process.env.TIKTOK_CDN_UPLOAD_ENDPOINT || process.env.CDN_UPLOAD_ENDPOINT;
const TIKTOK_CDN_CSRF_TOKEN =
  process.env.TIKTOK_CDN_CSRF_TOKEN || process.env.CDN_CSRF_TOKEN;
const TIKTOK_CDN_UUID =
  process.env.TIKTOK_CDN_UUID || process.env.CDN_UUID;
const TIKTOK_CDN_COOKIE =
  process.env.TIKTOK_CDN_COOKIE || process.env.CDN_COOKIE;

const PNG_HEX =
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082';
const PNG_MASK = Buffer.from(PNG_HEX, 'hex');
const PNG_MASK_SIZE = 67;

const CHECKPOINT_FILE = path.join(__dirname, '.migrate-checkpoint.json');

// Ensure connection_limit=1 to prevent PostgreSQL connection exhaustion
const dbUrl = new URL(process.env.CONTENT_DATABASE_URL);
dbUrl.searchParams.set('connection_limit', '1');
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl.toString() } } });

const s3Client = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

function fetchUrl(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;
    protocol
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

const seriesItemsCache = new Map();

async function resolveCleanStreamUrl(reel) {
  // Find series slug from tags (e.g. ['narto-drama', 'short-drama', 'slug'])
  const seriesSlug = reel.tags?.find((t) => t !== 'narto-drama' && t !== 'short-drama');
  if (!seriesSlug) return reel.mediaKey;

  let items = seriesItemsCache.get(seriesSlug);
  if (!items) {
    const watchUrl = `https://narto-drama.com/detail/watch/${seriesSlug}/1?lang=id-ID`;
    try {
      const html = await fetchUrl(watchUrl);
      const match = html.match(/const\s+episodeItemsRaw\s*=\s*(\[.*?\]);/s);
      if (match) {
        items = JSON.parse(match[1]);
        seriesItemsCache.set(seriesSlug, items);
      }
    } catch (err) {
      console.warn(`Could not fetch watch page for series ${seriesSlug}:`, err.message);
    }
  }

  if (items) {
    const epItem = items.find(
      (i) => (i.number || i.route_episode_number) === reel.episodeNumber,
    );
    if (epItem?.play_url && epItem.play_url.startsWith('http')) {
      return epItem.play_url;
    }
  }

  return reel.mediaKey;
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('Failed to load checkpoint:', err);
  }
  return { processedReelIds: [], failedReelIds: [], stats: { total: 0, processed: 0, failed: 0 } };
}

function saveCheckpoint(checkpoint) {
  checkpoint.lastProcessedAt = new Date().toISOString();
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

async function uploadSegmentToTikTok(filePath, filename) {
  let tsData = fs.readFileSync(filePath);
  if (tsData.includes('FFmpeg')) {
    tsData = Buffer.from(tsData);
    let idx = 0;
    while ((idx = tsData.indexOf('FFmpeg', idx)) !== -1) {
      tsData.write('velora', idx);
      idx += 6;
    }
  }
  const originalSize = tsData.length;
  const spoofed = Buffer.concat([PNG_MASK, tsData]);
  const uploadFilename = filename.replace(/\.ts$/, '.png');

  const form = new FormData();
  const blob = new Blob([new Uint8Array(spoofed)], { type: 'image/png' });
  form.append('Filedata', blob, uploadFilename);

  const res = await fetch(TIKTOK_CDN_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      'x-ttam-uuid': TIKTOK_CDN_UUID,
      'x-csrftoken': TIKTOK_CDN_CSRF_TOKEN,
      Cookie: TIKTOK_CDN_COOKIE,
    },
    body: form,
  });

  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`TikTok CDN HTTP ${res.status}: ${bodyText}`);
  }

  const parsed = JSON.parse(bodyText);
  if (parsed.code === 0 && parsed.data?.url) {
    return {
      filename,
      remoteUrl: parsed.data.url,
      originalSize,
    };
  }

  throw new Error(`TikTok CDN rejected ${filename}: ${bodyText}`);
}

async function processReel(reel, checkpoint) {
  const startTime = Date.now();
  const hlsDir = `/tmp/velora-hls-${reel.id}`;

  try {
    const inputUrl = await resolveCleanStreamUrl(reel);
    const isCleanStream = inputUrl !== reel.mediaKey;

    if (DRY_RUN) {
      console.log(`[DRY-RUN] Would process reel ${reel.id} (${isCleanStream ? 'Clean Stream: ' : 'Direct: '}${inputUrl})`);
      checkpoint.processedReelIds.push(reel.id);
      checkpoint.stats.processed++;
      return;
    }

    fs.mkdirSync(hlsDir, { recursive: true });

    // Slice to HLS with FFmpeg directly from inputUrl
    const m3u8Path = path.join(hlsDir, 'index.m3u8');
    const cropArg = CROP ? '-vf "crop=iw:ih-110:0:40" -c:v libx264 -preset fast -crf 23 -c:a copy' : '-codec: copy';
    await execAsync(`ffmpeg -y -i "${inputUrl}" ${cropArg} -map_metadata -1 -metadata service_provider=velora -metadata service_name=velora -start_number 0 -hls_time 5 -hls_list_size 0 -f hls ${m3u8Path}`);

    // Upload segments
    const files = fs.readdirSync(hlsDir);
    const tsFiles = files
      .filter(f => f.endsWith('.ts'))
      .sort((a, b) => (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0));

    if (tsFiles.length === 0) {
      throw new Error('FFmpeg did not produce any .ts segments');
    }

    const uploadResults = [];
    for (const tsFile of tsFiles) {
      const segmentPath = path.join(hlsDir, tsFile);
      const result = await uploadSegmentToTikTok(segmentPath, tsFile);
      uploadResults.push(result);
    }

    // Rewrite playlist
    let m3u8Content = fs.readFileSync(m3u8Path, 'utf8');
    for (const result of uploadResults) {
      const byterangeBlock = `#EXT-X-BYTERANGE:${result.originalSize}@${PNG_MASK_SIZE}\n${result.remoteUrl}`;
      m3u8Content = m3u8Content.replace(result.filename, byterangeBlock);
    }
    m3u8Content = m3u8Content.replace('#EXT-X-VERSION:3', '#EXT-X-VERSION:4');

    const hlsMasterKey = `reels/${reel.id}/master.m3u8`;

    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: hlsMasterKey,
      Body: m3u8Content,
      ContentType: 'application/vnd.apple.mpegurl',
      CacheControl: 'public, max-age=60, stale-while-revalidate=30',
    }));

    await prisma.reel.update({
      where: { id: reel.id },
      data: { hlsMasterKey },
    });

    checkpoint.processedReelIds.push(reel.id);
    checkpoint.stats.processed++;

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[${checkpoint.stats.processed}/${checkpoint.stats.total}] Migrated reel ${reel.id} from ${reel.series?.title || 'Unknown'} ep ${reel.episodeNumber} (${duration}s)`);
  } catch (error) {
    console.error(`Failed to process reel ${reel.id}:`, error);
    checkpoint.failedReelIds.push(reel.id);
    checkpoint.stats.failed++;
  } finally {
    if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true, force: true });
  }
}

async function main() {
  const checkpoint = loadCheckpoint();

  const where = {
    mediaKey: { startsWith: 'http' },
    hlsMasterKey: null,
    ...(checkpoint.failedReelIds?.length > 0 ? { id: { notIn: checkpoint.failedReelIds } } : {}),
  };

  if (SERIES_SLUG) {
    where.tags = { has: SERIES_SLUG };
  }

  console.log('Querying reels to process...');
  const reels = await prisma.reel.findMany({
    where,
    include: { series: true },
    orderBy: { createdAt: 'asc' },
    ...(LIMIT ? { take: LIMIT } : {}),
  });

  checkpoint.stats.total = (checkpoint.stats.total || 0) + reels.length;
  console.log(`Found ${reels.length} reels to migrate.`);

  for (let i = 0; i < reels.length; i += CONCURRENCY) {
    const batch = reels.slice(i, i + CONCURRENCY);
    await Promise.allSettled(batch.map(reel => processReel(reel, checkpoint)));
    saveCheckpoint(checkpoint);
  }

  console.log('Migration complete!');
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
