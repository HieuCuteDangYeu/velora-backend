import { FinalizeChatUploadUseCase } from '@media/application/use-cases/finalize-chat-upload.use-case';
import { DeleteRecalledChatMediaUseCase } from '@media/application/use-cases/delete-recalled-chat-media.use-case';
import { MediaProcessingAdapter } from '@media/infrastructure/adapters/media-processing.adapter';
import { ContentUploadLeaseAdapter } from '@media/infrastructure/adapters/content-upload-lease.adapter';
import { GetPresignedUrlUseCase } from '@media/application/use-cases/get-presigned-url.use-case';
import { MediaController } from '@media/infrastructure/controllers/media.controller';
import { S3Service } from '@media/infrastructure/services/s3.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      {
        name: 'CONTENT_SERVICE_RMQ',
        useFactory: (configService: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              configService.get<string>('RABBITMQ_URL') ||
                'amqp://localhost:5672',
            ],
            queue: 'content_queue',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'MEDIA_PROCESSING_RMQ',
        useFactory: (configService: ConfigService) => {
          const heartbeat = Number(
            configService.get<string>('RABBITMQ_HEARTBEAT_SECONDS') ?? '300',
          );

          return {
            transport: Transport.RMQ,
            options: {
              urls: [
                configService.get<string>('RABBITMQ_URL') ||
                  'amqp://localhost:5672',
              ],
              queue: 'processing_queue',
              queueOptions: { durable: true },
              heartbeat:
                Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 300,
              retryAttempts: 10,
              retryDelay: 3000,
            },
          };
        },
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [MediaController],
  providers: [
    FinalizeChatUploadUseCase,
    DeleteRecalledChatMediaUseCase,
    GetPresignedUrlUseCase,
    S3Service,
    ContentUploadLeaseAdapter,
    {
      provide: 'IReelUploadLeaseService',
      useExisting: ContentUploadLeaseAdapter,
    },
    {
      provide: 'IVideoProcessingQueue',
      useClass: MediaProcessingAdapter,
    },
  ],
})
export class MediaServiceModule {}
