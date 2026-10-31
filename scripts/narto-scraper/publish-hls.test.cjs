'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { publishImportedHls, s3Storage } = require('./publish-hls.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-publish-test-'));
  fs.writeFileSync(path.join(dir, 'master.m3u8'), '#EXTM3U');
  const writes = [];
  const leases = [];
  const tx = {
    reel: {
      findFirst: async () => ({}),
      updateMany: async (value) => {
        writes.push(value);
        return { count: 1 };
      },
    },
    reelMediaAttemptLease: {
      create: async (value) => leases.push(value),
      update: async () => {},
    },
  };
  return {
    dir,
    writes,
    leases,
    tx,
    args: {
      reel: {
        id: '12345678-1234-1234-1234-123456789abc',
        userId: 'owner',
        mediaKey: 'https://source.example/a.mp4',
        hlsMasterKey: null,
        updatedAt: new Date(),
      },
      prepared: {
        validation: { files: [{ path: 'master.m3u8' }] },
        sourceMetadata: {
          durationMs: 4000,
          width: 1080,
          height: 1920,
          fps: 25,
        },
        classification: { orientation: 'PORTRAIT', mediaClass: 'SHORT' },
        profile: { outputFps: 25, variants: [{ width: 360, height: 640 }] },
      },
      outputDir: dir,
      db: { $transaction: async (callback) => callback(tx) },
      storage: { put: async () => {} },
      cdn: { uploadHlsDirectory: async () => {} },
      validate: async () => {},
    },
  };
}

test('immutable uploads are conditional and never overwrite shared URLs', async () => {
  const calls = [];
  await s3Storage(
    { send: async (command) => calls.push(command.input) },
    'bucket',
  ).put(
    'reels/id/attempt/master.m3u8',
    Buffer.from('data'),
    'application/vnd.apple.mpegurl',
  );
  assert.equal(calls[0].IfNoneMatch, '*');
  assert.equal(calls[0].CacheControl, 'public, max-age=31536000, immutable');
});

test('partial staging can resume only when an existing immutable object has identical bytes', async () => {
  const { Readable } = require('node:stream');
  let body = Buffer.from('data');
  const client = {
    send: async (command) => {
      if (command.constructor.name === 'PutObjectCommand')
        throw { $metadata: { httpStatusCode: 412 } };
      return { ContentLength: body.length, Body: Readable.from([body]) };
    },
  };
  const storage = s3Storage(client, 'bucket');
  await storage.put('immutable', Buffer.from('data'), 'video/mp2t');
  body = Buffer.from('evil');
  await assert.rejects(
    storage.put('immutable', Buffer.from('data'), 'video/mp2t'),
    /checksum differs/,
  );
});

test('remote validation failure leaves the previous pointer untouched and lease retained', async () => {
  const f = fixture();
  try {
    await assert.rejects(
      publishImportedHls({
        ...f.args,
        validate: async () => {
          throw new Error('missing segment');
        },
      }),
      /missing segment/,
    );
    assert.equal(f.writes.length, 0);
    assert.equal(f.leases.length, 1);
  } finally {
    fs.rmSync(f.dir, { recursive: true });
  }
});

test('publication CAS binds source, owner, old pointer and updatedAt, and rejects a concurrent winner', async () => {
  const f = fixture();
  try {
    f.tx.reel.updateMany = async (value) => {
      f.writes.push(value);
      return { count: 0 };
    };
    await assert.rejects(
      publishImportedHls(f.args),
      /changed before publication/,
    );
    assert.equal(f.writes[0].where.mediaKey, f.args.reel.mediaKey);
    assert.equal(f.writes[0].where.updatedAt, f.args.reel.updatedAt);
    assert.equal(f.writes[0].where.hlsMasterKey, null);
    assert.match(
      f.writes[0].data.hlsMasterKey,
      /^reels\/12345678-1234-1234-1234-123456789abc\/[0-9a-f-]{36}\/master.m3u8$/,
    );
    await assert.rejects(
      publishImportedHls({
        ...f.args,
        reel: { ...f.args.reel, hlsMasterKey: 'already-playable' },
      }),
      /reviewed replacement/,
    );
  } finally {
    fs.rmSync(f.dir, { recursive: true });
  }
});
