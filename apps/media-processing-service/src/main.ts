import {
  getEvidenceQueuesForWorkerLane,
  getPrimaryQueuesForWorkerLane,
  parseReelMediaWorkerLane,
  REEL_MEDIA_DEAD_LETTER_EXCHANGE,
} from '@common/processing/reel-media-queue.constants';
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { MediaProcessingServiceModule } from './media-processing-service.module';

async function bootstrap() {
  const heartbeat = Number(process.env.RABBITMQ_HEARTBEAT_SECONDS ?? '300');
  const parsedPrefetch = Number(process.env.MEDIA_WORKER_PREFETCH ?? '1');
  const prefetch =
    Number.isInteger(parsedPrefetch) && parsedPrefetch > 0 ? parsedPrefetch : 1;
  const lane = parseReelMediaWorkerLane(process.env.MEDIA_WORKER_LANE);
  const primaryQueues = [
    ...getPrimaryQueuesForWorkerLane(lane),
    ...getEvidenceQueuesForWorkerLane(lane),
  ];
  const queueDefinitions: Array<{
    queue: string;
    deadLetterRoutingKey?: string;
  }> = primaryQueues.map((definition) => ({
    queue: definition.queue,
    deadLetterRoutingKey: definition.deadLetterRoutingKey,
  }));

  if (lane === 'SHORT' || lane === 'BOTH') {
    queueDefinitions.push({ queue: 'processing_queue' });
  }

  const apps = await Promise.all(
    queueDefinitions.map((definition) =>
      NestFactory.createMicroservice<MicroserviceOptions>(
        MediaProcessingServiceModule,
        {
          transport: Transport.RMQ,
          options: {
            urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
            queue: definition.queue,
            queueOptions: definition.deadLetterRoutingKey
              ? {
                  durable: true,
                  arguments: {
                    'x-dead-letter-exchange': REEL_MEDIA_DEAD_LETTER_EXCHANGE,
                    'x-dead-letter-routing-key':
                      definition.deadLetterRoutingKey,
                  },
                }
              : { durable: true },
            noAck: false,
            prefetchCount: prefetch,
            heartbeat:
              Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 300,
            retryAttempts: 10,
            retryDelay: 3000,
          },
        },
      ),
    ),
  );

  for (const app of apps) {
    app.enableShutdownHooks();
  }

  await Promise.all(apps.map((app) => app.listen()));
}
void bootstrap();
