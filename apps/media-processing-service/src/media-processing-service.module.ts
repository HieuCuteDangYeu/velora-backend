import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { BuildVisualFrameManifestUseCase } from '@processing/application/use-cases/build-visual-frame-manifest.use-case';
import { ClassifyReelMediaUseCase } from '@processing/application/use-cases/classify-reel-media.use-case';
import { SelectReelEncodingProfileUseCase } from '@processing/application/use-cases/select-reel-encoding-profile.use-case';
import { ValidateReelSourceMediaUseCase } from '@processing/application/use-cases/validate-reel-source-media.use-case';
import { ValidateReelStreamUseCase } from '@processing/application/use-cases/validate-reel-stream.use-case';
import { ContentServiceAdapter } from '@processing/infrastructure/adapters/content-service.adapter';
import { ConversationMediaAdapter } from '@processing/infrastructure/adapters/conversation-media.adapter';
import { ReelMediaRetryPublisherAdapter } from '@processing/infrastructure/adapters/reel-media-retry-publisher.adapter';
import { BuildTranscriptionAudioManifestUseCase } from './application/use-cases/build-transcription-audio-manifest.use-case';
import { PrepareReelMediaUseCase } from './application/use-cases/prepare-reel-media.use-case';
import { ProcessChatVideoUseCase } from './application/use-cases/process-chat-video.use-case';
import { ProcessReelUseCase } from './application/use-cases/process-reel.use-case';
import { MediaProcessingController } from './infrastructure/controllers/media-processing.controller';
import { FfmpegVisualFrameExtractionService } from './infrastructure/services/ffmpeg-visual-frame-extraction.service';
import { FfmpegService } from './infrastructure/services/ffmpeg.service';
import { JobConcurrencyLimiterService } from './infrastructure/services/job-concurrency-limiter.service';
import { ProcessingMetricsService } from './infrastructure/services/processing-metrics.service';
import { R2Service } from './infrastructure/services/r2.service';
import { TempFileService } from './infrastructure/services/temp-file.service';
import { TikTokCdnService } from './infrastructure/services/tiktok-cdn.service';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ClientsModule.registerAsync([
      {
        name: 'CONTENT_RMQ',
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
              queue: 'content_queue',
              queueOptions: { durable: true },
              heartbeat:
                Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 300,
              retryAttempts: 10,
              retryDelay: 3000,
              persistent: true,
            },
          };
        },
        inject: [ConfigService],
      },
      {
        name: 'CONVERSATION_RMQ',
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
              queue: 'conversation_queue',
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
  controllers: [MediaProcessingController],
  providers: [
    ProcessChatVideoUseCase,
    ProcessReelUseCase,
    BuildTranscriptionAudioManifestUseCase,
    BuildVisualFrameManifestUseCase,
    PrepareReelMediaUseCase,
    ValidateReelStreamUseCase,
    FfmpegService,
    FfmpegVisualFrameExtractionService,
    JobConcurrencyLimiterService,
    R2Service,
    TempFileService,
    SelectReelEncodingProfileUseCase,
    ClassifyReelMediaUseCase,
    ProcessingMetricsService,
    ReelMediaRetryPublisherAdapter,
    ValidateReelSourceMediaUseCase,
    {
      provide: 'IContentService',
      useClass: ContentServiceAdapter,
    },
    {
      provide: 'IMediaStorageService',
      useExisting: R2Service,
    },
    {
      provide: 'IVideoProcessingService',
      useExisting: FfmpegService,
    },
    {
      provide: 'IVisualFrameExtractionService',
      useExisting: FfmpegVisualFrameExtractionService,
    },
    {
      provide: 'ITempFileService',
      useClass: TempFileService,
    },
    {
      provide: 'IJobConcurrencyLimiterService',
      useExisting: JobConcurrencyLimiterService,
    },
    {
      provide: 'IProcessingMetrics',
      useExisting: ProcessingMetricsService,
    },
    {
      provide: 'IReelMediaRetryPublisher',
      useExisting: ReelMediaRetryPublisherAdapter,
    },
    {
      provide: 'IConversationMediaService',
      useClass: ConversationMediaAdapter,
    },
    TikTokCdnService,
    {
      provide: 'ITikTokCdnService',
      useExisting: TikTokCdnService,
    },
  ],
})
export class MediaProcessingServiceModule {}
