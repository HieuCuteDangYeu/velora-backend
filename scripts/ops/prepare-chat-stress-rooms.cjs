#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { validateManifest } = require('./seed-chat-stress-users.cjs');

function roomPlan(input) {
  const { namespace, accounts } = validateManifest(input);
  if (accounts.length !== 50) throw new Error('This fixture requires exactly 50 identities');
  return Array.from({ length: 20 }, (_, i) => ({
    name: `${namespace} group ${String(i + 1).padStart(2, '0')}`,
    participantIds: [accounts[i * 2].id, accounts[i * 2 + 1].id,
      ...(i < 10 ? [accounts[40 + i].id] : [])],
  }));
}
function assertRoom(room, expected) {
  const ids = room.participantIds ?? room.participants?.map(p => p.id);
  if (room.name !== expected.name || !Array.isArray(ids) ||
      ids.length !== expected.participantIds.length ||
      [...ids].sort().some((id, i) => id !== [...expected.participantIds].sort()[i])) {
    throw new Error('Fixture room membership mismatch');
  }
}
function save(path, input) {
  const tmp = `${path}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(input, null, 2)); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path);
  fs.chmodSync(path, 0o600);
}
async function prepare(args = process.argv.slice(2)) {
  const path = args[args.indexOf('--config') + 1];
  if (!args.includes('--config') || !path) throw new Error('Specify private --config');
  const input = JSON.parse(fs.readFileSync(path, 'utf8'));
  const plan = roomPlan(input);
  const origin = new URL(input.baseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password) {
    throw new Error('HTTPS origin required');
  }
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ fixtureNamespace: input.fixtureNamespace, users: 50,
      rooms: 20, groupsOfThree: 10, groupsOfTwo: 10, existingManifestRooms: input.rooms?.length ?? 0 }));
    return;
  }
  async function request(route, token, body) {
    const r = await fetch(new URL(route, origin), { method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Fixture API status ${r.status} at ${route.split('?')[0]}`);
    return r.json();
  }
  input.rooms ??= [];
  let created = 0, reused = 0, logoutFailures = 0;
  for (const expected of plan) {
    const owner = input.accounts.find(a => a.id === expected.participantIds[0]);
    let session;
    try {
      session = await request('/auth/mobile/login', null, { email: owner.email, password: owner.password });
      const claims = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
      if (claims.sub !== owner.id) throw new Error('Fixture login identity mismatch');
      const found = await request('/conversations?limit=100', session.accessToken);
      if (!Array.isArray(found)) throw new Error('Unexpected room listing');
      const matches = found.filter(r => r.name === expected.name);
      if (matches.length > 1) throw new Error('Duplicate fixture room name');
      const recorded = input.rooms.find(r => r.name === expected.name);
      if (recorded && (!matches.length || matches[0].id !== recorded.id)) throw new Error('Recorded room missing or changed');
      let id;
      if (matches.length) { assertRoom(matches[0], expected); id = matches[0].id; reused++; }
      else {
        // Never retry an ambiguous POST; a subsequent invocation discovers its name first.
        const result = await request('/conversations', session.accessToken,
          { type: 'GROUP', name: expected.name, participantIds: expected.participantIds });
        if (typeof result.id !== 'string' || !/^[a-f0-9]{24}$/.test(result.id)) throw new Error('Unexpected room ID');
        id = result.id; created++;
      }
      const row = { id, ...expected };
      input.rooms = [...input.rooms.filter(r => r.name !== expected.name), row];
      save(path, input);
      const detail = await request(`/conversations/${id}`, session.accessToken);
      assertRoom(detail, expected);
      console.log(JSON.stringify({ room: expected.name, members: expected.participantIds.length, verified: true }));
    } finally {
      if (session?.refreshToken) {
        try { await request('/auth/mobile/logout', null, { refreshToken: session.refreshToken }); }
        catch { logoutFailures++; }
      }
    }
  }
  console.log(JSON.stringify({ fixtureNamespace: input.fixtureNamespace, created, reused,
    verifiedRooms: input.rooms.length, users: 50, logoutFailures }));
  if (logoutFailures) throw new Error('Some fixture sessions were not revoked');
}
async function main(args = process.argv.slice(2)) {
  if (!args.includes('--apply')) return prepare(args);
  const path = args[args.indexOf('--config') + 1];
  if (!args.includes('--config') || !path) throw new Error('Specify private --config');
  // Only one operator may provision a fixture. A stale lock is deliberately not
  // auto-removed: first confirm that its owning process has exited.
  const lockPath = `${path}.prepare.lock`;
  const lock = fs.openSync(lockPath, 'wx', 0o600);
  try { fs.writeFileSync(lock, String(process.pid)); return await prepare(args); }
  finally { fs.closeSync(lock); fs.unlinkSync(lockPath); }
}
if (require.main === module) main().catch(error => {
  console.error(error.message.startsWith('Fixture API status') ? error.message : 'Fixture room preparation failed; private details withheld. Re-run to inspect named rooms before creating more.');
  process.exitCode = 1;
});
module.exports = { roomPlan, assertRoom, main };
