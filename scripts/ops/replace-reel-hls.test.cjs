'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const {
  parseArgs,
  main,
  makePlan,
  readArtifact,
  verifyLocalFiles,
} = require('./replace-reel-hls.cjs');

const operations = [
  'dry-run',
  'snapshot',
  'prepare',
  'review',
  'stage',
  'apply',
  'rollback',
];

test('each explicit operation remains valid', () => {
  for (const mode of operations)
    assert.deepEqual(parseArgs([`--${mode}`]), { mode });
});

for (const first of operations)
  for (const second of operations)
    test(`rejects --${first} then --${second}, including interleaved values`, async () => {
      for (const args of [
        [`--${first}`, `--${second}`],
        [
          '--reel-id=one-reel',
          `--${first}`,
          '--artifact=missing.json',
          `--${second}`,
          '--reviewed-sha256=missing',
        ],
      ]) {
        assert.throws(() => parseArgs(args), /Choose one operation/);
        await assert.rejects(main(args), /Choose one operation/);
      }
    });

test('CLI rejects combined flags before artifact reads, environment initialization or remote-client loading', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-cli-'));
  try {
    const guard = path.join(dir, 'guard.cjs');
    const missingArtifact = path.join(dir, 'missing.json');
    fs.writeFileSync(
      guard,
      `
      const Module = require('node:module');
      const fs = require('node:fs');
      const load = Module._load;
      Module._load = function (id, ...args) {
        if (id === 'dotenv')
          return { ...load.call(this, id, ...args), config() { process.exit(99); } };
        if (id === '@aws-sdk/client-s3' ||
            id.endsWith('send-rmq-message.cjs') || id.endsWith('publish-hls.cjs'))
          process.exit(99);
        return load.call(this, id, ...args);
      };
      const read = fs.readFileSync;
      fs.readFileSync = function (file, ...args) {
        if (file === ${JSON.stringify(missingArtifact)}) process.exit(98);
        return read.call(this, file, ...args);
      };
    `,
    );
    const result = spawnSync(
      process.execPath,
      [
        '--require',
        guard,
        require.resolve('./replace-reel-hls.cjs'),
        '--dry-run',
        `--artifact=${missingArtifact}`,
        '--apply',
        '--reviewed-sha256=missing',
      ],
      { encoding: 'utf8', env: {}, timeout: 10_000 },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /HLS operation failed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('default and help are offline; apply requires an explicit reviewed digest', async () => {
  assert.equal(parseArgs([]).mode, 'dry-run');
  assert.throws(() => parseArgs(['--all']));
  assert.throws(() => parseArgs(['--apply', '--rollback']));
  await main([]);
  await assert.rejects(main(['--apply', '--artifact=missing.json']), /SHA256/);
});

test('review binds a single Reel snapshot, local bytes and immutable attempt; tampering fails closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-review-'));
  try {
    const texts = {
      'master.m3u8':
        '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=750000\n0/stream.m3u8\n',
      '0/stream.m3u8':
        '#EXTM3U\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXTINF:2,\nsegment_000000.ts\n#EXT-X-ENDLIST\n',
      '0/segment_000000.ts': 'bytes',
      'thumbnail.jpg': 'thumbnail',
    };
    fs.mkdirSync(path.join(dir, '0'));
    for (const [name, text] of Object.entries(texts))
      fs.writeFileSync(path.join(dir, name), text);
    const reelId = '12345678-1234-4234-8234-123456789abc';
    const snapshot = {
      reelId,
      userId: 'owner',
      expectedUpdatedAt: '2026-10-20T00:00:00.000Z',
      previousHlsMasterKey: `reels/${reelId}/master.m3u8`,
      mediaKeySha256: 'a'.repeat(64),
      mediaAttemptId: null,
      indexAttemptId: null,
    };
    const preparation = {
      reelId,
      media: {
        sourceSha256: 'b'.repeat(64),
        outputDurationMs: 2000,
        profile: {
          segmentSeconds: 2,
          outputFps: 25,
          variants: [{ name: '360p', width: 360, height: 640 }],
        },
        validation: {
          files: Object.entries(texts).map(([name, text]) => ({
            path: name,
            bytes: Buffer.byteLength(text),
            sha256: createHash('sha256').update(text).digest('hex'),
          })),
        },
      },
    };
    const artifact = { outputDir: dir, ...makePlan(preparation, snapshot) };
    const artifactFile = path.join(dir, 'reviewed.json');
    fs.writeFileSync(artifactFile, JSON.stringify(artifact));
    assert.equal(
      readArtifact(artifactFile, artifact.reviewedSha256).plan.reelId,
      reelId,
    );
    await verifyLocalFiles(artifact);
    assert.throws(
      () => makePlan(preparation, { ...snapshot, reelId: 'other' }),
      /different Reel/,
    );
    assert.throws(() => readArtifact(artifactFile, 'incorrect'), /checksum/);
    fs.writeFileSync(path.join(dir, '0/segment_000000.ts'), 'other');
    await assert.rejects(verifyLocalFiles(artifact), /differs/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
