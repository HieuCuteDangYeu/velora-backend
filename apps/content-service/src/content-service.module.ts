import { BuildReelMediaJobUseCase } from '@content/application/use-cases/build-reel-media-job.use-case';
import { ClassifyReelJobLengthUseCase } from '@content/application/use-cases/classify-reel-job-length.use-case';
import { ClaimReelProcessingAttemptUseCase } from '@content/application/use-cases/claim-reel-processing-attempt.use-case';
import { ClaimReelIndexingAttemptUseCase } from '@content/application/use-cases/claim-reel-indexing-attempt.use-case';
import { CompleteReelIndexingUseCase } from '@content/application/use-cases/complete-reel-indexing.use-case';
import { CompleteReelMediaProcessingUseCase } from '@content/application/use-cases/complete-reel-media-processing.use-case';
import { CreateReelShareLinkUseCase } from '@content/application/use-cases/create-reel-share-link.use-case';
import { CreateReelUseCase } from '@content/application/use-cases/create-reel.use-case';
import { DeleteReelUseCase } from '@content/application/use-cases/delete-reel.use-case';
import { DispatchOutboxEventsUseCase } from '@content/application/use-cases/dispatch-outbox-events.use-case';
import { GetFriendsReelsUseCase } from '@content/application/use-cases/get-friends-reels.use-case';
import { FailReelIndexingUseCase } from '@content/application/use-cases/fail-reel-indexing.use-case';
import { GetProfileReelContextUseCase } from '@content/application/use-cases/get-profile-reel-context.use-case';
import { GetRecommendedReelsUseCase } from '@content/application/use-cases/get-recommended-reels.use-case';
import { GetReelStatusUseCase } from '@content/application/use-cases/get-reel-status.use-case';
import { GetReelUseCase } from '@content/application/use-cases/get-reel.use-case';
import { GetSearchSuggestionsUseCase } from '@content/application/use-cases/get-search-suggestions.use-case';
import { IsReelIndexingAttemptCurrentUseCase } from '@content/application/use-cases/is-reel-indexing-attempt-current.use-case';
import { ListReelsUseCase } from '@content/application/use-cases/list-reels.use-case';
import { ReprocessReelUseCase } from '@content/application/use-cases/reprocess-reel.use-case';
import { ReindexReelUseCase } from '@content/application/use-cases/reindex-reel.use-case';
import { ReportReelIndexingProgressUseCase } from '@content/application/use-cases/report-reel-indexing-progress.use-case';
import { ResolveReelShareLinkUseCase } from '@content/application/use-cases/resolve-reel-share-link.use-case';
import { ResolveReelContextAccessUseCase } from '@content/application/use-cases/resolve-reel-context-access.use-case';
import { RevokeReelShareLinkUseCase } from '@content/application/use-cases/revoke-reel-share-link.use-case';
import { SearchPublicReelsUseCase } from '@content/application/use-cases/search-public-reels.use-case';
import { ShareReelUseCase } from '@content/application/use-cases/share-reel.use-case';
import { TrackReelEventsUseCase } from '@content/application/use-cases/track-reel-events.use-case';
import { UpdateReelStatusUseCase } from '@content/application/use-cases/update-reel-status.use-case';
import { UpdateReelIndexStatusUseCase } from '@content/application/use-cases/update-reel-index-status.use-case';
import { UpdateReelMediaStatusUseCase } from '@content/application/use-cases/update-reel-media-status.use-case';
import { UpdateReelUseCase } from '@content/application/use-cases/update-reel.use-case';
import { AiEmbeddingServiceAdapter } from '@content/infrastructure/adapters/ai-embedding-service.adapter';
import { ConversationMessageAdapter } from '@content/infrastructure/adapters/conversation-message.adapter';
import { FriendContentAccessAdapter } from '@content/infrastructure/adapters/friend-content-access.adapter';
import { FriendSharePolicyAdapter } from '@content/infrastructure/adapters/friend-share-policy.adapter';
import { ReelMediaJobPublisherAdapter } from '@content/infrastructure/adapters/reel-media-job-publisher.adapter';
import { ReelIndexJobPublisherAdapter } from '@content/infrastructure/adapters/reel-index-job-publisher.adapter';
import { RecommendationTelemetryServiceAdapter } from '@content/infrastructure/adapters/recommendation-telemetry-service.adapter';
import { SemanticRecommendationServiceAdapter } from '@content/infrastructure/adapters/semantic-recommendation-service.adapter';
import { SemanticReelSearchAdapter } from '@content/infrastructure/adapters/semantic-reel-search.adapter';
import { REEL_INDEX_QUERY_QUEUE } from '@common/processing/interfaces/semantic-index.interface';
import { UserServiceAdapter } from '@content/infrastructure/adapters/user-service.adapter';
import { ContentController } from '@content/infrastructure/controllers/content.controller';
import { IndexingAttemptGuardController } from '@content/infrastructure/controllers/indexing-attempt-guard.controller';
import { OutboxDispatcherService } from '@content/infrastructure/jobs/outbox-dispatcher.service';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import { ContentRepository } from '@content/infrastructure/repositories/content.repository';
import { OptimizedRecommendationRepository } from '@content/infrastructure/repositories/optimized-recommendation.repository';
import { PrismaIndexAttemptReadRepository } from '@content/infrastructure/repositories/prisma-index-attempt-read.repository';
import { RecommendationRepository } from '@content/infrastructure/repositories/recommendation.repository';
import { RedisRecommendationFeedSessionRepository } from '@content/infrastructure/repositories/redis-recommendation-feed-session.repository';
import { R2StorageService } from '@content/infrastructure/services/r2-storage.service';
import { RecommendationConfigService } from '@content/infrastructure/services/recommendation-config.service';
import { RecommendationRankingConfigService } from '@content/infrastructure/services/recommendation-ranking-config.service';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import Redis from 'ioredis';

function createRmqClientRegistration(name: string, queue: string) {
  return {
    name,
    useFactory: (configService: ConfigService) => {
      const heartbeat = Number(
        configService.get<string>('RABBITMQ_HEARTBEAT_SECONDS') ?? '300',
      );

      return {
        transport: Transport.RMQ as const,
        options: {
          urls: [
            configService.get<string>('RABBITMQ_URL') ||
              'amqp://localhost:5672',
          ],
          queue,
          queueOptions: {
            durable: true,
          },
          heartbeat:
            Number.isFinite(heartbeat) && heartbeat > 0 ? heartbeat : 300,
          retryAttempts: 10,
          retryDelay: 3000,
        },
      };
    },
    inject: [ConfigService],
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
    ClientsModule.registerAsync([
      createRmqClientRegistration('AI_SERVICE_RMQ', 'ai_queue'),
      createRmqClientRegistration('FRIEND_SERVICE_RMQ', 'friend_queue'),
      createRmqClientRegistration('USER_SERVICE_RMQ', 'user_queue'),
      createRmqClientRegistration(
        'CONVERSATION_SERVICE_RMQ',
        'conversation_queue',
      ),
      createRmqClientRegistration('MONITORING_SERVICE_RMQ', 'monitoring_queue'),
      createRmqClientRegistration('INDEX_SERVICE_RMQ', REEL_INDEX_QUERY_QUEUE),
    ]),
  ],
  controllers: [ContentController, IndexingAttemptGuardController],
  providers: [
    PrismaService,
    ContentRepository,
    PrismaIndexAttemptReadRepository,
    RecommendationRepository,
    OptimizedRecommendationRepository,
    ReelMediaJobPublisherAdapter,
    ReelIndexJobPublisherAdapter,
    OutboxDispatcherService,

    CreateReelUseCase,
    BuildReelMediaJobUseCase,
    ClassifyReelJobLengthUseCase,
    DispatchOutboxEventsUseCase,
    ListReelsUseCase,
    GetReelUseCase,
    GetProfileReelContextUseCase,
    UpdateReelUseCase,
    DeleteReelUseCase,
    UpdateReelStatusUseCase,
    GetReelStatusUseCase,
    ResolveReelContextAccessUseCase,
    ShareReelUseCase,
    CreateReelShareLinkUseCase,
    ResolveReelShareLinkUseCase,
    RevokeReelShareLinkUseCase,
    TrackReelEventsUseCase,
    ReprocessReelUseCase,
    ReindexReelUseCase,
    ClaimReelProcessingAttemptUseCase,
    ClaimReelIndexingAttemptUseCase,
    IsReelIndexingAttemptCurrentUseCase,
    CompleteReelIndexingUseCase,
    FailReelIndexingUseCase,
    ReportReelIndexingProgressUseCase,
    CompleteReelMediaProcessingUseCase,
    UpdateReelMediaStatusUseCase,
    UpdateReelIndexStatusUseCase,
    SearchPublicReelsUseCase,
    GetRecommendedReelsUseCase,
    GetSearchSuggestionsUseCase,
    GetFriendsReelsUseCase,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('REDIS_HOST') ?? 'localhost',
          port: config.get<number>('REDIS_PORT') ?? 6379,
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          tls: (config.get<string>('REDIS_HOST') ?? '').includes('upstash')
            ? { servername: config.get<string>('REDIS_HOST') }
            : undefined,
          lazyConnect: true,
          enableOfflineQueue: false,
          maxRetriesPerRequest: 1,
        }),
    },
    {
      provide: 'IRecommendationFeedSessionRepository',
      useClass: RedisRecommendationFeedSessionRepository,
    },
    {
      provide: 'IRecommendationRepository',
      useExisting: OptimizedRecommendationRepository,
    },
    {
      provide: 'IRecommendationRankingConfig',
      useClass: RecommendationRankingConfigService,
    },
    {
      provide: 'IFriendContentAccessService',
      useClass: FriendContentAccessAdapter,
    },
    {
      provide: 'IContentRepository',
      useExisting: ContentRepository,
    },
    {
      provide: 'IIndexAttemptReadRepository',
      useExisting: PrismaIndexAttemptReadRepository,
    },
    {
      provide: 'IReelViewEventRepository',
      useExisting: ContentRepository,
    },
    {
      provide: 'IOutboxRepository',
      useExisting: ContentRepository,
    },
    {
      provide: 'IOutboxDispatchTrigger',
      useExisting: OutboxDispatcherService,
    },
    {
      provide: 'IStorageService',
      useClass: R2StorageService,
    },
    {
      provide: 'IReelMediaJobPublisher',
      useExisting: ReelMediaJobPublisherAdapter,
    },
    {
      provide: 'IReelIndexJobPublisher',
      useExisting: ReelIndexJobPublisherAdapter,
    },
    {
      provide: 'IAiEmbeddingService',
      useClass: AiEmbeddingServiceAdapter,
    },
    {
      provide: 'IFriendSharePolicyService',
      useClass: FriendSharePolicyAdapter,
    },
    {
      provide: 'IUserService',
      useClass: UserServiceAdapter,
    },
    {
      provide: 'IConversationMessageService',
      useClass: ConversationMessageAdapter,
    },
    {
      provide: 'IRecommendationConfig',
      useClass: RecommendationConfigService,
    },
    {
      provide: 'IRecommendationTelemetryService',
      useClass: RecommendationTelemetryServiceAdapter,
    },
    {
      provide: 'ISemanticRecommendationService',
      useClass: SemanticRecommendationServiceAdapter,
    },
    {
      provide: 'ISemanticReelSearchService',
      useClass: SemanticReelSearchAdapter,
    },
  ],
})
export class ContentServiceModule {}
