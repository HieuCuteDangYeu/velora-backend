import {
  getIndexQueuesForWorkerLane,
  parseReelIndexWorkerLane,
  REEL_INDEX_DEAD_LETTER_EXCHANGE,
} from '@common/processing/reel-media-queue.constants';
import { REEL_INDEX_QUERY_QUEUE } from '@common/processing/interfaces/semantic-index.interface';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { DrainableIndexRmqServer } from './infrastructure/adapters/drainable-index-rmq.server';
import { ReelIndexingServiceModule } from './reel-indexing-service.module';

async function bootstrap() {
  const heartbeat = positiveInt(process.env.RABBITMQ_HEARTBEAT_SECONDS, 300);
  const lane = parseReelIndexWorkerLane(process.env.INDEX_WORKER_LANE);
  const queues = getIndexQueuesForWorkerLane(lane);
  const jobServers: DrainableIndexRmqServer[] = [];
  const workerApps = queues.map((definition) =>
    NestFactory.createMicroservice<MicroserviceOptions>(
      ReelIndexingServiceModule,
      {
        strategy: (() => {
          const server = new DrainableIndexRmqServer({
            urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
            queue: definition.queue,
            queueOptions: {
              durable: true,
              arguments: {
                'x-dead-letter-exchange': REEL_INDEX_DEAD_LETTER_EXCHANGE,
                'x-dead-letter-routing-key': definition.deadLetterRoutingKey,
              },
            },
            noAck: false,
            prefetchCount:
              definition.lengthClass === 'SHORT'
                ? positiveInt(process.env.INDEX_SHORT_PREFETCH, 4)
                : positiveInt(process.env.INDEX_LONG_PREFETCH, 1),
            socketOptions: {
              heartbeatIntervalInSeconds: heartbeat,
              reconnectTimeInSeconds: 3,
            },
            maxConnectionAttempts: 10,
          });
          jobServers.push(server);
          return server;
        })(),
      },
    ),
  );
  const queryApps =
    lane === 'LONG'
      ? []
      : [
          NestFactory.createMicroservice<MicroserviceOptions>(
            ReelIndexingServiceModule,
            {
              transport: Transport.RMQ,
              options: {
                urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
                queue: REEL_INDEX_QUERY_QUEUE,
                queueOptions: { durable: true },
                noAck: true,
                prefetchCount: positiveInt(
                  process.env.INDEX_QUERY_PREFETCH,
                  20,
                ),
                socketOptions: { heartbeatIntervalInSeconds: heartbeat },
                retryAttempts: 10,
                retryDelay: 3000,
              },
            },
          ),
        ];
  const apps = await Promise.all([...workerApps, ...queryApps]);
  for (const app of apps) app.enableShutdownHooks();
  await Promise.all(apps.map((app) => app.listen()));
  process.on('SIGUSR2', () => {
    void Promise.all(jobServers.map((server) => server.drain()))
      .then((results) => {
        console.log(
          JSON.stringify({
            event: 'index_job_drain',
            settled: results.every(Boolean),
            queryRpcRunning: true,
          }),
        );
      })
      .catch(() => {
        console.error('index_job_drain_failed');
      });
  });
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

void bootstrap();
