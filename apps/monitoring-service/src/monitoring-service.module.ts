import { CallTelemetryTokenService } from '@common/calls/call-telemetry-token.service';
import { GetCallTelemetrySummaryUseCase } from '@monitoring/application/use-cases/get-call-telemetry-summary.use-case';
import { GetCallTimelineUseCase } from '@monitoring/application/use-cases/get-call-timeline.use-case';
import { IngestCallTelemetryUseCase } from '@monitoring/application/use-cases/ingest-call-telemetry.use-case';
import { GetRecommendationTelemetrySummaryUseCase } from '@monitoring/application/use-cases/get-recommendation-telemetry-summary.use-case';
import { IngestRecommendationTelemetryUseCase } from '@monitoring/application/use-cases/ingest-recommendation-telemetry.use-case';
import { ListRecentCallLegsUseCase } from '@monitoring/application/use-cases/list-recent-call-legs.use-case';
import { PurgeExpiredCallTelemetryUseCase } from '@monitoring/application/use-cases/purge-expired-call-telemetry.use-case';
import { RemoveExpiredRecommendationTelemetryUseCase } from '@monitoring/application/use-cases/remove-expired-recommendation-telemetry.use-case';
import { CallTelemetryTokenVerifierAdapter } from '@monitoring/infrastructure/adapters/call-telemetry-token-verifier.adapter';
import { CallTelemetryController } from '@monitoring/infrastructure/controllers/call-telemetry.controller';
import { MonitoringHealthController } from '@monitoring/infrastructure/controllers/health.controller';
import { MetricsController } from '@monitoring/infrastructure/controllers/metrics.controller';
import { RecommendationTelemetryController } from '@monitoring/infrastructure/controllers/recommendation-telemetry.controller';
import { CallTelemetryRetentionJob } from '@monitoring/infrastructure/jobs/call-telemetry-retention.job';
import { RecommendationTelemetryCleanupJob } from '@monitoring/infrastructure/jobs/recommendation-telemetry-cleanup.job';
import { PrometheusMetricsService } from '@monitoring/infrastructure/metrics/prometheus-metrics.service';
import { MonitoringPrismaService } from '@monitoring/infrastructure/prisma/monitoring-prisma.service';
import { PrismaService } from '@monitoring/infrastructure/prisma/prisma.service';
import { PrismaCallTelemetryRepository } from '@monitoring/infrastructure/repositories/prisma-call-telemetry.repository';
import { RecommendationTelemetryRepository } from '@monitoring/infrastructure/repositories/recommendation-telemetry.repository';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    CallTelemetryController,
    RecommendationTelemetryController,
    MonitoringHealthController,
    MetricsController,
  ],
  providers: [
    PrometheusMetricsService,
    CallTelemetryTokenService,
    PrismaService,
    MonitoringPrismaService,
    RecommendationTelemetryRepository,
    PrismaCallTelemetryRepository,
    CallTelemetryTokenVerifierAdapter,
    IngestRecommendationTelemetryUseCase,
    GetRecommendationTelemetrySummaryUseCase,
    RemoveExpiredRecommendationTelemetryUseCase,
    RecommendationTelemetryCleanupJob,
    IngestCallTelemetryUseCase,
    GetCallTelemetrySummaryUseCase,
    GetCallTimelineUseCase,
    ListRecentCallLegsUseCase,
    PurgeExpiredCallTelemetryUseCase,
    CallTelemetryRetentionJob,
    {
      provide: 'IRecommendationTelemetryRepository',
      useExisting: RecommendationTelemetryRepository,
    },
    {
      provide: 'ICallTelemetryRepository',
      useExisting: PrismaCallTelemetryRepository,
    },
    {
      provide: 'ICallTelemetryTokenVerifier',
      useExisting: CallTelemetryTokenVerifierAdapter,
    },
  ],
})
export class MonitoringServiceModule {}
