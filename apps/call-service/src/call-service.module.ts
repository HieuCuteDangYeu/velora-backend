import { Module } from '@nestjs/common';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CallTelemetryTokenService } from '@common/calls/call-telemetry-token.service';
import Redis from 'ioredis';

import { InitiateCallUseCase } from './application/use-cases/initiate-call.use-case';
import { JoinCallUseCase } from './application/use-cases/join-call.use-case';
import { CreateTransportUseCase } from './application/use-cases/create-transport.use-case';
import { ConnectTransportUseCase } from './application/use-cases/connect-transport.use-case';
import { ProduceUseCase } from './application/use-cases/produce.use-case';
import { ConsumeUseCase } from './application/use-cases/consume.use-case';
import { LeaveCallUseCase } from './application/use-cases/leave-call.use-case';
import { RejectCallUseCase } from './application/use-cases/reject-call.use-case';
import { AnswerCallUseCase } from './application/use-cases/answer-call.use-case';
import { AcceptIncomingCallUseCase } from './application/use-cases/accept-incoming-call.use-case';
import { ExpireDueCallsUseCase } from './application/use-cases/expire-due-calls.use-case';
import { PublishCallAnswerOutboxUseCase } from './application/use-cases/publish-call-answer-outbox.use-case';
import { PublishCallTerminalOutboxUseCase } from './application/use-cases/publish-call-terminal-outbox.use-case';
import { RecoverActiveCallsAfterMediaRestartUseCase } from './application/use-cases/recover-active-calls-after-media-restart.use-case';
import { ResumeConsumerUseCase } from './application/use-cases/resume-consumer.use-case';
import { RestartIceUseCase } from './application/use-cases/restart-ice.use-case';
import { ChangeCallTypeUseCase } from './application/use-cases/change-call-type.use-case';
import { CallGateway } from './infrastructure/gateways/call.gateway';
import { CallStateController } from './infrastructure/controllers/call-state.controller';
import { CallMetricsController } from './infrastructure/controllers/call-metrics.controller';
import { RedisCallStateRepository } from './infrastructure/repositories/redis-call-state.repository';
import { RedisCallSessionRepository } from './infrastructure/repositories/redis-call-session.repository';
import { RabbitCallEventPublisher } from './infrastructure/publishers/rabbit-call-event.publisher';
import { MediasoupCallMediaEngine } from './infrastructure/engines/mediasoup-call.engine';
import { CallPrometheusMetricsService } from './infrastructure/metrics/call-prometheus-metrics.service';
import { CallServiceRuntimeLease } from './infrastructure/runtime/call-service-runtime-lease.service';
import { CallAnswerOutboxWorker } from './infrastructure/workers/call-answer-outbox.worker';
import { CallTerminalOutboxWorker } from './infrastructure/workers/call-terminal-outbox.worker';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      {
        name: 'NOTIFICATION_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'notification_queue',
            queueOptions: { durable: true },
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
        name: 'CONVERSATION_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'conversation_queue',
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
  controllers: [CallStateController, CallMetricsController],
  providers: [
    CallGateway,
    CallPrometheusMetricsService,
    InitiateCallUseCase,
    JoinCallUseCase,
    CreateTransportUseCase,
    ConnectTransportUseCase,
    ProduceUseCase,
    ConsumeUseCase,
    LeaveCallUseCase,
    RejectCallUseCase,
    AnswerCallUseCase,
    AcceptIncomingCallUseCase,
    ExpireDueCallsUseCase,
    PublishCallAnswerOutboxUseCase,
    PublishCallTerminalOutboxUseCase,
    RecoverActiveCallsAfterMediaRestartUseCase,
    ResumeConsumerUseCase,
    RestartIceUseCase,
    ChangeCallTypeUseCase,
    RedisCallSessionRepository,
    RedisCallStateRepository,
    RabbitCallEventPublisher,
    MediasoupCallMediaEngine,
    CallServiceRuntimeLease,
    CallAnswerOutboxWorker,
    CallTerminalOutboxWorker,
    CallTelemetryTokenService,
    {
      provide: 'ICallSessionRepository',
      useExisting: RedisCallSessionRepository,
    },
    {
      provide: 'ICallStateRepository',
      useExisting: RedisCallStateRepository,
    },
    {
      provide: 'ICallEventPublisher',
      useExisting: RabbitCallEventPublisher,
    },
    {
      provide: 'ICallMediaEngine',
      useExisting: MediasoupCallMediaEngine,
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
export class CallServiceModule {}
