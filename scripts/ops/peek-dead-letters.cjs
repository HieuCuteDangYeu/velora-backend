#!/usr/bin/env node
/*
 * Lists what is waiting in the reel dead-letter queues without removing anything.
 *
 *   node scripts/ops/peek-dead-letters.cjs [--queue=reel_index_short_dlq] [--limit=20]
 *
 * Each message is fetched and immediately put back (nack with requeue), so the queues keep their
 * contents. Environment: RABBITMQ_URL (through the SSH tunnel: amqp://...@127.0.0.1:25672).
 * Run it from a checkout with node_modules (NODE_PATH=<repo>/node_modules works from elsewhere).
 *
 * The queue only says THAT a job died and where. The reason is in the reel-indexing database
 * ("IndexingAttempt"."lastError", matched on reelId) for index jobs, and in the media worker log
 * for media jobs. The usual causes seen so far:
 *   - (before 2026-11-17) "Visual provider rate limit or quota exhausted": the Groq daily token allowance of every
 *     organization was spent while an index job required visual analysis. Retrying in the queue
 *     cannot help; re-run the index for that reel after the quota recovers.
 *   - an embedding or database error that survived the retry lane.
 */
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const QUEUES = [
  'reel_index_short_dlq',
  'reel_index_long_dlq',
  'reel_media_short_dlq',
  'reel_media_long_dlq',
];
const queues = opt('queue') ? [opt('queue')] : QUEUES;
const limit = Number(opt('limit', 20));

if (!process.env.RABBITMQ_URL) {
  console.error('error: set RABBITMQ_URL');
  process.exit(2);
}

// The broker timestamp header is in milliseconds on some publishers and seconds on others.
function toDate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n > 1e14 ? n / 1000 : n > 1e11 ? n : n * 1000);
}

async function main() {
  const amqp = require('amqplib');
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  for (const queue of queues) {
    const info = await channel.checkQueue(queue);
    console.log(`${queue}: ${info.messageCount} message(s)`);
    const fetched = [];
    for (let i = 0; i < Math.min(info.messageCount, limit); i += 1) {
      const message = await channel.get(queue, { noAck: false });
      if (!message) break;
      fetched.push(message);
    }
    for (const message of fetched) {
      let body = {};
      try {
        body = JSON.parse(message.content.toString());
      } catch {
        // leave empty
      }
      const data = body.data || body;
      const headers = message.properties.headers || {};
      const death = (headers['x-death'] || [])[0] || {};
      const diedAt =
        death.time && death.time.value
          ? new Date(Number(death.time.value) * 1000)
          : toDate(message.properties.timestamp);
      console.log(
        '  ' +
          [
            `reel=${data.reelId}`,
            `job=${data.jobId}`,
            data.createdAt ? `created=${data.createdAt}` : '',
            diedAt ? `died=${diedAt.toISOString()}` : '',
            `from=${headers['x-first-death-queue'] || death.queue || '?'}`,
            `reason=${headers['x-first-death-reason'] || death.reason || '?'}`,
            `retries=${headers['x-reel-index-retry-count'] ?? '-'}`,
          ]
            .filter(Boolean)
            .join(' '),
      );
    }
    for (const message of fetched) channel.nack(message, false, true);
  }
  await channel.close();
  await connection.close();
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('ERR', error && (error.message || error));
    process.exit(1);
  });
