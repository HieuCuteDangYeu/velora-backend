import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { AnalyzeVisualFrameManifestUseCase } from './application/use-cases/analyze-visual-frame-manifest.use-case';
import { BuildAdaptiveTranscriptSectionsUseCase } from './application/use-cases/build-adaptive-transcript-sections.use-case';
import { BuildHierarchicalIndexUseCase } from './application/use-cases/build-hierarchical-index.use-case';
import { BuildLongEvidenceChunksUseCase } from './application/use-cases/build-long-evidence-chunks.use-case';
import { BuildShortEvidenceChunksUseCase } from './application/use-cases/build-short-evidence-chunks.use-case';
import { BuildTranscriptSectionsUseCase } from './application/use-cases/build-transcript-sections.use-case';
import { CommitSemanticCandidateUseCase } from './application/use-cases/commit-semantic-candidate.use-case';
import { ExtractHierarchicalMetadataUseCase } from './application/use-cases/extract-hierarchical-metadata.use-case';
import { MergeTranscriptSegmentsUseCase } from './application/use-cases/merge-transcript-segments.use-case';
import { ProcessReelIndexJobUseCase } from './application/use-cases/process-reel-index-job.use-case';
import { SelectHealthyTranscriptSectionsUseCase } from './application/use-cases/select-healthy-transcript-sections.use-case';
import { TranscribeAudioManifestUseCase } from './application/use-cases/transcribe-audio-manifest.use-case';
import { ValidateEmbeddingQualityUseCase } from './application/use-cases/validate-embedding-quality.use-case';
import { ValidateEvidenceIndexCandidateUseCase } from './application/use-cases/validate-evidence-index-candidate.use-case';
import { ValidatePersistedSemanticCandidateUseCase } from './application/use-cases/validate-persisted-semantic-candidate.use-case';
import { AiServiceAdapter } from './infrastructure/adapters/ai-service.adapter';
import { ContentServiceAdapter } from './infrastructure/adapters/content-service.adapter';
import { IndexQualityAgentPolicyAdapter } from './infrastructure/adapters/index-quality-agent-policy.adapter';
import { IndexingApplicationConfigAdapter } from './infrastructure/adapters/indexing-application-config.adapter';
import { PersistedSemanticCandidateValidatorAdapter } from './infrastructure/adapters/persisted-semantic-candidate-validator.adapter';
import { R2ArtifactStorageAdapter } from './infrastructure/adapters/r2-artifact-storage.adapter';
import { ReelIndexRetryPublisherAdapter } from './infrastructure/adapters/reel-index-retry-publisher.adapter';
import { ReelIndexingController } from './infrastructure/controllers/reel-indexing.controller';
import { SemanticIndexController } from './infrastructure/controllers/semantic-index.controller';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { PrismaIndexCheckpointRepository } from './infrastructure/repositories/prisma-index-checkpoint.repository';
import { PrismaLangGraphCheckpointSaver } from './infrastructure/repositories/prisma-langgraph-checkpoint-saver';
import { PrismaSemanticCandidateInspector } from './infrastructure/repositories/prisma-semantic-candidate-inspector';
import { PrismaSemanticCandidateLifecycle } from './infrastructure/repositories/prisma-semantic-candidate-lifecycle';
import { PrismaSemanticIndexRepository } from './infrastructure/repositories/prisma-semantic-index.repository';
import { PrismaIndexQualityReviewRepository } from './infrastructure/repositories/prisma-index-quality-review.repository';
import { ReelIndexLangGraphWorkflow } from './infrastructure/workflows/reel-index-langgraph.workflow';

const rabbitClient = (name: string, queue: string) => ({
  name,
  useFactory: (config: ConfigService) => {
    const parsedHeartbeat = Number(
      config.get<string>('RABBITMQ_HEARTBEAT_SECONDS') ?? '300',
    );
    return {
      transport: Transport.RMQ as const,
      options: {
        urls: [config.get<string>('RABBITMQ_URL') || 'amqp://localhost:5672'],
        queue,
        queueOptions: { durable: true },
        heartbeat:
          Number.isFinite(parsedHeartbeat) && parsedHeartbeat > 0
            ? parsedHeartbeat
            : 300,
        retryAttempts: 10,
        retryDelay: 3000,
        persistent: true,
      },
    };
  },
  inject: [ConfigService],
});

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    ClientsModule.registerAsync([
      rabbitClient('AI_SERVICE_RMQ', 'ai_queue'),
      rabbitClient('CONTENT_SERVICE_RMQ', 'content_queue'),
    ]),
  ],
  controllers: [ReelIndexingController, SemanticIndexController],
  providers: [
    PrismaService,
    TranscribeAudioManifestUseCase,
    AnalyzeVisualFrameManifestUseCase,
    MergeTranscriptSegmentsUseCase,
    BuildTranscriptSectionsUseCase,
    BuildAdaptiveTranscriptSectionsUseCase,
    SelectHealthyTranscriptSectionsUseCase,
    BuildShortEvidenceChunksUseCase,
    BuildLongEvidenceChunksUseCase,
    ExtractHierarchicalMetadataUseCase,
    BuildHierarchicalIndexUseCase,
    ValidateEmbeddingQualityUseCase,
    ValidateEvidenceIndexCandidateUseCase,
    ValidatePersistedSemanticCandidateUseCase,
    CommitSemanticCandidateUseCase,

    {
      provide: 'IIndexingApplicationConfig',
      useClass: IndexingApplicationConfigAdapter,
    },
    {
      provide: 'IIndexQualityAgentPolicy',
      useClass: IndexQualityAgentPolicyAdapter,
    },
    {
      provide: 'IPersistedSemanticCandidateValidator',
      useClass: PersistedSemanticCandidateValidatorAdapter,
    },

    PrismaLangGraphCheckpointSaver,
    ReelIndexLangGraphWorkflow,
    ProcessReelIndexJobUseCase,
    AiServiceAdapter,
    ContentServiceAdapter,
    R2ArtifactStorageAdapter,
    ReelIndexRetryPublisherAdapter,
    PrismaIndexCheckpointRepository,
    PrismaSemanticIndexRepository,
    PrismaSemanticCandidateInspector,
    PrismaSemanticCandidateLifecycle,
    PrismaIndexQualityReviewRepository,
    { provide: 'IIndexingAiService', useExisting: AiServiceAdapter },
    { provide: 'IIndexingContentService', useExisting: ContentServiceAdapter },
    {
      provide: 'IIndexQualityReviewRepository',
      useExisting: PrismaIndexQualityReviewRepository,
    },
    { provide: 'IArtifactStorage', useExisting: R2ArtifactStorageAdapter },
    {
      provide: 'IReelIndexRetryPublisher',
      useExisting: ReelIndexRetryPublisherAdapter,
    },
    {
      provide: 'IIndexCheckpointRepository',
      useExisting: PrismaIndexCheckpointRepository,
    },
    {
      provide: 'ISemanticIndexRepository',
      useExisting: PrismaSemanticIndexRepository,
    },
    {
      provide: 'ISemanticCandidateInspector',
      useExisting: PrismaSemanticCandidateInspector,
    },
    {
      provide: 'ISemanticCandidateLifecycle',
      useExisting: PrismaSemanticCandidateLifecycle,
    },
    {
      provide: 'IReelIndexWorkflow',
      useExisting: ReelIndexLangGraphWorkflow,
    },
  ],
})
export class ReelIndexingServiceModule {}
