'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseArgs, main, coordinate, persist, privateRead, digest, protectedFingerprint,
  snapshot, inventoryEntry, reconcile, databaseAdapter,
} = require('./reencode-existing-reels.cjs');

const id = 'ad989463-021e-496d-8345-bc9e91f00a13';
const attempt = 'ad989463-021e-496d-8345-bc9e91f00a14';
const sha = 'a'.repeat(64);
const eventType = 'REEL_HLS_CACHE_INVALIDATION_V1';
function row(reelId = id) {
  return { id: reelId, userId: 'owner', mediaKey: `reels/${reelId}/original.mp4`,
    hlsMasterKey: `reels/${reelId}/master.m3u8`, updatedAt: '2026-10-30T00:00:00.000Z',
    mediaStatus: 'COMPLETED', indexStatus: 'COMPLETED', mediaAttemptId: null, indexAttemptId: null,
    outputDurationMs: 2000, transcript: 'preserve me', indexVersion: 'v1', thumbnailKey: 'old/thumbnail.jpg',
    mediaOutput: { audioManifestKey: 'audio/manifest.json', checksums: { audio: 'old', hlsMasterSha256: 'old' } } };
}
const live = (r = row()) => ({ row: r, events: [], leases: [] });
const plan = (r = row()) => ({ ...snapshot(r), attemptId: attempt });
const artifact = (r = row()) => ({ plan: plan(r), reviewedSha256: sha, outputDir: '/unused' });
const entry = (r = row()) => inventoryEntry(live(r));
const lease = () => ({ attemptId: attempt, reelId: id, completedAt: null,
  expiresAt: new Date(Date.now() + 3_600_000).toISOString() });

test('default remains offline and does not even read injected dependencies', async () => {
  const deps = new Proxy({}, { get() { throw new Error('Unexpected dependency access'); } });
  assert.deepEqual(parseArgs([]), { mode: 'dry-run' });
  await main([], deps);
  await main(['--dry-run'], deps);
  await main(['--help'], deps);
});

for (const [mode, extra] of [
  ['inventory', []], ['reconcile', ['--limit=1']],
  ['prepare', ['--limit=1', `--inventory-sha256=${sha}`, '--media-origin=https://media.example.com']],
  ['stage', ['--limit=1', '--approval-file=/private/approval.json', `--reviewed-sha256=${sha}`]],
  ['apply', ['--limit=1', '--approval-file=/private/approval.json', `--reviewed-sha256=${sha}`]],
]) {
  const args = [`--${mode}`, '--run-dir=/private/held-run', ...extra];
  test(`${mode} requires hold release before loading any dependency or touching inventory state`, async (t) => {
    t.mock.method(require('node:module'), '_load', () => assert.fail('Dependency loaded during hold'));
    for (const method of ['mkdirSync', 'lstatSync', 'openSync', 'readFileSync'])
      t.mock.method(fs, method, () => assert.fail('Filesystem inventory accessed during hold'));
    assert.throws(() => parseArgs(args), /release the hold/);
    await assert.rejects(main(args), /release the hold/);
    await assert.rejects(main(args, new Proxy({}, { get() { assert.fail('Dependencies accessed'); } })), /release the hold/);
  });
  test(`${mode} accepts an explicit hold release acknowledgement`, () => {
    const options = parseArgs([...args, '--hold-released']);
    assert.equal(options.mode, mode);
    assert.equal(options['hold-released'], true);
    if (mode !== 'inventory') assert.equal(options.limit, 1);
  });
  test(`direct ${mode} coordinator call rejects before reading run directory or dependencies`, async () => {
    const dependencies = new Proxy({}, { get() { assert.fail('Dependencies accessed'); } });
    for (const acknowledgement of [undefined, false, 'true']) {
      await assert.rejects(coordinate({ mode, 'hold-released': acknowledgement,
        get ['run-dir']() { assert.fail('Run directory accessed'); } }, dependencies), /release the hold/);
    }
  });
}

for (const args of [
  ['--inventory', '--apply'], ['--apply', '--dry-run'], ['--stage', '--stage'],
  ['--dry-run', '--run-dir=/tmp/no'], ['--inventory', '--hold-released=true', '--run-dir=/tmp/no'],
  ['--inventory', '--limit=1', '--run-dir=/tmp/no'], ['--inventory', '--run-dir='],
  ['--prepare', '--run-dir=/tmp/no', '--limit=0'], ['--prepare', '--run-dir=/tmp/no', '--limit=6'],
  ['--prepare', '--run-dir=/tmp/no', '--limit=1'],
  ['--apply', '--run-dir=/tmp/no', '--limit=1', '--hold-released'],
  ['--apply', '--run-dir=/tmp/no', '--limit=1', '--hold-released', '--approval-file=a', '--reviewed-sha256=no'],
]) test('invalid or conflicting operations reject before accessing remote dependencies', async () => {
  await assert.rejects(main(args, new Proxy({}, { get() { assert.fail('Dependencies accessed'); } })));
});

test('digest is stable across object key order and binds values', () => {
  assert.equal(digest({ a: 1, b: { c: 2, d: 3 } }), digest({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
});

test('private persistence is atomic, restrictive, and refuses existing immutable files and symlinks', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reencode-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'state.json');
  persist(file, { status: 'one' }, true);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.throws(() => persist(file, {}, true));
  persist(file, { status: 'two' });
  assert.deepEqual(privateRead(file), { status: 'two' });
  assert.deepEqual(fs.readdirSync(dir), ['state.json']);
  fs.symlinkSync(file, path.join(dir, 'alias.json'));
  assert.throws(() => privateRead(path.join(dir, 'alias.json')));
  fs.chmodSync(file, 0o644);
  assert.throws(() => privateRead(file));
});

test('inventory classification includes private/unplayable/busy Reels without storing external URLs', () => {
  assert.equal(inventoryEntry(live({ ...row(), visibility: 'private' })).status, 'PENDING');
  assert.equal(inventoryEntry(live({ ...row(), hlsMasterKey: null })).status, 'OUT_OF_SCOPE');
  assert.equal(inventoryEntry(live({ ...row(), indexStatus: 'PROCESSING' })).status, 'DEFERRED');
  assert.equal(inventoryEntry({ ...live(), events: [{ eventType: 'INDEX_REEL', publishedAt: null }] }).status, 'DEFERRED');
  assert.equal(inventoryEntry(live({ ...row(), sourceDurationMs: null, outputDurationMs: null })).status, 'BLOCKED');
  const invalid = inventoryEntry(live({ ...row(), hlsMasterKey: 'https://external.example.com/master.m3u8?secret=private' }));
  assert.equal(invalid.status, 'BLOCKED');
  assert.equal(invalid.snapshot, null);
  assert.ok(!JSON.stringify(invalid).includes('secret'));
});

test('ownership matches Content for legacy and user-owned masters while retaining safe master paths', () => {
  for (const key of [`reels/${id}/master.m3u8`, `reels/${id}/${attempt}/master.m3u8`,
    `reels/${id}/master-v20260923T121215633Z.m3u8`,
    'reels/owner/published/master.m3u8', 'chat-videos/owner/published/master.m3u8']) {
    const result = entry({ ...row(), hlsMasterKey: key });
    assert.equal(result.status, 'PENDING', key);
    assert.equal(result.snapshot.previousHlsMasterKey, key);
  }
  for (const key of [`reels/${id}/not-an-attempt-uuid/master.m3u8`,
    `reels/${id}/master-vinvalid.m3u8`, `reels/another-owner/master-v20260923T121215633Z.m3u8`,
    'reels/another-owner/master.m3u8', 'chat-videos/another-owner/master.m3u8',
    'reels/owner/published/variant.m3u8', 'reels/owner/../master.m3u8',
    'reels/owner/./master.m3u8', 'reels/owner//master.m3u8',
    '/reels/owner/master.m3u8', 'reels/owner/dir\\master.m3u8', 'reels/owner/master.m3u8?token=secret']) {
    const result = entry({ ...row(), hlsMasterKey: key });
    assert.equal(result.status, 'BLOCKED', key);
    assert.equal(result.snapshot, null, key);
  }
});

test('protected fingerprint permits only the reviewed encoding field changes', () => {
  const before = row(), after = structuredClone(before);
  Object.assign(after, { updatedAt: 'new', hlsMasterKey: 'new', encodedFps: 30, encodedVariantCount: 2, encodedMaxHeight: 720 });
  Object.assign(after.mediaOutput, { hlsMasterKey: 'new', variants: [], hlsObjectCount: 4, hlsTotalBytes: 100 });
  after.mediaOutput.checksums.hlsMasterSha256 = 'new';
  assert.equal(protectedFingerprint(before), protectedFingerprint(after));
  for (const key of ['transcript', 'indexVersion', 'thumbnailKey', 'mediaAttemptId', 'indexAttemptId', 'mediaKey', 'visibility', 'mediaEdit'])
    assert.notEqual(protectedFingerprint(before), protectedFingerprint({ ...after, [key]: 'changed' }));
  after.mediaOutput.checksums.audio = 'changed';
  assert.notEqual(protectedFingerprint(before), protectedFingerprint(after));
});

test('reconciliation distinguishes unchanged/reserved and rejects stale versions, fields and expired leases', () => {
  const e = entry(), a = artifact();
  assert.equal(reconcile(e, live(), a).status, 'UNCHANGED');
  assert.equal(reconcile(e, { ...live(), leases: [lease()] }, a).status, 'RESERVED');
  assert.throws(() => reconcile(e, live({ ...row(), updatedAt: '2026-10-30T00:00:01.000Z' }), a), /Stale/);
  assert.throws(() => reconcile(e, live({ ...row(), transcript: 'changed' }), a), /Protected/);
  assert.throws(() => reconcile(e, { ...live(), leases: [{ ...lease(), expiresAt: '2000-01-01' }] }, a), /expired/);
  assert.throws(() => reconcile(e, { row: null }, a), /no longer exists/);
});

function commit(state, r = row()) {
  state.row.hlsMasterKey = `reels/${r.id}/${attempt}/master.m3u8`;
  state.row.updatedAt = '2026-10-30T00:01:00.000Z';
  state.events.push({ id: attempt, aggregateId: r.id, aggregateType: 'REEL', eventType,
    publishedAt: null, payload: { reviewedSha256: sha, appliedUpdatedAt: state.row.updatedAt,
      previous: { hlsMasterKey: r.hlsMasterKey } } });
}

test('lost apply acknowledgement is reconciled by exact receipt/pointer/version, including pending cache delivery', () => {
  const state = live(); commit(state);
  const e = entry(), a = artifact();
  assert.equal(reconcile(e, state, a).status, 'APPLIED_CACHE_PENDING');
  state.events[0].publishedAt = '2026-10-30T00:01:01.000Z';
  assert.equal(reconcile(e, state, a).status, 'APPLIED');
  state.events[0].payload.reviewedSha256 = 'wrong';
  assert.throws(() => reconcile(e, state, a), /Ambiguous/);
  state.events = [];
  assert.throws(() => reconcile(e, state, a), /Stale/);
});

test('rollback receipts, competing leases, changed applied rows and unrelated pipeline events block resume', () => {
  const e = entry(), a = artifact(), state = live();
  state.events.push({ id: `${attempt}:rollback`, eventType, publishedAt: new Date().toISOString() });
  assert.throws(() => reconcile(e, state, a), /rolled back/);
  state.events = [];
  state.leases.push({ ...lease(), attemptId: 'another' });
  assert.throws(() => reconcile(e, state, a), /idle/);
  state.leases = [];
  commit(state);
  state.row.updatedAt = '2026-10-30T00:02:00.000Z';
  assert.throws(() => reconcile(e, state, a), /Ambiguous/);
  state.events.push({ id: 'job', eventType: 'REEL_INDEX', publishedAt: null });
  assert.throws(() => reconcile(e, state, a), /idle/);
});

async function fixture(t, size = 1) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'reencode-run-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const directory = path.join(parent, 'run'), states = new Map();
  const ids = [id, 'ad989463-021e-496d-8345-bc9e91f00a15'];
  for (const reelId of ids.slice(0, size)) states.set(reelId, live(row(reelId)));
  const calls = [], deps = {
    db: { inventory: async () => [...states.values()].map(inventoryEntry),
      live: async (reelId) => structuredClone(states.get(reelId)), close: async () => {} },
    hls: {}, verifyEncodedTimelines: async () => {},
    materialize: async () => { assert.fail('Unexpected source acquisition'); },
    replacement: { readArtifact: (file) => privateRead(file), verifyLocalFiles: async () => {},
      main: async (args) => {
        const a = privateRead(args[1].slice('--artifact='.length));
        calls.push({ operation: args[0], reelId: a.plan.reelId });
        const state = states.get(a.plan.reelId);
        if (args[0] === '--stage') state.leases.push({ ...lease(), reelId: a.plan.reelId });
        else commit(state, row(a.plan.reelId));
      } }, inspectObjects: async () => ({ complete: true }),
  };
  const inventory = await coordinate({ mode: 'inventory', 'run-dir': directory, 'hold-released': true }, deps);
  const approvalFile = path.join(parent, 'approval.json');
  const approvals = ids.slice(0, size).map((reelId) => ({ reelId, reviewedSha256: sha }));
  persist(approvalFile, approvals, true);
  for (const reelId of ids.slice(0, size)) {
    const reelDir = path.join(directory, reelId); fs.mkdirSync(reelDir, { mode: 0o700 });
    persist(path.join(reelDir, 'reviewed.json'), artifact(row(reelId)), true);
  }
  const options = (mode, limit = 1) => ({ mode, 'run-dir': directory, limit, 'hold-released': true,
    'approval-file': approvalFile, 'reviewed-sha256': digest(approvals) });
  return { directory, states, deps, calls, options, inventory, progress: () => privateRead(path.join(directory, 'progress.json')) };
}

test('inventory creates a frozen private manifest and duplicate invocation cannot overwrite it', async (t) => {
  const f = await fixture(t);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const manifest = privateRead(path.join(f.directory, 'inventory.json'));
  assert.equal(digest(manifest), f.inventory.inventorySha256);
  assert.equal(f.progress().inventorySha256, f.inventory.inventorySha256);
  assert.equal(f.calls.length, 0);
  await assert.rejects(coordinate({ mode: 'inventory', 'run-dir': f.directory, 'hold-released': true }, f.deps));
  assert.equal(digest(privateRead(path.join(f.directory, 'inventory.json'))), f.inventory.inventorySha256);
});

test('read-only adapter cursor-paginates inside read-only repeatable-read transactions', async () => {
  let pages = 0, directive;
  const tx = { $executeRawUnsafe: async (sql) => { directive = sql; },
    reel: { findMany: async (args) => {
      assert.equal(args.take, 100);
      if (++pages === 1) return [row()];
      assert.deepEqual(args.cursor, { id }); assert.equal(args.skip, 1); return [];
    } }, outboxEvent: { findMany: async () => [] }, reelMediaAttemptLease: { findMany: async () => [] } };
  const adapter = databaseAdapter({ $transaction: async (fn, options) => {
    assert.equal(options.isolationLevel, 'RepeatableRead'); return fn(tx);
  } });
  assert.equal((await adapter.inventory()).length, 1);
  assert.equal(directive, 'SET TRANSACTION READ ONLY');
});

test('batch stays sequential and stops at the explicit per-invocation limit', async (t) => {
  const f = await fixture(t, 2);
  await coordinate(f.options('stage', 1), f.deps);
  assert.deepEqual(f.calls, [{ operation: '--stage', reelId: id }]);
  assert.equal(f.progress().entries[id].status, 'STAGED');
  assert.equal(f.progress().entries['ad989463-021e-496d-8345-bc9e91f00a15'], undefined);
  await coordinate(f.options('apply', 1), f.deps);
  assert.equal(f.calls[1].operation, '--apply');
  assert.equal(f.progress().entries[id].status, 'APPLIED_CACHE_PENDING');
  assert.equal(f.states.get(id).row.transcript, 'preserve me');
  assert.deepEqual(f.states.get(id).events.map((e) => e.eventType), [eventType]);
});

test('stage/prepare/applied invocations do not blindly duplicate an operation', async (t) => {
  const f = await fixture(t);
  await coordinate(f.options('stage'), f.deps);
  await coordinate(f.options('stage'), f.deps);
  assert.equal(f.calls.length, 1);
  await coordinate(f.options('apply'), f.deps);
  await coordinate(f.options('apply'), f.deps);
  assert.equal(f.calls.length, 2);
});

test('apply timeout with committed pointer is UNKNOWN until explicit live reconciliation', async (t) => {
  const f = await fixture(t);
  await coordinate(f.options('stage'), f.deps);
  const original = f.deps.replacement.main;
  f.deps.replacement.main = async (args) => { await original(args); throw new Error('secret=not-persisted'); };
  await assert.rejects(coordinate(f.options('apply'), f.deps));
  assert.equal(f.progress().entries[id].status, 'UNKNOWN');
  assert.ok(!JSON.stringify(f.progress()).includes('secret'));
  await coordinate({ mode: 'reconcile', 'run-dir': f.directory, limit: 1, 'hold-released': true }, f.deps);
  assert.equal(f.progress().entries[id].status, 'APPLIED_CACHE_PENDING');
  assert.equal(f.calls.length, 2);
});

test('partial staging resumes only after live lease and existing object hashes are reconciled', async (t) => {
  const f = await fixture(t);
  const original = f.deps.replacement.main;
  f.deps.replacement.main = async (args) => { await original(args); throw new Error('lost response'); };
  await assert.rejects(coordinate(f.options('stage'), f.deps));
  assert.equal(f.progress().entries[id].status, 'UNKNOWN');
  await assert.rejects(coordinate(f.options('stage'), f.deps));
  assert.equal(f.calls.length, 1);
  f.deps.inspectObjects = async () => ({ complete: false });
  await coordinate({ mode: 'reconcile', 'run-dir': f.directory, limit: 1, 'hold-released': true }, f.deps);
  assert.equal(f.progress().entries[id].status, 'RESERVED');
  f.deps.replacement.main = original;
  await coordinate(f.options('stage'), f.deps);
  assert.equal(f.progress().entries[id].status, 'STAGED');
});

test('apply without confirmed staging or with remote graph mismatch never calls mutation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(coordinate(f.options('apply'), f.deps));
  assert.equal(f.calls.length, 0);
  await coordinate(f.options('stage'), f.deps);
  f.deps.inspectObjects = async () => { throw new Error('bad hash'); };
  await assert.rejects(coordinate(f.options('apply'), f.deps));
  assert.equal(f.calls.length, 1);
});

test('inventory tampering, approval changes and concurrent invocation block before mutation', async (t) => {
  const f = await fixture(t);
  await assert.rejects(coordinate({ ...f.options('stage'), 'reviewed-sha256': 'b'.repeat(64) }, f.deps));
  assert.equal(f.calls.length, 0);
  const lock = path.join(f.directory, 'operator.lock');
  fs.writeFileSync(lock, 'existing', { flag: 'wx', mode: 0o600 });
  await assert.rejects(coordinate(f.options('stage'), f.deps));
  assert.equal(fs.readFileSync(lock, 'utf8'), 'existing');
  fs.unlinkSync(lock);
  const file = path.join(f.directory, 'inventory.json');
  const manifest = privateRead(file); manifest.entries[0].snapshot.expectedUpdatedAt = 'new'; persist(file, manifest);
  await assert.rejects(coordinate(f.options('stage'), f.deps));
  assert.equal(f.calls.length, 0);
});

test('foreign-owner malformed attempt master blocks preparation before media fetch or encoding', async (t) => {
  const f = await fixture(t);
  f.states.get(id).row.hlsMasterKey = `reels/${id}/not-an-attempt-uuid/master.m3u8`;
  f.deps.materialize = async () => assert.fail('Foreign media fetched');
  f.deps.hls.prepareHls = async () => assert.fail('Foreign media encoded');
  await assert.rejects(coordinate({ mode: 'prepare', 'run-dir': f.directory, limit: 1, 'hold-released': true,
    'inventory-sha256': f.inventory.inventorySha256, 'media-origin': 'https://media.example.com' }, f.deps), /Batch stopped safely/);
  assert.equal(f.progress().entries[id].status, 'BLOCKED');
  assert.equal(f.calls.length, 0);
});

test('preparation reuses a completed reviewed artifact without cropping or encoding again', async (t) => {
  const f = await fixture(t);
  f.deps.hls.prepareHls = () => { assert.fail('Unexpected encoding'); };
  await coordinate({ mode: 'prepare', 'run-dir': f.directory, limit: 1, 'hold-released': true,
    'inventory-sha256': f.inventory.inventorySha256, 'media-origin': 'https://media.example.com' }, f.deps);
  assert.equal(f.progress().entries[id].status, 'PREPARED');
});

test('preparation passes only the already-published local source to prepareHls', async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.directory, id, 'reviewed.json'));
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 16 * 1024 ** 3, bsize: 1 }));
  f.deps.materialize = async ({ outputDir, expectedDurationMs }) => {
    assert.equal(expectedDurationMs, 2000);
    fs.mkdirSync(outputDir, { mode: 0o700 });
    const source = path.join(outputDir, 'source.mp4'); fs.writeFileSync(source, 'fake', { mode: 0o600 });
    return { source };
  };
  f.deps.hls.prepareHls = async (options) => {
    assert.deepEqual(Object.keys(options).sort(), ['outputDir', 'source']);
    assert.ok(options.source.endsWith('/source/source.mp4'));
    return { outputDurationMs: 2000 };
  };
  f.deps.replacement.makePlan = (preparation, reviewed) => {
    assert.equal(preparation.reelId, id);
    assert.deepEqual(reviewed, snapshot(row()));
    return { plan: plan(), reviewedSha256: sha };
  };
  await coordinate({ mode: 'prepare', 'run-dir': f.directory, limit: 1, 'hold-released': true,
    'inventory-sha256': f.inventory.inventorySha256, 'media-origin': 'https://media.example.com' }, f.deps);
  assert.equal(f.progress().entries[id].status, 'PREPARED');
});
