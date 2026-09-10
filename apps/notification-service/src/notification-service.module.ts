import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import Redis from 'ioredis';

import { DeactivatePushTokenUseCase } from './application/use-cases/deactivate-push-token.use-case';
import { ProcessNotificationJobUseCase } from './application/use-cases/process-notification-job.use-case';
import { RegisterPushTokenUseCase } from './application/use-cases/register-push-token.use-case';
import { RetryNotificationJobsUseCase } from './application/use-cases/retry-notification-jobs.use-case';
import { SendCallStateUpdateUseCase } from './application/use-cases/send-call-state-update.use-case';
import { SendIncomingCallNotificationUseCase } from './application/use-cases/send-incoming-call-notification.use-case';
import { SendNewMessageNotificationUseCase } from './application/use-cases/send-new-message-notification.use-case';
import { SendTestPushUseCase } from './application/use-cases/send-test-push.use-case';
import { DevPushController } from './infrastructure/controllers/dev-push.controller';
import { InternalNotificationsController } from './infrastructure/controllers/internal-notifications.controller';
import { PushTokensController } from './infrastructure/controllers/push-tokens.controller';
import { ApnsVoipGateway } from './infrastructure/gateways/apns-voip.gateway';
import { FirebaseAdminGateway } from './infrastructure/gateways/firebase-admin.gateway';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { PrismaNotificationJobRepository } from './infrastructure/repositories/prisma-notification-job.repository';
import { PrismaPushTokenRepository } from './infrastructure/repositories/prisma-push-token.repository';
import { RedisPushTokenLifecycleRepository } from './infrastructure/repositories/redis-push-token-lifecycle.repository';
import { NotificationRetryScheduler } from './infrastructure/schedulers/notification-retry.scheduler';
import { CallEventsSubscriber } from './infrastructure/subscribers/call-events.subscriber';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    PushTokensController,
    InternalNotificationsController,
    DevPushController,
    CallEventsSubscriber,
  ],
  providers: [
    PrismaService,
    PrismaPushTokenRepository,
    PrismaNotificationJobRepository,
    RedisPushTokenLifecycleRepository,
    FirebaseAdminGateway,
    ApnsVoipGateway,
    RegisterPushTokenUseCase,
    DeactivatePushTokenUseCase,
    ProcessNotificationJobUseCase,
    SendNewMessageNotificationUseCase,
    SendIncomingCallNotificationUseCase,
    SendCallStateUpdateUseCase,
    RetryNotificationJobsUseCase,
    SendTestPushUseCase,
    NotificationRetryScheduler,
    {
      provide: 'IPushTokenRepository',
      useExisting: PrismaPushTokenRepository,
    },
    {
      provide: 'INotificationJobRepository',
      useExisting: PrismaNotificationJobRepository,
    },
    {
      provide: 'IPushTokenLifecycleRepository',
      useExisting: RedisPushTokenLifecycleRepository,
    },
    {
      provide: 'IFcmPushGateway',
      useExisting: FirebaseAdminGateway,
    },
    {
      provide: 'IApnsVoipGateway',
      useExisting: ApnsVoipGateway,
    },
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get<string>('REDIS_PASSWORD'),
          tls: (config.get<string>('REDIS_HOST') ?? '').includes('upstash')
            ? { servername: config.get<string>('REDIS_HOST') }
            : undefined,
        }),
    },
  ],
})
export class NotificationServiceModule {}
