'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { validatePublishedHls } = require('./hls.cjs');

async function publishImportedHls({
  reel,
  prepared,
  outputDir,
  db,
  storage,
  cdn,
  attemptId = randomUUID(),
  validate = validatePublishedHls,
}) {
  if (reel.hlsMasterKey)
    throw new Error('Existing HLS requires reviewed replacement preparation');
  const prefix = `reels/${reel.id}/${attemptId}`;
  const expected = {
    id: reel.id,
    userId: reel.userId,
    mediaKey: reel.mediaKey,
    hlsMasterKey: null,
    updatedAt: reel.updatedAt,
  };
  await db.$transaction(async (tx) => {
    const current = await tx.reel.findFirst({ where: expected });
    if (!current) throw new Error('Import changed before upload');
    await tx.reelMediaAttemptLease.create({
      data: {
        attemptId,
        reelId: reel.id,
        expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
      },
    });
  });
  let cdnSucceeded = false;
  if (cdn) {
    try {
      await cdn.uploadHlsDirectory(outputDir);
      cdnSucceeded = true;
    } catch (err) {
      console.warn(
        `[CDN WARNING] TikTok CDN upload failed (${err.message}), falling back to R2 direct storage`,
      );
    }
  }
  // If CDN succeeded, only upload playlists and thumbnail to R2 (segments are on TikTok CDN).
  // If CDN failed or was omitted, upload all files (including .ts segments) directly to R2.
  const filesToUpload = cdnSucceeded
    ? prepared.validation.files.filter(
        ({ path: name }) => name.endsWith('.m3u8') || name === 'thumbnail.jpg',
      )
    : prepared.validation.files;

  for (const file of filesToUpload) {
    const contentType = file.path.endsWith('.m3u8')
      ? 'application/vnd.apple.mpegurl'
      : file.path.endsWith('.ts')
        ? 'video/mp2t'
        : 'image/jpeg';
    await storage.put(
      `${prefix}/${file.path}`,
      fs.readFileSync(path.join(outputDir, file.path)),
      contentType,
    );
  }
  await validate({ storage, reelId: reel.id, prefix });
  const source = prepared.sourceMetadata;
  const classification = prepared.classification;
  let transcriptionAudioManifestKey = null;
  let hasStagedAudio = false;

  if (prepared.audioManifest) {
    const audioPrefix = `${prefix}/transcription/${attemptId}`;
    const uploadedArtifacts = [];
    for (const artifact of prepared.audioManifest.artifacts) {
      const artifactPath = path.join(outputDir, artifact.filename);
      if (fs.existsSync(artifactPath)) {
        const destKey = `${audioPrefix}/${path.basename(artifact.filename)}`;
        await storage.put(
          destKey,
          fs.readFileSync(artifactPath),
          artifact.format === 'flac' ? 'audio/flac' : 'audio/wav',
        );
        uploadedArtifacts.push({
          key: destKey,
          startMs: artifact.startMs,
          endMs: artifact.endMs,
          overlapBeforeMs: artifact.overlapBeforeMs,
          checksum: artifact.checksum,
          byteLength: artifact.byteLength,
        });
      }
    }
    if (uploadedArtifacts.length > 0) {
      const manifestPayload = {
        reelId: reel.id,
        mediaAttemptId: attemptId,
        totalDurationMs: prepared.outputDurationMs,
        format: prepared.audioManifest.format || 'wav',
        artifacts: uploadedArtifacts,
        version: 1,
      };
      const manifestKey = `${audioPrefix}/manifest.json`;
      await storage.put(
        manifestKey,
        Buffer.from(JSON.stringify(manifestPayload)),
        'application/json',
      );
      transcriptionAudioManifestKey = manifestKey;
      hasStagedAudio = true;
    }
  }

  const updated = await db.$transaction(async (tx) => {
    const result = await tx.reel.updateMany({
      where: expected,
      data: {
        mediaAttemptId: attemptId,
        hlsMasterKey: `${prefix}/master.m3u8`,
        transcriptionAudioManifestKey,
        processingStage: 'INDEX_QUEUED',
        sourceDurationMs: source.durationMs,
        outputDurationMs: prepared.outputDurationMs,
        sourceWidth: source.width,
        sourceHeight: source.height,
        sourceFps: source.fps,
        sourceBitrateKbps: source.bitrateKbps,
        sourceHasAudio: hasStagedAudio,
        sourceRotation: source.rotation,
        sourceOrientation: classification.orientation,
        sourceLengthClass: classification.mediaClass,
        sourceAspectRatio: classification.aspectRatio,
        sourceEffectiveWidth: classification.effectiveWidth,
        sourceEffectiveHeight: classification.effectiveHeight,
        encodedVariantCount: prepared.profile.variants.length,
        encodedMaxHeight: Math.max(
          ...prepared.profile.variants.map((variant) => variant.height),
        ),
        encodedFps: prepared.profile.outputFps,
      },
    });
    if (result.count !== 1)
      throw new Error(
        'Import changed before publication; immutable output was not adopted',
      );
    await tx.reelMediaAttemptLease.update({
      where: { attemptId },
      data: { completedAt: new Date() },
    });
    return `${prefix}/master.m3u8`;
  });
  return updated;
}

function s3Storage(client, bucket) {
  const {
    PutObjectCommand,
    HeadObjectCommand,
    GetObjectCommand,
  } = require('@aws-sdk/client-s3');
  return {
    async put(key, body, contentType) {
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: contentType,
            IfNoneMatch: '*',
            CacheControl: 'public, max-age=31536000, immutable',
          }),
        );
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 412) throw error;
        const existing = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
        );
        if (existing.ContentLength !== body.length)
          throw new Error(
            'Immutable HLS object already exists with different bytes',
          );
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of existing.Body) {
          bytes += chunk.length;
          if (bytes > body.length)
            throw new Error('Immutable HLS object exceeds expected size');
          hash.update(chunk);
        }
        if (
          bytes !== body.length ||
          hash.digest('hex') !== createHash('sha256').update(body).digest('hex')
        )
          throw new Error('Immutable HLS object checksum differs');
      }
    },
    async objectExists(key) {
      try {
        const result = await client.send(
          new HeadObjectCommand({ Bucket: bucket, Key: key }),
        );
        return result.ContentLength > 0;
      } catch {
        return false;
      }
    },
    async getObjectText(key) {
      const result = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
      );
      return result.Body.transformToString();
    },
  };
}

module.exports = { publishImportedHls, s3Storage };
