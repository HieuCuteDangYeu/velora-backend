import { AcceptFriendRequestUseCase } from '@friend/application/use-cases/accept-friend-request.use-case';
import { BlockUserUseCase } from '@friend/application/use-cases/block-user.use-case';
import { CanShareWithUserUseCase } from '@friend/application/use-cases/can-share-with-user.use-case';
import { CanViewReelContentUseCase } from '@friend/application/use-cases/can-view-reel-content.use-case';
import { CancelFriendRequestUseCase } from '@friend/application/use-cases/cancel-friend-request.use-case';
import { GetFriendshipStatusUseCase } from '@friend/application/use-cases/get-friendship-status.use-case';
import { GetGraphFriendRecommendationsUseCase } from '@friend/application/use-cases/get-graph-friend-recommendations.use-case';
import { GetReelFeedAudienceUseCase } from '@friend/application/use-cases/get-reel-feed-audience.use-case';
import { ListBlockedUsersUseCase } from '@friend/application/use-cases/list-blocked-users.use-case';
import { ListFriendsUseCase } from '@friend/application/use-cases/list-friends.use-case';
import { ListIncomingFriendRequestsUseCase } from '@friend/application/use-cases/list-incoming-friend-requests.use-case';
import { ListOutgoingFriendRequestsUseCase } from '@friend/application/use-cases/list-outgoing-friend-requests.use-case';
import { RejectFriendRequestUseCase } from '@friend/application/use-cases/reject-friend-request.use-case';
import { RemoveFriendUseCase } from '@friend/application/use-cases/remove-friend.use-case';
import { SendFriendRequestUseCase } from '@friend/application/use-cases/send-friend-request.use-case';
import { UnblockUserUseCase } from '@friend/application/use-cases/unblock-user.use-case';
import { ConversationServiceAdapter } from '@friend/infrastructure/adapters/conversation-service.adapter';
import { UserServiceAdapter } from '@friend/infrastructure/adapters/user-service.adapter';
import { FriendRecommendationController } from '@friend/infrastructure/controllers/friend-recommendation.controller';
import { FriendController } from '@friend/infrastructure/controllers/friend.controller';
import { PrismaService } from '@friend/infrastructure/prisma/prisma.service';
import { FriendRepository } from '@friend/infrastructure/repositories/friend.repository';
import { UserBlockRepository } from '@friend/infrastructure/repositories/user-block.repository';
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
        name: 'USER_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'user_queue',
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'CONVERSATION_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'conversation_queue',
            queueOptions: {
              durable: true,
            },
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [FriendController, FriendRecommendationController],
  providers: [
    PrismaService,
    SendFriendRequestUseCase,
    AcceptFriendRequestUseCase,
    RejectFriendRequestUseCase,
    CancelFriendRequestUseCase,
    ListIncomingFriendRequestsUseCase,
    ListOutgoingFriendRequestsUseCase,
    ListFriendsUseCase,
    ListBlockedUsersUseCase,
    RemoveFriendUseCase,
    GetFriendshipStatusUseCase,
    CanShareWithUserUseCase,
    BlockUserUseCase,
    UnblockUserUseCase,
    GetReelFeedAudienceUseCase,
    GetGraphFriendRecommendationsUseCase,
    CanViewReelContentUseCase,
    {
      provide: 'IFriendRepository',
      useClass: FriendRepository,
    },
    {
      provide: 'IUserService',
      useClass: UserServiceAdapter,
    },
    {
      provide: 'IConversationService',
      useClass: ConversationServiceAdapter,
    },
    {
      provide: 'IUserBlockRepository',
      useClass: UserBlockRepository,
    },
  ],
})
export class FriendServiceModule {}
