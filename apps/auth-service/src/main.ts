import { AuthServiceModule } from '@auth/auth-service.module';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';

async function bootstrap() {
  const app = await NestFactory.create(AuthServiceModule);
  const config = app.get(ConfigService);

  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [config.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672'],
      queue: 'auth_queue',
      queueOptions: {
        durable: true,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get<number>('AUTH_METRICS_PORT') || 3017);
}
void bootstrap();
