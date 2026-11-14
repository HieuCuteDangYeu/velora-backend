#!/usr/bin/env node
'use strict';

// Operator-only: removes the bulky data a chat stress fixture leaves behind.
//
//   node purge-chat-stress-data.cjs --phase messages [--apply] [--pause-ms 250] < private-manifest.json
//   node purge-chat-stress-data.cjs --phase jobs     [--apply] [--pause-ms 250] < private-manifest.json
//
// Counts only unless --apply is given. The fixture users and rooms are kept on
// purpose (they are tiny and the manifest stays usable); what grows is
//   messages: every message sent in a fixture room (conversation database), and
//   jobs:     every notification job addressed to a fixture user (notification database).
// Deletes go in small batches with a pause so a single huge delete does not flood
// the oplog or WAL that is replicated to the other servers.
const fs = require('node:fs');
const { validateManifest } = require('./seed-chat-stress-users.cjs');

const ROOM_ID = /^[a-f0-9]{24}$/;
const ROOMS_PER_BATCH = 5;
const JOBS_PER_BATCH = 20000;
const MESSAGES_PER_DELETE = 5000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function roomIds(input) {
  const { namespace } = validateManifest(input);
  const rooms = Array.isArray(input.rooms) ? input.rooms : [];
  if (rooms.length === 0) throw new Error('The manifest has no rooms');
  for (const room of rooms) {
    if (!ROOM_ID.test(room?.id ?? '') || typeof room.name !== 'string' || !room.name.startsWith(`${namespace} `)) {
      throw new Error('Manifest room is not a fixture room of this namespace');
    }
  }
  return { namespace, ids: rooms.map(room => room.id), names: new Map(rooms.map(room => [room.id, room.name])) };
}

function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Fails closed: every room must exist in the database under the fixture's own name. */
async function assertFixtureRooms(db, { ids, names }) {
  const rows = await db.conversation.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
  const found = new Map(rows.map(row => [row.id, row.name]));
  for (const id of ids) {
    if (found.has(id) && found.get(id) !== names.get(id)) {
      throw new Error('A room id exists under a different name; nothing deleted');
    }
  }
  return ids.filter(id => found.has(id));
}

async function purgeMessages(db, input, { apply = false, pauseMs = 250, wait = sleep } = {}) {
  const plan = roomIds(input);
  const existing = await assertFixtureRooms(db, plan);
  let counted = 0, deleted = 0;
  for (const group of chunk(existing, ROOMS_PER_BATCH)) {
    const where = { conversationId: { in: group } };
    counted += await db.message.count({ where });
    if (!apply) continue;
    // A room can hold tens of thousands of messages, so a delete never covers more than
    // MESSAGES_PER_DELETE ids: each one is a small oplog burst, followed by a pause.
    for (;;) {
      const batch = await db.message.findMany({ where, select: { id: true }, take: MESSAGES_PER_DELETE });
      if (batch.length === 0) break;
      deleted += (await db.message.deleteMany({ where: { id: { in: batch.map(row => row.id) } } })).count;
      if (pauseMs > 0) await wait(pauseMs);
    }
  }
  return { fixtureNamespace: plan.namespace, phase: 'messages', apply, rooms: existing.length, messages: counted, deleted };
}

async function purgeJobs(db, input, { apply = false, pauseMs = 250, wait = sleep } = {}) {
  const { namespace, accounts } = validateManifest(input);
  const recipients = accounts.map(account => account.id);
  const [{ count }] = await db.$queryRaw`SELECT count(*)::int AS count FROM notification_jobs WHERE recipient_user_id = ANY(${recipients})`;
  let deleted = 0;
  if (apply) {
    for (;;) {
      const removed = await db.$executeRaw`
        DELETE FROM notification_jobs WHERE id IN (
          SELECT id FROM notification_jobs WHERE recipient_user_id = ANY(${recipients}) LIMIT ${JOBS_PER_BATCH})`;
      deleted += removed;
      if (removed < JOBS_PER_BATCH) break;
      if (pauseMs > 0) await wait(pauseMs);
    }
  }
  return { fixtureNamespace: namespace, phase: 'jobs', apply, recipients: recipients.length, jobs: count, deleted };
}

function boundedUrl(value) {
  const url = new URL(value);
  if (url.protocol.startsWith('postgres')) {
    url.searchParams.set('connection_limit', '1');
    url.searchParams.set('pool_timeout', '10');
    return url.toString();
  }
  // MongoDB: leave the connection string exactly as configured.
  return value;
}

async function main(args = process.argv.slice(2)) {
  const value = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (args.includes('--help')) {
    console.log('node purge-chat-stress-data.cjs --phase messages|jobs [--apply] [--pause-ms N] < private-manifest.json');
    return;
  }
  const phase = value('--phase');
  if (!['messages', 'jobs'].includes(phase)) throw new Error('Choose --phase messages or jobs');
  const pauseMs = value('--pause-ms') === undefined ? 250 : Number(value('--pause-ms'));
  if (!Number.isInteger(pauseMs) || pauseMs < 0 || pauseMs > 60000) throw new Error('--pause-ms must be 0..60000');
  const text = fs.readFileSync(0, 'utf8');
  if (Buffer.byteLength(text) > 4_000_000) throw new Error('Fixture input too large');
  const input = JSON.parse(text);
  validateManifest(input);
  const messages = phase === 'messages';
  const { PrismaClient } = require(messages ? '@prisma/conversation-client' : '@prisma/notification-client');
  const url = process.env[messages ? 'CONVERSATION_DATABASE_URL' : 'NOTIFICATION_DATABASE_URL'];
  if (!url) throw new Error('Database URL is not set');
  const db = new PrismaClient({ datasourceUrl: boundedUrl(url) });
  try {
    const options = { apply: args.includes('--apply'), pauseMs };
    console.log(JSON.stringify(messages ? await purgeMessages(db, input, options) : await purgeJobs(db, input, options)));
  } finally {
    await db.$disconnect();
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Purge failed: ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { roomIds, assertFixtureRooms, purgeMessages, purgeJobs, boundedUrl, main };
