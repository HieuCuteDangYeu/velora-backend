const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { roomPlan, assertRoom, main } = require('./prepare-chat-stress-rooms.cjs');
function fixture() {
  const fixtureNamespace = 'mu-0123456789ab';
  return { fixtureNamespace, accounts: Array.from({ length: 50 }, (_, i) => ({
    id: randomUUID(), email: `${fixtureNamespace}.${String(i + 1).padStart(3, '0')}@velora-stress.invalid`,
    username: `vstress_0123456789ab_${String(i + 1).padStart(3, '0')}`,
    fullName: `Velora load ${fixtureNamespace} ${String(i + 1).padStart(3, '0')}`,
    password: 'test-only-not-a-secret-0123456789',
  })) };
}
test('50 users each belong to one of 20 isolated groups with at least two members', () => {
  const input = fixture(); const rooms = roomPlan(input);
  assert.equal(rooms.length, 20);
  assert.equal(rooms.filter(r => r.participantIds.length === 3).length, 10);
  assert.equal(new Set(rooms.map(r => r.name)).size, 20);
  const ids = rooms.flatMap(r => r.participantIds);
  assert.equal(ids.length, 50); assert.equal(new Set(ids).size, 50);
  assert.deepEqual([...ids].sort(), input.accounts.map(a => a.id).sort());
  assert.deepEqual(roomPlan(input), rooms);
});
test('a second operator process cannot prepare the same private manifest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-fixture-lock-'));
  const config = path.join(dir, 'fixture.json');
  fs.writeFileSync(`${config}.prepare.lock`, 'owned by another process');
  try { await assert.rejects(main(['--config', config, '--apply']), { code: 'EEXIST' }); }
  finally { fs.rmSync(dir, { recursive: true }); }
});
test('room reuse verifies exact name and membership, regardless of ordering', () => {
  const expected = roomPlan(fixture())[0];
  assertRoom({ ...expected, participantIds: [...expected.participantIds].reverse() }, expected);
  assertRoom({ name: expected.name, participants: expected.participantIds.map(id => ({ id })) }, expected);
  assert.throws(() => assertRoom({ ...expected, name: 'someone else' }, expected));
  assert.throws(() => assertRoom({ ...expected, participantIds: [randomUUID(), ...expected.participantIds.slice(1)] }, expected));
  assert.throws(() => assertRoom({ ...expected, participantIds: [...expected.participantIds, randomUUID()] }, expected));
});

test('a scale manifest gets one trio and one pair per block of five, every user in one room', () => {
  const { generate } = require('./generate-chat-stress-scale-fixtures.cjs');
  const input = generate({ users: 100, baseUrl: 'https://velora.test' });
  const rooms = roomPlan(input);
  assert.equal(rooms.length, 40);
  assert.equal(rooms.filter(r => r.participantIds.length === 3).length, 20);
  assert.equal(new Set(rooms.map(r => r.name)).size, 40);
  const ids = rooms.flatMap(r => r.participantIds);
  assert.equal(ids.length, 100); assert.equal(new Set(ids).size, 100);
  // A prefix ending on a block boundary holds whole rooms: the chat cohort depends on it.
  const first = new Set(input.accounts.slice(0, 20).map(a => a.id));
  assert.equal(rooms.filter(r => r.participantIds.every(id => first.has(id))).length, 8);
  assert.deepEqual(roomPlan(input), rooms);
});

test('a scale plan needs a multiple of five users and the local gateway needs its own address header', () => {
  const { generate } = require('./generate-chat-stress-scale-fixtures.cjs');
  const input = generate({ users: 10, baseUrl: 'https://velora.test' });
  input.accounts.pop();
  assert.throws(() => roomPlan(input), /multiple of 5/);
  const { fixtureClientIp } = require('./prepare-chat-stress-rooms.cjs');
  const ip = fixtureClientIp('some-user');
  assert.match(ip, /^198\.(18|19)\.\d+\.\d+$/);
  assert.equal(fixtureClientIp('some-user'), ip);
});
