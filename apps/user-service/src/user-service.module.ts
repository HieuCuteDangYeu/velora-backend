import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  ClientsModule,
  ClientsProviderAsyncOptions,
  Transport,
} from '@nestjs/microservices';
import { CheckUsernameAvailabilityUseCase } from '@user/application/use-cases/check-username-availability.use-case';
import { CreateSocialUserUseCase } from '@user/application/use-cases/create-social-user.use-case';
import { CreateUserUseCase } from '@user/application/use-cases/create-user.use-case';
import { DeleteUserUseCase } from '@user/application/use-cases/delete-user.use-case';
import { FindAllUsersUseCase } from '@user/application/use-cases/find-all-users.use-case';
import { FindPublicUserByUsernameUseCase } from '@user/application/use-cases/find-public-user-by-username.use-case';
import { FindPublicUsersByIdsUseCase } from '@user/application/use-cases/find-public-users-by-ids.use-case';
import { FindUserByEmailUseCase } from '@user/application/use-cases/find-user-by-email.use-case';
import { FindUserByIdUseCase } from '@user/application/use-cases/find-user-by-id.use-case';
import { FindUsersByIdsUseCase } from '@user/application/use-cases/find-users-by-ids.use-case';
import { GetRecommendedPublicUsersUseCase } from '@user/application/use-cases/get-recommended-public-users.use-case';
import { SearchPublicUsersUseCase } from '@user/application/use-cases/search-public-users.use-case';
import { UpdateUserAvatarUseCase } from '@user/application/use-cases/update-user-avatar.use-case';
import { UpdateUserUseCase } from '@user/application/use-cases/update-user.use-case';
import { ValidateUserUseCase } from '@user/application/use-cases/validate-user.use-case';
import { ValidateUsersListUseCase } from '@user/application/use-cases/validate-users-list.use-case';
import { VerifyUserUseCase } from '@user/application/use-cases/verify-user.use-case';
import { AuthServiceAdapter } from '@user/infrastructure/adapters/auth-service.adapter';
import { FriendDiscoveryServiceAdapter } from '@user/infrastructure/adapters/friend-discovery-service.adapter';
import { RecommendationTelemetryServiceAdapter } from '@user/infrastructure/adapters/recommendation-telemetry-service.adapter';
import { UserController } from '@user/infrastructure/controllers/user.controller';
import { UserMetricsController } from '@user/infrastructure/controllers/user-metrics.controller';
import { UserPrometheusMetricsService } from '@user/infrastructure/metrics/user-prometheus-metrics.service';
import { PrismaService } from '@user/infrastructure/prisma/prisma.service';
import { UserRepository } from '@user/infrastructure/repositories/user.repository';
import { R2StorageService } from '@user/infrastructure/services/r2-storage.service';
import { RecommendationConfigService } from '@user/infrastructure/services/recommendation-config.service';

function createRmqClientRegistration(
  name: string,
  queue: string,
): ClientsProviderAsyncOptions {
  return {
    name,
    useFactory: (config: ConfigService) => ({
      transport: Transport.RMQ as const,
      options: {
        urls: [config.getOrThrow<string>('RABBITMQ_URL')],
        queue,
        queueOptions: {
          durable: true,
        },
      },
    }),
    inject: [ConfigService],
  };
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      createRmqClientRegistration('AUTH_SERVICE_RMQ', 'auth_queue'),
      createRmqClientRegistration('MONITORING_SERVICE_RMQ', 'monitoring_queue'),
      createRmqClientRegistration('FRIEND_SERVICE_RMQ', 'friend_queue'),
    ]),
  ],
  controllers: [UserController, UserMetricsController],
  providers: [
    PrismaService,
    UserPrometheusMetricsService,
    CreateUserUseCase,
    FindAllUsersUseCase,
    UpdateUserUseCase,
    DeleteUserUseCase,
    ValidateUserUseCase,
    VerifyUserUseCase,
    FindUserByEmailUseCase,
    CreateSocialUserUseCase,
    UpdateUserAvatarUseCase,
    FindUserByIdUseCase,
    FindPublicUserByUsernameUseCase,
    FindPublicUsersByIdsUseCase,
    FindUsersByIdsUseCase,
    SearchPublicUsersUseCase,
    CheckUsernameAvailabilityUseCase,
    ValidateUsersListUseCase,
    GetRecommendedPublicUsersUseCase,
    {
      provide: 'IUserRepository',
      useClass: UserRepository,
    },
    {
      provide: 'IAuthService',
      useClass: AuthServiceAdapter,
    },
    {
      provide: 'IFriendDiscoveryService',
      useClass: FriendDiscoveryServiceAdapter,
    },
    {
      provide: 'IStorageService',
      useClass: R2StorageService,
    },
    {
      provide: 'IRecommendationConfig',
      useClass: RecommendationConfigService,
    },
    {
      provide: 'IRecommendationTelemetryService',
      useClass: RecommendationTelemetryServiceAdapter,
    },
  ],
})
export class UserServiceModule {}
