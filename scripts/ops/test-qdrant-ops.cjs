const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { encrypt, decrypt, rotate } = require('./qdrant-backup.cjs');
const {
  argumentsFor,
  targetFingerprint,
  verifiedArtifact,
} = require('./reel-qdrant.cjs');
test('authenticated encrypted backup rejects tampering and wrong keys', () => {
  const key = Buffer.alloc(32, 9),
    value = { manifest: { version: 1 }, snapshot: 'private' };
  const encrypted = encrypt(value, key);
  assert.deepEqual(decrypt(encrypted, key), value);
  assert.equal(encrypted.includes(Buffer.from('private')), false);
  assert.throws(() => decrypt(encrypted, Buffer.alloc(32, 8)));
  encrypted[40] ^= 1;
  assert.throws(() => decrypt(encrypted, key));
  assert.throws(() => decrypt(Buffer.from('invalid'), key));
});
test('strict arguments and target fingerprints never include credentials', () => {
  assert.deepEqual(argumentsFor(['--directory=/tmp/test']), {
    directory: '/tmp/test',
  });
  for (const args of [['--directory'], ['--directory=a', '--directory=b']])
    assert.throws(() => argumentsFor(args));
  assert.equal(
    targetFingerprint('postgresql://alice:secret@localhost:5432/db'),
    targetFingerprint('postgresql://bob:other@localhost:5432/db'),
  );
});
test('rotation touches only owned archives and traversal artifacts are rejected', async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'qdrant-ops-'));
  try {
    await fs.writeFile(join(directory, 'unrelated.backup'), 'keep');
    for (let i = 0; i < 9; i++)
      await fs.writeFile(
        join(directory, `velora-qdrant-170000000000${i}-aaaaaaaa.vqb`),
        'encrypted',
      );
    await rotate(directory, 7);
    assert.equal((await fs.readdir(directory)).length, 8);
    assert.equal(
      await fs.readFile(join(directory, 'unrelated.backup'), 'utf8'),
      'keep',
    );
    await assert.rejects(
      verifiedArtifact(directory, { file: '../secret', rows: 1, sha256: 'x' }),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
