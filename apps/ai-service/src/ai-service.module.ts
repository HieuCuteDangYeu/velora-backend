import { AnalyzeVisualFrameUseCase } from '@ai/application/use-cases/analyze-visual-frame.use-case';
import { BackfillUserMemoryEmbeddingsUseCase } from '@ai/application/use-cases/backfill-user-memory-embeddings.use-case';
import { BuildRagCitationsUseCase } from '@ai/application/use-cases/build-rag-citations.use-case';
import { BuildGroundedAnswerRevisionUseCase } from '@ai/application/use-cases/build-grounded-answer-revision.use-case';
import { CheckContextSufficiencyUseCase } from '@ai/application/use-cases/check-context-sufficiency.use-case';
import { CountDocumentTokensUseCase } from '@ai/application/use-cases/count-document-tokens.use-case';
import { CreateNoContextAnswerUseCase } from '@ai/application/use-cases/create-no-context-answer.use-case';
import { ExtractReelMetadataUseCase } from '@ai/application/use-cases/extract-reel-metadata.use-case';
import { ExtractUserMemoriesFromTurnUseCase } from '@ai/application/use-cases/extract-user-memories-from-turn.use-case';
import { GenerateDraftAnswerUseCase } from '@ai/application/use-cases/generate-draft-answer.use-case';
import { GenerateEmbeddingUseCase } from '@ai/application/use-cases/generate-embedding.use-case';
import { GenerateEmbeddingBatchUseCase } from '@ai/application/use-cases/generate-embedding-batch.use-case';
import { GetConversationMemoryUseCase } from '@ai/application/use-cases/get-conversation-memory.use-case';
import { GetRelevantUserMemoriesUseCase } from '@ai/application/use-cases/get-relevant-user-memories.use-case';
import { HandleConversationTurnCompletedUseCase } from '@ai/application/use-cases/handle-conversation-turn-completed.use-case';
import { MemoryAgentUseCase } from '@ai/application/use-cases/memory-agent.use-case';
import { MemoryWriterAgentUseCase } from '@ai/application/use-cases/memory-writer-agent.use-case';
import { PlanRetrievalUseCase } from '@ai/application/use-cases/plan-retrieval.use-case';
import { QueryRouterAgentUseCase } from '@ai/application/use-cases/query-router-agent.use-case';
import { RerankRetrievedEvidenceUseCase } from '@ai/application/use-cases/rerank-retrieved-evidence.use-case';
import { RetrieveReelEvidenceUseCase } from '@ai/application/use-cases/retrieve-reel-evidence.use-case';
import { ReviewIndexQualityUseCase } from '@ai/application/use-cases/review-index-quality.use-case';
import { RewriteRetrievalQueryUseCase } from '@ai/application/use-cases/rewrite-retrieval-query.use-case';
import { SaveRagTraceUseCase } from '@ai/application/use-cases/save-rag-trace.use-case';
import { StreamChatUseCase } from '@ai/application/use-cases/stream-chat.use-case';
import { StreamFinalAnswerUseCase } from '@ai/application/use-cases/stream-final-answer.use-case';
import { TranscribeAudioBufferUseCase } from '@ai/application/use-cases/transcribe-audio-buffer.use-case';
import { TranscribeAudioUseCase } from '@ai/application/use-cases/transcribe-audio.use-case';
import { UpdateConversationMemoryUseCase } from '@ai/application/use-cases/update-conversation-memory.use-case';
import { UpsertUserMemoriesUseCase } from '@ai/application/use-cases/upsert-user-memories.use-case';
import { VerifierAgentUseCase } from '@ai/application/use-cases/verifier-agent.use-case';
import { AiApplicationConfigAdapter } from '@ai/infrastructure/adapters/ai-application-config.adapter';
import { ChatPromptBuilderAdapter } from '@ai/infrastructure/adapters/chat-prompt-builder.adapter';
import { CloudflareCitationAttributionAdapter } from '@ai/infrastructure/adapters/cloudflare-citation-attribution.adapter';
import { CloudflareVisionAdapter } from '@ai/infrastructure/adapters/cloudflare-vision.adapter';
import { ContentServiceAdapter } from '@ai/infrastructure/adapters/content-service.adapter';
import { ConversationTokenPublisherAdapter } from '@ai/infrastructure/adapters/conversation-token-publisher.adapter';
import { DeterministicRetrievalEngineAdapter } from '@ai/infrastructure/adapters/deterministic-retrieval-engine.adapter';
import { EvidenceDiversitySelector } from '@ai/infrastructure/adapters/evidence-diversity-selector';
import { GroqConversationSummarizerAdapter } from '@ai/infrastructure/adapters/groq-conversation-summarizer.adapter';
import { GroqLlmAdapter } from '@ai/infrastructure/adapters/groq-llm.adapter';
import { GroqMemoryExtractorAdapter } from '@ai/infrastructure/adapters/groq-memory-extractor.adapter';
import { GroqStructuredLlmAdapter } from '@ai/infrastructure/adapters/groq-structured-llm.adapter';
import { GroqTextClient } from '@ai/infrastructure/adapters/groq-text.client';
import { GroqToolCallingLlmAdapter } from '@ai/infrastructure/adapters/groq-tool-calling-llm.adapter';
import { GroqTranscriptionAdapter } from '@ai/infrastructure/adapters/groq-transcription.adapter';
import { LangGraphRagChatWorkflowAdapter } from '@ai/infrastructure/adapters/langgraph-rag-chat-workflow.adapter';
import { HybridRetrievalScorer } from '@ai/infrastructure/adapters/hybrid-retrieval-scorer';
import { OllamaVisionAdapter } from '@ai/infrastructure/adapters/ollama-vision.adapter';
import { ReelSemanticIndexAdapter } from '@ai/infrastructure/adapters/reel-semantic-index.adapter';
import { RetrievalAgentPolicyAdapter } from '@ai/infrastructure/adapters/retrieval-agent-policy.adapter';
import { SimpleRerankerAdapter } from '@ai/infrastructure/adapters/simple-reranker.adapter';
import { TeiEmbeddingAdapter } from '@ai/infrastructure/adapters/tei-embedding.adapter';
import { TeiRerankerAdapter } from '@ai/infrastructure/adapters/tei-reranker.adapter';
import { AiController } from '@ai/infrastructure/controller/ai.controller';
import { IndexQualityAgentController } from '@ai/infrastructure/controllers/index-quality-agent.controller';
import { PrismaService } from '@ai/infrastructure/prisma/prisma.service';
import { PrismaConversationMemoryRepository } from '@ai/infrastructure/repositories/prisma-conversation-memory.repository';
import { PrismaRagHierarchyShadowObservationRepository } from '@ai/infrastructure/repositories/prisma-rag-hierarchy-shadow-observation.repository';
import { PrismaRagTraceRepository } from '@ai/infrastructure/repositories/prisma-rag-trace.repository';
import { PrismaUserMemoryRepository } from '@ai/infrastructure/repositories/prisma-user-memory.repository';
import { R2AudioStorageService } from '@ai/infrastructure/services/r2-audio-storage.service';
import { REEL_INDEX_QUERY_QUEUE } from '@common/processing/interfaces/semantic-index.interface';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ClientsModule.registerAsync([
      {
        name: 'CONTENT_RMQ',
        useFactory: (config: ConfigService) => {
          const heartbeat = Number(
            config.get<string>('RABBITMQ_HEARTBEAT_SECONDS') ?? '300',
          );

          return {
            transport: Transport.RMQ,
            options: {
              urls: [config.getOrThrow<string>('RABBITMQ_URL')],
              queue: 'content_queue',
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
      {
        name: 'CONVERSATION_RMQ',
        useFactory: (config: ConfigService) => {
          const heartbeat = Number(
            config.get<string>('RABBITMQ_HEARTBEAT_SECONDS') ?? '300',
          );

          return {
            transport: Transport.RMQ,
            options: {
              urls: [config.getOrThrow<string>('RABBITMQ_URL')],
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
      {
        name: 'INDEX_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: REEL_INDEX_QUERY_QUEUE,
            queueOptions: { durable: true },
            retryAttempts: 3,
            retryDelay: 1_000,
          },
        }),
        inject: [ConfigService],
      },
    ]),
  ],
  controllers: [AiController, IndexQualityAgentController],
  providers: [
    PrismaService,
    EvidenceDiversitySelector,
    HybridRetrievalScorer,
    SimpleRerankerAdapter,
    GroqTextClient,

    StreamChatUseCase,
    GenerateEmbeddingUseCase,
    GenerateEmbeddingBatchUseCase,
    CountDocumentTokensUseCase,
    TranscribeAudioUseCase,
    TranscribeAudioBufferUseCase,
    AnalyzeVisualFrameUseCase,

    GetRelevantUserMemoriesUseCase,
    ExtractUserMemoriesFromTurnUseCase,
    UpsertUserMemoriesUseCase,
    HandleConversationTurnCompletedUseCase,
    GetConversationMemoryUseCase,
    UpdateConversationMemoryUseCase,
    BackfillUserMemoryEmbeddingsUseCase,

    QueryRouterAgentUseCase,
    PlanRetrievalUseCase,
    RetrieveReelEvidenceUseCase,
    RerankRetrievedEvidenceUseCase,
    RewriteRetrievalQueryUseCase,
    MemoryAgentUseCase,
    GenerateDraftAnswerUseCase,
    StreamFinalAnswerUseCase,
    VerifierAgentUseCase,
    CheckContextSufficiencyUseCase,
    CreateNoContextAnswerUseCase,
    BuildRagCitationsUseCase,
    BuildGroundedAnswerRevisionUseCase,
    SaveRagTraceUseCase,
    MemoryWriterAgentUseCase,
    ExtractReelMetadataUseCase,
    ReviewIndexQualityUseCase,

    {
      provide: 'IAiApplicationConfig',
      useClass: AiApplicationConfigAdapter,
    },
    {
      provide: 'IRetrievalAgentPolicy',
      useClass: RetrievalAgentPolicyAdapter,
    },
    {
      provide: 'IRetrievalEngine',
      useClass: DeterministicRetrievalEngineAdapter,
    },
    {
      provide: 'IEmbeddingService',
      useClass: TeiEmbeddingAdapter,
    },
    {
      provide: 'ITranscriptionService',
      useClass: GroqTranscriptionAdapter,
    },
    {
      provide: 'IVisionService',
      useClass:
        process.env.AI_VISION_PROVIDER === 'ollama'
          ? OllamaVisionAdapter
          : CloudflareVisionAdapter,
    },
    {
      provide: 'IAudioStorageService',
      useClass: R2AudioStorageService,
    },
    {
      provide: 'ILlmService',
      useClass: GroqLlmAdapter,
    },
    {
      provide: 'IContentService',
      useClass: ContentServiceAdapter,
    },
    {
      provide: 'IRerankerService',
      useClass: TeiRerankerAdapter,
    },
    {
      provide: 'IReelSemanticIndexService',
      useClass: ReelSemanticIndexAdapter,
    },
    {
      provide: 'IChatTokenPublisher',
      useClass: ConversationTokenPublisherAdapter,
    },
    {
      provide: 'IUserMemoryRepository',
      useClass: PrismaUserMemoryRepository,
    },
    {
      provide: 'IRagTraceRepository',
      useClass: PrismaRagTraceRepository,
    },
    {
      provide: 'IRagHierarchyShadowObservationRepository',
      useClass: PrismaRagHierarchyShadowObservationRepository,
    },
    {
      provide: 'IMemoryExtractorService',
      useClass: GroqMemoryExtractorAdapter,
    },
    {
      provide: 'IConversationMemoryRepository',
      useClass: PrismaConversationMemoryRepository,
    },
    {
      provide: 'IConversationSummarizerService',
      useClass: GroqConversationSummarizerAdapter,
    },
    {
      provide: 'IStructuredLlmService',
      useClass: GroqStructuredLlmAdapter,
    },
    {
      provide: 'IToolCallingLlmService',
      useClass: GroqToolCallingLlmAdapter,
    },
    {
      provide: 'ICitationAttributionService',
      useClass: CloudflareCitationAttributionAdapter,
    },
    {
      provide: 'IChatPromptBuilder',
      useClass: ChatPromptBuilderAdapter,
    },
    {
      provide: 'IRagChatWorkflow',
      useClass: LangGraphRagChatWorkflowAdapter,
    },
  ],
})
export class AiServiceModule {}
