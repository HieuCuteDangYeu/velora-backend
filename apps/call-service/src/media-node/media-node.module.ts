import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import Redis from 'ioredis';
import { MediasoupCallMediaEngine } from '../infrastructure/engines/mediasoup-call.engine';
import { CallPrometheusMetricsService } from '../infrastructure/metrics/call-prometheus-metrics.service';
import { RedisCallStateRepository } from '../infrastructure/repositories/redis-call-state.repository';
import { MediaNodeHttpController } from './media-node-http.controller';
import { MediaNodeIdentity } from './media-node-identity';
import { MediaNodeRegistry } from './media-node-registry.service';
import { MediaNodeRpcController } from './media-node-rpc.controller';

/**
 * A media node: mediasoup workers plus the RPC endpoint signaling replicas use
 * to drive the rooms placed here. It holds no signaling state.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ClientsModule.registerAsync([
      {
        name: 'CALL_SERVICE_RMQ',
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [
              config.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672',
            ],
            queue: 'call_queue',
            queueOptions: { durable: true },
          },
        }),
      },
    ]),
  ],
  controllers: [MediaNodeRpcController, MediaNodeHttpController],
  providers: [
    MediaNodeIdentity,
    MediaNodeRegistry,
    MediasoupCallMediaEngine,
    RedisCallStateRepository,
    CallPrometheusMetricsService,
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
export class MediaNodeModule {}
