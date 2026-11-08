import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Dedicated client for services that have no Redis of their own (the gateway).
 * It must fail fast: with the offline queue on, a Redis outage would queue
 * commands and stall requests instead of letting RateLimitService degrade.
 */
export function createRateLimitRedis(config: ConfigService): Redis {
  const host = config.get<string>('REDIS_HOST');
  const logger = new Logger('RateLimitRedis');
  const client = new Redis({
    host,
    port: config.get<number>('REDIS_PORT'),
    password: config.get<string>('REDIS_PASSWORD'),
    tls: (host ?? '').includes('upstash') ? { servername: host } : undefined,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  let lastLoggedAt = 0;
  client.on('error', (error: Error) => {
    // ioredis emits on every failed reconnect; log at most once a minute.
    if (Date.now() - lastLoggedAt < 60_000) return;
    lastLoggedAt = Date.now();
    logger.warn(`redis error: ${error.message}`);
  });
  return client;
}
