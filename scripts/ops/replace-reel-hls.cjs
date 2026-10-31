#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const {
  prepareHls,
  sha256,
  validatePublishedHls,
} = require('../narto-scraper/hls.cjs');
const {
  ReelHlsReplacementPlanSchema,
  reelHlsPlanSha256,
  validateHlsArtifactGraph,
} = require('../../libs/common/src/content/reel-hls-replacement.ts');

function parseArgs(argv) {
  const options = { mode: 'dry-run' };
  let operationSelected = false;
  for (const arg of argv) {
    if (
      /^--(?:dry-run|snapshot|prepare|review|stage|apply|rollback)$/.test(arg)
    ) {
      if (operationSelected) throw new Error('Choose one operation');
      operationSelected = true;
      options.mode = arg.slice(2);
    } else if (
      /^--(?:reel-id|source|output-dir|snapshot-file|artifact|reviewed-sha256)=.+$/.test(
        arg,
      )
    ) {
      const equals = arg.indexOf('=');
      options[arg.slice(2, equals)] = arg.slice(equals + 1);
    } else if (arg === '--help') options.help = true;
    else throw new Error('Unknown or empty option');
  }
  return options;
}

function writePrivate(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
}

function makePlan(preparation, snapshot) {
  if (snapshot.reelId !== preparation.reelId)
    throw new Error('Snapshot belongs to a different Reel');
  const plan = ReelHlsReplacementPlanSchema.parse({
    ...snapshot,
    schemaVersion: 1,
    attemptId: randomUUID(),
    sourceSha256: preparation.media.sourceSha256,
    sourceMode: 'PUBLISHED_HLS',
    outputDurationMs: preparation.media.outputDurationMs,
    segmentSeconds: preparation.media.profile.segmentSeconds,
    outputFps: preparation.media.profile.outputFps,
    variants: preparation.media.profile.variants.map(
      ({ name, width, height }) => ({ name, width, height }),
    ),
    files: preparation.media.validation.files,
  });
  return { plan, reviewedSha256: reelHlsPlanSha256(plan) };
}

function readArtifact(file, expectedDigest) {
  const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plan = ReelHlsReplacementPlanSchema.parse(artifact.plan);
  const digest = reelHlsPlanSha256(plan);
  if (
    digest !== artifact.reviewedSha256 ||
    (expectedDigest && digest !== expectedDigest)
  )
    throw new Error('Reviewed artifact checksum mismatch');
  return { ...artifact, plan, reviewedSha256: digest };
}

async function verifyLocalFiles(artifact) {
  const playlists = new Map();
  const outputDir = fs.realpathSync(artifact.outputDir);
  for (const file of artifact.plan.files) {
    const local = fs.realpathSync(path.join(outputDir, file.path));
    if (
      !local.startsWith(`${outputDir}${path.sep}`) ||
      fs.statSync(local).size !== file.bytes ||
      (await sha256(local)) !== file.sha256
    )
      throw new Error('Local preparation differs from reviewed artifact');
    if (file.path.endsWith('.m3u8'))
      playlists.set(file.path, fs.readFileSync(local, 'utf8'));
  }
  validateHlsArtifactGraph(artifact.plan, playlists);
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(
      'One-Reel HLS replacement. Default is offline dry-run.\n--prepare --reel-id=UUID --source=LOCAL_MP4 --output-dir=NEW_DIRECTORY\n--review --artifact=preparation.json --snapshot-file=reviewed-snapshot.json\n--snapshot --reel-id=UUID --snapshot-file=NEW_FILE (explicit Content read)\n--stage|--apply|--rollback --artifact=reviewed.json --reviewed-sha256=SHA256\nRemote operations require the internal Content feature gate; never use during local validation.',
    );
    return;
  }
  if (options.mode === 'prepare') {
    if (!options.source || !options['output-dir'] || !options['reel-id'])
      throw new Error(
        'Preparation requires one explicit Reel, local source and new output directory',
      );
    if (!/^[0-9a-f-]{36}$/i.test(options['reel-id']))
      throw new Error('Invalid Reel ID');
    const outputDir = path.resolve(options['output-dir']);
    const media = await prepareHls({ source: options.source, outputDir });
    const artifact = {
      reelId: options['reel-id'],
      outputDir,
      sourceMode: 'PUBLISHED_HLS',
      media,
    };
    writePrivate(path.join(outputDir, 'preparation.json'), artifact);
    console.log(
      JSON.stringify({
        mode: 'LOCAL_PREPARATION',
        reelId: artifact.reelId,
        outputDir,
        variants: media.validation.variants,
        cutoverReady: false,
      }),
    );
    return;
  }
  if (options.mode === 'review') {
    const preparation = JSON.parse(fs.readFileSync(options.artifact, 'utf8'));
    const snapshot = JSON.parse(
      fs.readFileSync(options['snapshot-file'], 'utf8'),
    );
    const artifact = {
      outputDir: preparation.outputDir,
      ...makePlan(preparation, snapshot),
    };
    await verifyLocalFiles(artifact);
    const destination = path.join(preparation.outputDir, 'reviewed.json');
    writePrivate(destination, artifact);
    console.log(
      JSON.stringify({
        mode: 'REVIEW',
        artifact: destination,
        reviewedSha256: artifact.reviewedSha256,
      }),
    );
    return;
  }
  if (options.mode === 'dry-run') {
    const artifact = options.artifact
      ? readArtifact(options.artifact)
      : undefined;
    console.log(
      JSON.stringify({
        mode: 'DRY_RUN',
        remoteOperations: false,
        reelId: artifact?.plan.reelId ?? null,
        prefix: artifact
          ? `reels/${artifact.plan.reelId}/${artifact.plan.attemptId}`
          : null,
        reviewedSha256: artifact?.reviewedSha256 ?? null,
      }),
    );
    return;
  }
  let artifact;
  if (options.mode !== 'snapshot') {
    if (!options['reviewed-sha256'])
      throw new Error('Explicit reviewed artifact SHA256 is required');
    artifact = readArtifact(options.artifact, options['reviewed-sha256']);
  } else if (
    !options['reel-id'] ||
    !options['snapshot-file'] ||
    fs.existsSync(options['snapshot-file'])
  )
    throw new Error('Snapshot requires an explicit Reel and a new file');
  // No environment, broker, storage or provider client is loaded in local/default modes.
  require('dotenv').config({ quiet: true });
  const { publishRmqMessage } = require('../send-rmq-message.cjs');
  const send = (pattern, payload) =>
    publishRmqMessage({
      queue: 'content_queue',
      pattern,
      payload,
      timeoutMs: 300_000,
    });
  if (options.mode === 'snapshot') {
    const snapshot = await send('content.snapshot_reel_hls', {
      reelId: options['reel-id'],
    });
    writePrivate(options['snapshot-file'], snapshot);
    console.log(
      JSON.stringify({ mode: 'SNAPSHOT', file: options['snapshot-file'] }),
    );
    return;
  }
  const { plan, reviewedSha256 } = artifact;
  if (options.mode === 'stage') {
    await verifyLocalFiles(artifact);
    await send('content.replace_reel_hls', {
      action: 'RESERVE',
      plan,
      reviewedSha256,
    });
    const { S3Client } = require('@aws-sdk/client-s3');
    const { s3Storage } = require('../narto-scraper/publish-hls.cjs');
    const client = new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
    try {
      const storage = s3Storage(client, process.env.R2_BUCKET_NAME);
      const prefix = `reels/${plan.reelId}/${plan.attemptId}`;
      for (const file of plan.files)
        await storage.put(
          `${prefix}/${file.path}`,
          fs.readFileSync(path.join(artifact.outputDir, file.path)),
          file.path.endsWith('.m3u8')
            ? 'application/vnd.apple.mpegurl'
            : file.path.endsWith('.ts')
              ? 'video/mp2t'
              : 'image/jpeg',
        );
      await validatePublishedHls({ storage, reelId: plan.reelId, prefix });
      console.log(
        JSON.stringify({
          mode: 'STAGED',
          prefix,
          reviewedSha256,
          pointerChanged: false,
        }),
      );
    } finally {
      client.destroy();
    }
    return;
  }
  const result = await send('content.replace_reel_hls', {
    action: options.mode.toUpperCase(),
    plan,
    reviewedSha256,
  });
  console.log(
    JSON.stringify({
      mode: options.mode.toUpperCase(),
      reelId: plan.reelId,
      ...result,
    }),
  );
}

if (require.main === module)
  main().catch(() => {
    console.error(
      'HLS operation failed; inspect the reviewed artifact, validation evidence and expected state before retrying.',
    );
    process.exitCode = 1;
  });
module.exports = { parseArgs, makePlan, readArtifact, verifyLocalFiles, main };
