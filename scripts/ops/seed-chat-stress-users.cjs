#!/usr/bin/env node
'use strict';

// Operator-only fixture preparation; this script adds no public endpoint.
const fs = require('node:fs');

function validateManifest(input) {
  const namespace = input?.fixtureNamespace;
  if (!/^mu-[a-f0-9]{12}$/.test(namespace ?? '')) throw new Error('Invalid fixture namespace');
  const accounts = input.accounts;
  if (!Array.isArray(accounts) || accounts.length < 2 || accounts.length > 200) throw new Error('Expected 2..200 fixture accounts');
  const ids = new Set(), emails = new Set(), usernames = new Set();
  for (const [index, a] of accounts.entries()) {
    const suffix = String(index + 1).padStart(3, '0');
    if (!a || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.id ?? '') ||
        a.email !== `${namespace}.${suffix}@velora-stress.invalid` ||
        a.username !== `vstress_${namespace.slice(3)}_${suffix}` ||
        a.fullName !== `Velora load ${namespace} ${suffix}` ||
        typeof a.password !== 'string' || a.password.length < 24 || a.password.length > 100 ||
        ids.has(a.id) || emails.has(a.email) || usernames.has(a.username)) throw new Error('Fixture identity validation failed');
    ids.add(a.id); emails.add(a.email); usernames.add(a.username);
  }
  return { namespace, accounts };
}

function boundedDatabaseUrl(value) {
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Expected PostgreSQL');
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

async function provisionUsers(db, input, bcrypt, apply) {
  const { namespace, accounts } = validateManifest(input);
  // Check all unique keys before touching anything, including UUID collisions.
  const existing = await db.user.findMany({ where: { OR: [
    { id: { in: accounts.map(a => a.id) } },
    { email: { in: accounts.map(a => a.email) } },
    { username: { in: accounts.map(a => a.username) } },
  ] } });
  const requested = new Map(accounts.map(a => [a.id, a]));
  for (const row of existing) {
    const a = requested.get(row.id);
    if (!a || row.email !== a.email || row.username !== a.username || row.fullName !== a.fullName ||
        row.isVerified !== true || !row.password || !(await bcrypt.compare(a.password, row.password))) {
      throw new Error('Existing identity conflicts with this fixture; nothing updated');
    }
  }
  const known = new Set(existing.map(a => a.id));
  const missing = accounts.filter(a => !known.has(a.id));
  if (apply && missing.length) {
    const data = [];
    for (const a of missing) data.push({ id: a.id, email: a.email, username: a.username,
      fullName: a.fullName, password: await bcrypt.hash(a.password, 10), isVerified: true });
    const created = await db.user.createMany({ data });
    if (created.count !== missing.length) throw new Error('Unexpected fixture insert count');
  }
  return { fixtureNamespace: namespace, phase: 'users', apply, existing: existing.length,
    created: apply ? missing.length : 0, wouldCreate: missing.length,
    verifiedUserIds: apply || !missing.length ? accounts.map(a => a.id) : [],
    poolLimit: 1 };
}

async function provisionRoles(db, input, apply) {
  const { namespace, accounts } = validateManifest(input);
  const ids = accounts.map(a => a.id).sort();
  const verified = input.provisioning?.verifiedUserIds;
  if (!Array.isArray(verified) || verified.length !== ids.length ||
      [...verified].sort().some((id, i) => id !== ids[i])) throw new Error('A successful User Service fixture receipt is required');
  const role = await db.role.findUnique({ where: { name: 'USER' } });
  if (!role) throw new Error('Existing USER role required; no role policy changed');
  const existing = await db.userRole.findMany({ where: { userId: { in: ids } }, include: { role: true } });
  if (existing.some(row => row.role.name !== 'USER')) throw new Error('Fixture has unexpected roles; nothing changed');
  const known = new Set(existing.map(a => a.userId));
  const missing = ids.filter(id => !known.has(id));
  if (apply && missing.length) {
    const created = await db.userRole.createMany({ data: missing.map(userId => ({ userId, roleId: role.id })) });
    if (created.count !== missing.length) throw new Error('Unexpected fixture role count');
  }
  return { fixtureNamespace: namespace, phase: 'roles', apply, existing: known.size,
    created: apply ? missing.length : 0, wouldCreate: missing.length, poolLimit: 1 };
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('node seed-chat-stress-users.cjs --phase users|roles [--apply] < private-manifest.json');
    return;
  }
  const phase = args[args.indexOf('--phase') + 1];
  if (!['users', 'roles'].includes(phase)) throw new Error('Choose --phase users or roles');
  const text = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(text) > 150000) throw new Error('Fixture input too large');
  const input = JSON.parse(text);
  validateManifest(input);
  const { PrismaClient } = require(phase === 'users' ? '@prisma/user-client' : '@prisma/auth-client');
  const key = phase === 'users' ? 'USER_DATABASE_URL' : 'AUTH_DATABASE_URL';
  const db = new PrismaClient({ datasources: { db: { url: boundedDatabaseUrl(process.env[key]) } } });
  try {
    const result = phase === 'users'
      ? await provisionUsers(db, input, require('bcrypt'), args.includes('--apply'))
      : await provisionRoles(db, input, args.includes('--apply'));
    console.log(JSON.stringify(result));
  } finally { await db.$disconnect(); }
}

if (require.main === module) main().catch(() => {
  console.error('Fixture preparation failed; credentials and database details withheld. Check the fixture namespace and existing identity/role policy.');
  process.exitCode = 1;
});
module.exports = { validateManifest, boundedDatabaseUrl, provisionUsers, provisionRoles, main };
