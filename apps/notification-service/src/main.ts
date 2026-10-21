import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';

import { NotificationServiceModule } from './notification-service.module';

async function bootstrap() {
  const app = await NestFactory.create(NotificationServiceModule);
  const configService = app.get(ConfigService);
  const rabbitmqUrl =
    configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672';

  // Only notification_queue: call_queue belongs to call-service. A second
  // consumer there takes a share of the gateway's call RPCs and fails them.
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [rabbitmqUrl],
      queue: 'notification_queue',
      queueOptions: { durable: true },
      noAck: false,
      prefetchCount: 1,
    },
  });

  await app.startAllMicroservices();

  const port = Number(process.env.NOTIFICATION_SERVICE_PORT ?? 3015);

  await app.listen(port);
  console.log(`notification-service listening on port ${port}`);
}

void bootstrap();
