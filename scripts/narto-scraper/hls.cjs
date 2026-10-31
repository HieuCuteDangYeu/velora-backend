'use strict';

// Operator scripts use the service implementations rather than a second encoding ladder.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const root = path.resolve(__dirname, '../..');
require('ts-node').register({
  project: path.join(root, 'tsconfig.json'),
  transpileOnly: true,
});
require('tsconfig-paths').register({
  baseUrl: root,
  paths: require('../../tsconfig.json').compilerOptions.paths,
});
const { ConfigService } = require('@nestjs/config');
const {
  FfmpegService,
} = require('../../apps/media-processing-service/src/infrastructure/services/ffmpeg.service.ts');
const {
  SelectReelEncodingProfileUseCase,
} = require('../../apps/media-processing-service/src/application/use-cases/select-reel-encoding-profile.use-case.ts');
const {
  ValidateReelSourceMediaUseCase,
} = require('../../apps/media-processing-service/src/application/use-cases/validate-reel-source-media.use-case.ts');
const {
  ClassifyReelMediaUseCase,
} = require('../../apps/media-processing-service/src/application/use-cases/classify-reel-media.use-case.ts');
const {
  ValidateReelStreamUseCase,
} = require('../../apps/media-processing-service/src/application/use-cases/validate-reel-stream.use-case.ts');
const run = promisify(execFile);

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (data) => hash.update(data));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function localReference(dir, playlist, reference) {
  // Generated VOD must be self-contained; never let ffprobe follow remote/file URIs.
  if (
    !/^[a-zA-Z0-9_./-]+$/.test(reference) ||
    reference.split('/').includes('..') ||
    path.isAbsolute(reference)
  ) {
    throw new Error('Unsafe local HLS reference');
  }
  const file = path.resolve(path.dirname(playlist), reference);
  if (
    !fs.realpathSync(file).startsWith(`${fs.realpathSync(dir)}${path.sep}`) ||
    !fs.lstatSync(file).isFile() ||
    fs.statSync(file).size === 0
  ) {
    throw new Error('Missing or empty HLS object');
  }
  return file;
}

async function validateLocalHls(
  dir,
  profile,
  { ffprobe = 'ffprobe', ffmpeg = 'ffmpeg' } = {},
) {
  const masterPath = path.join(dir, 'master.m3u8');
  const master = fs.readFileSync(masterPath, 'utf8');
  if (!master.startsWith('#EXTM3U') || /URI=/.test(master))
    throw new Error('Invalid generated HLS master');
  const references = master
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('#'));
  if (
    references.length !== profile.variants.length ||
    (master.match(/#EXT-X-STREAM-INF:/g) || []).length !== references.length
  ) {
    throw new Error('HLS rendition count mismatch');
  }
  const summaries = [];
  const objects = new Set([masterPath]);
  for (const [index, reference] of references.entries()) {
    const playlist = localReference(dir, masterPath, reference);
    objects.add(playlist);
    const text = fs.readFileSync(playlist, 'utf8');
    if (
      !text.startsWith('#EXTM3U') ||
      !text.includes('#EXT-X-ENDLIST') ||
      !text.includes('#EXT-X-INDEPENDENT-SEGMENTS') ||
      /URI=/.test(text)
    ) {
      throw new Error('Incomplete or unsupported generated HLS variant');
    }
    const segments = text
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith('#'));
    const durations = [...text.matchAll(/#EXTINF:([\d.]+),/g)].map((match) =>
      Number(match[1]),
    );
    const tolerance = 1 / profile.outputFps + 0.05;
    if (
      !segments.length ||
      durations.length !== segments.length ||
      durations.some(
        (seconds) =>
          !Number.isFinite(seconds) ||
          seconds <= 0 ||
          seconds > profile.segmentSeconds + tolerance,
      )
    ) {
      throw new Error('HLS segment duration contract failed');
    }
    for (const segment of segments) {
      const file = localReference(dir, playlist, segment);
      if (!file.endsWith('.ts'))
        throw new Error('Unsupported generated HLS segment');
      objects.add(file);
      const { stdout } = await run(
        ffprobe,
        [
          '-v',
          'error',
          '-select_streams',
          'v:0',
          '-read_intervals',
          '%+0.1',
          '-show_frames',
          '-show_entries',
          'frame=key_frame,width,height',
          '-of',
          'json',
          file,
        ],
        { timeout: 30_000, maxBuffer: 2_097_152 },
      );
      const first = JSON.parse(stdout).frames?.[0];
      const expected = profile.variants[index];
      if (
        first?.key_frame !== 1 ||
        first.width !== expected.width ||
        first.height !== expected.height
      ) {
        throw new Error(
          'HLS segment is not independently decodable at the expected dimensions',
        );
      }
    }
    const { stdout } = await run(
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file,crypto,data',
        '-select_streams',
        'v:0',
        '-skip_frame',
        'nokey',
        '-show_frames',
        '-show_entries',
        'frame=best_effort_timestamp_time',
        '-of',
        'json',
        playlist,
      ],
      { timeout: profile.timeoutMs, maxBuffer: 8_388_608 },
    );
    const timestamps = JSON.parse(stdout).frames.map((frame) =>
      Number(frame.best_effort_timestamp_time),
    );
    const gaps = timestamps
      .slice(1)
      .map((timestamp, i) => timestamp - timestamps[i]);
    if (
      timestamps.length < segments.length ||
      timestamps.some((value) => !Number.isFinite(value)) ||
      gaps.some((gap) => gap <= 0 || gap > profile.segmentSeconds + tolerance)
    ) {
      throw new Error('HLS keyframe cadence contract failed');
    }
    await run(
      ffmpeg,
      [
        '-v',
        'error',
        '-xerror',
        '-nostdin',
        '-protocol_whitelist',
        'file,crypto,data',
        '-i',
        playlist,
        '-f',
        'null',
        '-',
      ],
      { timeout: profile.timeoutMs, maxBuffer: 2_097_152 },
    );
    summaries.push({
      ...profile.variants[index],
      segments: segments.length,
      durationSeconds: durations.reduce((sum, n) => sum + n, 0),
      maxSegmentSeconds: Math.max(...durations),
      maxKeyframeGapSeconds: Math.max(0, ...gaps),
    });
  }
  if (
    summaries.some(
      (variant) =>
        Math.abs(variant.durationSeconds - summaries[0].durationSeconds) >
        1 / profile.outputFps + 0.05,
    )
  ) {
    throw new Error('HLS rendition durations are not aligned');
  }
  const files = [];
  for (const file of [...objects].sort())
    files.push({
      path: path.relative(dir, file).split(path.sep).join('/'),
      bytes: fs.statSync(file).size,
      sha256: await sha256(file),
    });
  return { variants: summaries, files };
}

function legacyCropEdit(metadata) {
  const rotation = (((metadata.rotation || 0) % 360) + 360) % 360;
  const width =
    rotation === 90 || rotation === 270 ? metadata.height : metadata.width;
  const height =
    rotation === 90 || rotation === 270 ? metadata.width : metadata.height;
  if (width < 978 || height < 1920)
    throw new Error(
      'Legacy --crop requires at least 978x1920 upright source pixels',
    );
  return {
    framing: 'crop',
    crop: {
      x: (Math.floor((width - 978) / 4) * 2) / width,
      y: 180 / height,
      width: 978 / width,
      height: 1740 / height,
    },
  };
}

async function prepareHls({
  source,
  outputDir,
  preserveInputTimestamps = false,
  crop = false,
  edit,
  config = new ConfigService(),
}) {
  if (crop && edit)
    throw new Error('Choose legacy --crop or persisted mediaEdit');
  const input = path.resolve(source);
  if (!fs.lstatSync(input).isFile())
    throw new Error('Source must be a local regular MP4 file');
  const header = Buffer.alloc(12);
  const descriptor = fs.openSync(input, 'r');
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (header.toString('ascii', 4, 8) !== 'ftyp')
    throw new Error(
      'Stage a direct MP4 source; playlists are not accepted as source files',
    );
  fs.mkdirSync(outputDir); // Never overwrite a previous preparation or published version.
  const ffmpeg = new FfmpegService(config);
  try {
    const sourceMetadata = await ffmpeg.getVideoMetadata(input);
    const validator = new ValidateReelSourceMediaUseCase(config);
    validator.execute(sourceMetadata, { sourceBytes: fs.statSync(input).size });
    const mediaEdit = crop ? legacyCropEdit(sourceMetadata) : edit;
    const trim = validator.resolveTrim(mediaEdit, sourceMetadata.durationMs);
    const profile = new SelectReelEncodingProfileUseCase(config).execute(
      sourceMetadata,
      mediaEdit,
      trim.outputDurationMs,
      mediaEdit?.trim ? trim : undefined,
    );
    await ffmpeg.transcodeToHls(input, outputDir, profile, { preserveInputTimestamps });
    await ffmpeg.extractThumbnail(
      input,
      path.join(outputDir, 'thumbnail.jpg'),
      Math.min(2, Math.max(0, trim.outputDurationMs / 1000 - 0.2)),
      { crop: profile.crop, trim: profile.trim },
    );
    const validation = await validateLocalHls(outputDir, profile, {
      ffprobe: config.get('FFPROBE_PATH') || 'ffprobe',
      ffmpeg: config.get('FFMPEG_PATH') || 'ffmpeg',
    });
    const classification = new ClassifyReelMediaUseCase(config).execute(
      sourceMetadata,
    );
    const thumbnail = path.join(outputDir, 'thumbnail.jpg');
    validation.files.push({
      path: 'thumbnail.jpg',
      bytes: fs.statSync(thumbnail).size,
      sha256: await sha256(thumbnail),
    });
    return {
      sourceSha256: await sha256(input),
      sourceMetadata,
      classification,
      outputDurationMs: trim.outputDurationMs,
      profile,
      validation,
    };
  } finally {
    ffmpeg.onModuleDestroy();
  }
}

async function validatePublishedHls({ storage, reelId, prefix }) {
  await new ValidateReelStreamUseCase(storage).execute({
    reelId,
    s3Prefix: prefix,
    thumbnailKey: `${prefix}/thumbnail.jpg`,
  });
}

module.exports = {
  prepareHls,
  validateLocalHls,
  validatePublishedHls,
  legacyCropEdit,
  localReference,
  sha256,
};
