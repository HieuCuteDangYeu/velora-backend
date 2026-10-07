import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Transport } from '@nestjs/microservices';
import { RedisIoAdapter } from 'apps/conversation-service/src/infrastructure/gateways/redis-io.apdater';
import { ConversationServiceModule } from './conversation-service.module';

async function bootstrap() {
  // 1. Thay đổi: Dùng create() thay vì createMicroservice()
  // Để tạo ra HTTP Server cho Socket.IO handshake
  const app = await NestFactory.create(ConversationServiceModule);
  app.enableShutdownHooks();

  const configService = app.get(ConfigService);

  // 2. Kết nối Microservice (Giữ nguyên logic RabbitMQ của bạn)
  // Cái này giúp service vẫn lắng nghe được event từ các service khác
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [
        configService.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672',
      ],
      queue: 'conversation_queue',
      queueOptions: {
        durable: true,
      },
    },
  });

  // 3. Setup Redis Adapter cho Socket.IO (QUAN TRỌNG)
  const redisIoAdapter = new RedisIoAdapter(app, configService);
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);

  // 4. Cấu hình CORS (Để Frontend gọi được)
  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL'),
    credentials: true,
  });

  // 5. Khởi động tất cả
  await app.startAllMicroservices(); // Bắt đầu lắng nghe RabbitMQ

  // Bắt đầu lắng nghe HTTP/Socket trên port riêng (ví dụ 3005)
  // Port này phải khác Auth Service (thường là 3001) và Gateway (3000)
  const port = configService.get<number>('CONVERSATION_PORT') || 3005;
  await app.listen(port);

  console.log(`Conversation is running on: http://localhost:${port}/api`);
}
void bootstrap();
