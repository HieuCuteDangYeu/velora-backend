#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { validateManifest } = require('./seed-chat-stress-users.cjs');

// A crowd: blocks of five accounts, each block one trio and one pair, so every
// account is in exactly one room, rooms average 2.5 members, and a prefix that
// ends on a block boundary holds whole rooms (the chat cohort relies on that).
function scaleRoomPlan(namespace, accounts) {
  if (accounts.length % 5 !== 0) throw new Error('A scale fixture needs a multiple of 5 identities');
  const rooms = [];
  for (let block = 0; block < accounts.length; block += 5) {
    const n = String(block / 5 + 1).padStart(4, '0');
    rooms.push({ name: `${namespace} crowd ${n}a`,
      participantIds: [accounts[block].id, accounts[block + 1].id, accounts[block + 2].id] });
    rooms.push({ name: `${namespace} crowd ${n}b`,
      participantIds: [accounts[block + 3].id, accounts[block + 4].id] });
  }
  return rooms;
}
function roomPlan(input) {
  const { namespace, accounts } = validateManifest(input);
  if (input.fixtureProfile === 'scale') return scaleRoomPlan(namespace, accounts);
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
// The gateway rate-limits login per client IP and reads it from CF-Connecting-IP.
// Run against the local gateway, each fixture user presents its own benchmark
// address (198.18.0.0/15) like the stress runner does; through the public edge
// Cloudflare overwrites the header, so this widens nothing there.
function fixtureClientIp(accountId) {
  const n = createHash('sha256').update(String(accountId)).digest().readUInt32BE(0) % 131072;
  return `198.${18 + (n >>> 16)}.${(n >>> 8) & 255}.${n & 255}`;
}
function isLocalOrigin(origin) {
  return origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) &&
    origin.pathname === '/' && !origin.username && !origin.password;
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
  // The manifest names the public HTTPS origin. An operator on the server host may
  // pass --base-url http://127.0.0.1 to reach the gateway directly.
  const override = args.includes('--base-url') ? args[args.indexOf('--base-url') + 1] : null;
  const origin = new URL(override ?? input.baseUrl);
  const local = override !== null && isLocalOrigin(origin);
  if (!local && (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password)) {
    throw new Error('HTTPS origin required');
  }
  const limitArg = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : plan.length;
  if (!Number.isInteger(limitArg) || limitArg < 1) throw new Error('--limit must be a positive integer');
  const todo = plan.slice(0, limitArg);
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({ fixtureNamespace: input.fixtureNamespace, users: input.accounts.length,
      rooms: plan.length, roomsThisRun: todo.length, groupsOfThree: plan.filter(r => r.participantIds.length === 3).length,
      groupsOfTwo: plan.filter(r => r.participantIds.length === 2).length, existingManifestRooms: input.rooms?.length ?? 0,
      origin: origin.origin }));
    return;
  }
  async function request(route, token, body, clientId) {
    const r = await fetch(new URL(route, origin), { method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(local && clientId ? { 'CF-Connecting-IP': fixtureClientIp(clientId) } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`Fixture API status ${r.status} at ${route.split('?')[0]}`);
    return r.json();
  }
  input.rooms ??= [];
  let created = 0, reused = 0, logoutFailures = 0;
  let unsaved = 0;
  for (const expected of todo) {
    const owner = input.accounts.find(a => a.id === expected.participantIds[0]);
    let session;
    try {
      session = await request('/auth/mobile/login', null, { email: owner.email, password: owner.password }, owner.id);
      const claims = JSON.parse(Buffer.from(session.accessToken.split('.')[1], 'base64url').toString());
      if (claims.sub !== owner.id) throw new Error('Fixture login identity mismatch');
      const found = await request('/conversations?limit=100', session.accessToken, undefined, owner.id);
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
          { type: 'GROUP', name: expected.name, participantIds: expected.participantIds }, owner.id);
        if (typeof result.id !== 'string' || !/^[a-f0-9]{24}$/.test(result.id)) throw new Error('Unexpected room ID');
        id = result.id; created++;
      }
      const row = { id, ...expected };
      input.rooms = [...input.rooms.filter(r => r.name !== expected.name), row];
      // Saving after every room is quadratic for a crowd; every 25th plus the last is enough
      // because a re-run discovers the rooms by name before creating anything.
      if (++unsaved >= 25 || expected === todo[todo.length - 1]) { save(path, input); unsaved = 0; }
      const detail = await request(`/conversations/${id}`, session.accessToken, undefined, owner.id);
      assertRoom(detail, expected);
      if (!local || todo.length <= 50 || created % 25 === 0) console.log(JSON.stringify({ room: expected.name, members: expected.participantIds.length, verified: true }));
    } finally {
      if (session?.refreshToken) {
        try { await request('/auth/mobile/logout', null, { refreshToken: session.refreshToken }, owner.id); }
        catch { logoutFailures++; }
      }
    }
  }
  console.log(JSON.stringify({ fixtureNamespace: input.fixtureNamespace, created, reused,
    verifiedRooms: input.rooms.length, users: input.accounts.length, logoutFailures }));
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
module.exports = { roomPlan, assertRoom, fixtureClientIp, main };
