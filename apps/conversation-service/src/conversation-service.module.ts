import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

// Import UseCases & Infra
import { ClientsModule, Transport } from '@nestjs/microservices';
import { GroupActivityService } from 'apps/conversation-service/src/application/services/group-activity.service';
import { GroupMembershipConsistencyService } from 'apps/conversation-service/src/application/services/group-membership-consistency.service';
import { BuildBotMemoryContextUseCase } from 'apps/conversation-service/src/application/use-cases/build-bot-memory-context.use-case';
import { BuildCompletedTurnMemoryContextUseCase } from 'apps/conversation-service/src/application/use-cases/build-completed-turn-memory-context.use-case';
import { CreateConversationUseCase } from 'apps/conversation-service/src/application/use-cases/create-conversastion.use-case';
import { GetAnchorNewerMessagesUseCase } from 'apps/conversation-service/src/application/use-cases/get-anchor-newer-messages.use-case';
import { GetAnchorOlderMessagesUseCase } from 'apps/conversation-service/src/application/use-cases/get-anchor-older-messages.use-case';
import { GetConversationUseCase } from 'apps/conversation-service/src/application/use-cases/get-conversation.use-case';
import { GetGroupMembersUseCase } from 'apps/conversation-service/src/application/use-cases/get-group-members.use-case';
import { GetMessagesAroundUseCase } from 'apps/conversation-service/src/application/use-cases/get-messages-around.use-case';
import { GetMessagesUseCase } from 'apps/conversation-service/src/application/use-cases/get-messages.use-case';
import { GetUserConversationsUseCase } from 'apps/conversation-service/src/application/use-cases/get-user-conversations.use-case';
import { ManageGroupConversationUseCase } from 'apps/conversation-service/src/application/use-cases/manage-group-conversation.use-case';
import { ManageGroupRoleUseCase } from 'apps/conversation-service/src/application/use-cases/manage-group-role.use-case';
import { ProcessBotReplyUseCase } from 'apps/conversation-service/src/application/use-cases/process-bot-reply.use-case';
import { TriggerBotReplyUseCase } from 'apps/conversation-service/src/application/use-cases/trigger-bot-reply.use-case';
import { AiServiceAdapter } from 'apps/conversation-service/src/infrastructure/adapters/ai-service.adapter';
import { ChatMediaServiceAdapter } from 'apps/conversation-service/src/infrastructure/adapters/chat-media.service.adapter';
import { ConversationRealtimePublisherAdapter } from 'apps/conversation-service/src/infrastructure/adapters/conversation-realtime-publisher.adapter';
import { NotificationServiceAdapter } from 'apps/conversation-service/src/infrastructure/adapters/notification-service.adapter';
import { UserServiceAdapter } from 'apps/conversation-service/src/infrastructure/adapters/user-service.adapter';
import { ConversationMetricsController } from 'apps/conversation-service/src/infrastructure/controllers/conversation-metrics.controller';
import { ConversationMicroserviceController } from 'apps/conversation-service/src/infrastructure/controllers/conversation.controller';
import { GroupMembersMicroserviceController } from 'apps/conversation-service/src/infrastructure/controllers/group-members.controller';
import { KeyMicroserviceController } from 'apps/conversation-service/src/infrastructure/controllers/key.controller';
import { ReactionDetailsMicroserviceController } from 'apps/conversation-service/src/infrastructure/controllers/reaction-details.controller';
import { ConversationPrometheusMetricsService } from 'apps/conversation-service/src/infrastructure/metrics/conversation-prometheus-metrics.service';
import { PrismaService } from 'apps/conversation-service/src/infrastructure/prisma/prisma.service';
import { AesEncryptionRepository } from 'apps/conversation-service/src/infrastructure/repositories/aes-encryption.repository';
import { PrismaConversationChatRepository } from 'apps/conversation-service/src/infrastructure/repositories/prisma-conversation-chat.repository';
import { PrismaConversationMemberRepository } from 'apps/conversation-service/src/infrastructure/repositories/prisma-conversation-member.repository';
import { PrismaGroupManagementV2Repository } from 'apps/conversation-service/src/infrastructure/repositories/prisma-group-management-v2.repository';
import { PrismaKeyBundleRepository } from 'apps/conversation-service/src/infrastructure/repositories/prisma-key-bundle.repository';
import { SendMessageUseCase } from './application/use-cases/send-message.use-case';
import { ChatGateway } from './infrastructure/gateways/chat.gateway';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      {
        name: 'USER_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'user_queue',
            queueOptions: { durable: true },
            heartbeat: 60,
            retryAttempts: 10,
            retryDelay: 3000,
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'AI_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'ai_queue',
            queueOptions: { durable: true },
            heartbeat: 60,
            retryAttempts: 10,
            retryDelay: 3000,
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'AUTH_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'auth_queue',
            queueOptions: { durable: true },
            heartbeat: 60,
            retryAttempts: 10,
            retryDelay: 3000,
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'MEDIA_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'media_queue',
            queueOptions: { durable: true },
            heartbeat: 60,
            retryAttempts: 10,
            retryDelay: 3000,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [
    ConversationMicroserviceController,
    ConversationMetricsController,
    GroupMembersMicroserviceController,
    ReactionDetailsMicroserviceController,
    KeyMicroserviceController,
  ],
  providers: [
    PrismaService,
    ChatGateway,
    ConversationPrometheusMetricsService,

    // --- Use Cases / application services ---
    SendMessageUseCase,
    GetMessagesAroundUseCase,
    GetAnchorOlderMessagesUseCase,
    GetAnchorNewerMessagesUseCase,
    GetMessagesUseCase,
    GetConversationUseCase,
    GetGroupMembersUseCase,
    CreateConversationUseCase,
    ManageGroupConversationUseCase,
    ManageGroupRoleUseCase,
    GroupActivityService,
    GroupMembershipConsistencyService,
    GetUserConversationsUseCase,
    ProcessBotReplyUseCase,
    TriggerBotReplyUseCase,
    BuildBotMemoryContextUseCase,
    BuildCompletedTurnMemoryContextUseCase,

    // --- Repositories / publishers ---
    PrismaConversationChatRepository,
    PrismaConversationMemberRepository,
    PrismaGroupManagementV2Repository,
    PrismaKeyBundleRepository,
    ConversationRealtimePublisherAdapter,

    {
      provide: 'IUserService',
      useClass: UserServiceAdapter,
    },
    {
      provide: 'IChatRepository',
      useExisting: PrismaConversationChatRepository,
    },
    {
      provide: 'IConversationMutationRepository',
      useExisting: PrismaConversationChatRepository,
    },
    {
      provide: 'IConversationMemberRepository',
      useExisting: PrismaConversationMemberRepository,
    },
    {
      provide: 'IGroupManagementV2Repository',
      useExisting: PrismaGroupManagementV2Repository,
    },
    {
      provide: 'IConversationRealtimePublisher',
      useExisting: ConversationRealtimePublisherAdapter,
    },
    {
      provide: 'IEncryptionRepository',
      useClass: AesEncryptionRepository,
    },
    {
      provide: 'IAiService',
      useClass: AiServiceAdapter,
    },
    {
      provide: 'IChatMediaService',
      useClass: ChatMediaServiceAdapter,
    },
    NotificationServiceAdapter,

    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
          tls: (config.get<string>('REDIS_HOST') ?? '').includes('upstash')
            ? { servername: config.get<string>('REDIS_HOST') }
            : undefined,
        });
      },
    },
  ],
})
export class ConversationServiceModule {}
