import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AiServiceModule } from './ai-service.module';
import { createLangfuseSdk } from './infrastructure/services/langfuse-telemetry';

const langfuseSdk = createLangfuseSdk();
langfuseSdk?.start();

async function bootstrap() {
  const heartbeat = Number(process.env.RABBITMQ_HEARTBEAT_SECONDS ?? '300');

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AiServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: 'ai_queue',
        queueOptions: { durable: true },
        heartbeat:
          Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 300,
        retryAttempts: 10,
        retryDelay: 3000,
      },
    },
  );
  await app.listen();
}
void bootstrap();

process.once('SIGTERM', () => {
  void langfuseSdk?.shutdown();
});
process.once('SIGINT', () => {
  void langfuseSdk?.shutdown();
});
