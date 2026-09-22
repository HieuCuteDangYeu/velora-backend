import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { UserServiceModule } from '@user/user-service.module';

async function bootstrap() {
  const app = await NestFactory.create(UserServiceModule);
  const config = app.get(ConfigService);

  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [config.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672'],
      queue: 'user_queue',
      queueOptions: {
        durable: true,
      },
    },
  });

  await app.startAllMicroservices();
  await app.listen(config.get<number>('USER_METRICS_PORT') || 3018);
}
void bootstrap();
