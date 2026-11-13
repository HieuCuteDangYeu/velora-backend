#!/usr/bin/env node
'use strict';

// Operator-only: writes a private manifest for a crowd of synthetic users.
//
//   node scripts/ops/generate-chat-stress-scale-fixtures.cjs --users 2000 --base-url https://velora-app.me --out /private/scale.json
//
// The manifest is a new isolated namespace (it never touches the 50-user demo
// fixture). Create the rows with seed-chat-stress-users.cjs and the rooms with
// prepare-chat-stress-rooms.cjs, both of which read this file. See
// CHAT-STRESS-FIXTURES.md ("A crowd").
const fs = require('node:fs');
const { randomBytes, randomUUID } = require('node:crypto');

const MIN_USERS = 10;
const MAX_USERS = 5000;

function generate({ users, baseUrl, random = randomBytes, uuid = randomUUID }) {
  if (!Number.isInteger(users) || users < MIN_USERS || users > MAX_USERS || users % 5 !== 0) {
    throw new Error(`--users must be a multiple of 5 between ${MIN_USERS} and ${MAX_USERS}`);
  }
  const origin = new URL(baseUrl);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.username || origin.password) {
    throw new Error('--base-url must be an HTTPS origin');
  }
  const fixtureNamespace = `mu-${random(6).toString('hex')}`;
  const bare = fixtureNamespace.slice(3);
  const accounts = Array.from({ length: users }, (_, index) => {
    const suffix = String(index + 1).padStart(3, '0');
    return {
      id: uuid(),
      email: `${fixtureNamespace}.${suffix}@velora-stress.invalid`,
      username: `vstress_${bare}_${suffix}`,
      fullName: `Velora load ${fixtureNamespace} ${suffix}`,
      password: random(24).toString('base64url'),
    };
  });
  return {
    baseUrl: origin.origin,
    fixtureNamespace,
    fixtureProfile: 'scale',
    accounts,
    rooms: [],
    stages: [{ name: 'crowd', users, rps: 5, seconds: 60 }],
  };
}

function main(args = process.argv.slice(2)) {
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = value('--out');
  if (args.includes('--help') || !out) {
    console.log('node generate-chat-stress-scale-fixtures.cjs --users N --base-url https://host --out /private/manifest.json');
    return;
  }
  const manifest = generate({ users: Number(value('--users')), baseUrl: value('--base-url') });
  // wx: never overwrite an existing manifest (its passwords may already be in the database).
  const fd = fs.openSync(out, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(manifest, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  console.log(JSON.stringify({ fixtureNamespace: manifest.fixtureNamespace, users: manifest.accounts.length,
    rooms: manifest.accounts.length / 5 * 2, out }));
}

if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { generate, main, MIN_USERS, MAX_USERS };
