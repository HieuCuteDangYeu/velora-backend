import type { IContentService } from '@ai/domain/interfaces/content-service.interface';
import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type {
  RagChatRouteDecision,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IRagHierarchyShadowObservationRepository } from '@ai/domain/interfaces/rag-hierarchy-shadow-observation.repository.interface';
import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { IReelSemanticIndexService } from '@ai/domain/interfaces/reel-semantic-index.service.interface';
import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import type {
  SemanticIndexSearchRequest,
  SemanticIndexSearchResult,
  SemanticReelDocument,
} from '@common/processing/interfaces/semantic-index.interface';
import { ConfigService } from '@nestjs/config';
import { DeterministicRetrievalEngineAdapter } from './deterministic-retrieval-engine.adapter';

const transcriptRoute: RagChatRouteDecision = {
  intent: 'REEL_VIDEO_QUESTION',
  referenceTarget: 'SHARED_REEL',
  needsRetrieval: true,
  needsUserMemory: false,
  needsConversationSummary: false,
  needsVerification: true,
  reelQuestionType: 'TRANSCRIPT_CONTENT',
  requiredEvidence: ['TRANSCRIPT'],
  recommendationAction: {
    type: 'NONE',
    reason: 'No recommendation needed.',
  },
  reason: 'Question asks about spoken reel content.',
};

const visualRoute: RagChatRouteDecision = {
  ...transcriptRoute,
  reelQuestionType: 'VISUAL_CONTENT',
  requiredEvidence: ['VISUAL'],
  reason: 'Question asks about visible reel content.',
};

const plan: RagRetrievalPlan = {
  mode: 'REEL_HYBRID',
  query: 'What project name is spoken?',
  queries: ['What project name is spoken?'],
  searchLimit: 8,
  rerankLimit: 5,
  shouldRerank: false,
  reason: 'Test retrieval plan.',
};

const buildCandidate = (
  id: string,
  parentId: string,
): SemanticIndexSearchResult => ({
  id,
  reelId: 'reel-1',
  parentId,
  ordinal: 0,
  userId: 'creator-1',
  text: `evidence ${id}`,
  retrievalText: `retrieval ${id}`,
  evidenceText: `evidence ${id}`,
  evidenceType: 'TRANSCRIPT',
  tags: [],
  startTime: 0,
  endTime: 5,
  sourceDurationMs: 30_000,
  sourceOrientation: 'PORTRAIT',
  sourceLengthClass: 'SHORT',
  rrfScore: 0.03,
  vectorDistance: 0.1,
  vectorRank: 1,
});

const reelCandidate: SemanticIndexSearchResult = {
  ...buildCandidate('reel-document-1', 'root'),
  parentId: undefined,
  evidenceType: 'METADATA',
};
const directCandidate = buildCandidate('chunk-direct', 'reel-document-1');
const hierarchicalCandidate = buildCandidate(
  'chunk-hierarchical',
  'reel-document-1',
);
const visualCandidate: SemanticIndexSearchResult = {
  ...buildCandidate('visual-scene-1', 'reel-document-1'),
  evidenceType: 'VISUAL',
  text: 'A red database diagram appears on screen.',
  retrievalText: 'red database diagram on screen',
  evidenceText: 'A red database diagram appears on screen.',
};

const reelDocument: SemanticReelDocument = {
  id: 'reel-document-1',
  reelId: 'reel-1',
  userId: 'creator-1',
  title: 'Test reel',
  description: 'Test description',
  text: 'Test reel',
  tags: [],
  sourceDurationMs: 30_000,
  sourceOrientation: 'PORTRAIT',
  sourceLengthClass: 'SHORT',
  indexAttemptId: 'attempt-1',
  indexVersion: 'v1',
  embeddingProvider: 'test',
  embeddingModel: 'test',
  embeddingDimensions: 1024,
  embeddingVersion: 'cf-bge-m3-v1',
  chunkingVersion: 'v1',
  summaryVersion: 'v1',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
};

const buildAdapter = (configValues: Record<string, string>) => {
  const generateObject = jest.fn().mockResolvedValue({
    mode: 'REEL_HYBRID',
    query: 'What project name is spoken?',
    rewrittenQuery: '',
    queries: ['What project name is spoken?'],
    searchLimit: 8,
    rerankLimit: 5,
    shouldRerank: true,
    reason: 'Retrieve spoken project-name evidence.',
  });
  const embeddingService: IEmbeddingService = {
    generateVector: jest.fn().mockResolvedValue({
      values: Array.from({ length: 1024 }, () => 0.01),
      model: 'test/baai/bge-m3',
      dimensions: 1024,
      provider: 'cloudflare-workers-ai',
      version: 'cf-bge-m3-v1',
    }),
    countTokens: jest.fn(),
  };
  const contentService: IContentService = {
    resolveReelContextAccess: jest.fn().mockResolvedValue(['reel-1']),
    searchPublicReels: jest.fn(),
    getRecommendedReels: jest.fn(),
  };
  const searchChunks = jest.fn(
    (input: SemanticIndexSearchRequest): Promise<SemanticIndexSearchResult[]> =>
      Promise.resolve(
        input.filters?.parentIds ? [hierarchicalCandidate] : [directCandidate],
      ),
  );
  const searchVisualScenes = jest.fn().mockResolvedValue([visualCandidate]);
  const semanticIndexService: IReelSemanticIndexService = {
    searchReels: jest.fn().mockResolvedValue([reelCandidate]),
    searchSections: jest.fn().mockResolvedValue([]),
    searchChunks,
    searchVisualScenes,
    getAdjacentChunks: jest.fn().mockResolvedValue([]),
    getReelDocument: jest.fn().mockResolvedValue(reelDocument),
  };
  const hierarchyObservationRepository: IRagHierarchyShadowObservationRepository =
    {
      save: jest.fn().mockResolvedValue(undefined),
    };
  const rerank = jest
    .fn()
    .mockResolvedValue([buildCandidate('reranked', 'reel-document-1')]);
  const rerankerService: IRerankerService = { rerank };

  const adapter = new DeterministicRetrievalEngineAdapter(
    { generateObject } as IStructuredLlmService,
    embeddingService,
    contentService,
    semanticIndexService,
    rerankerService,
    hierarchyObservationRepository,
    new ConfigService(configValues),
    { maxCompletionTokens: jest.fn(() => 512) } as never,
  );

  return {
    adapter,
    hierarchyObservationRepository,
    searchChunks,
    searchVisualScenes,
    generateObject,
    rerankerService,
    rerank,
    semanticIndexService,
    embeddingService,
  };
};

const emptyRetrievalDiagnostics = (): RagRetrievalExecutionDiagnostics => ({
  accessibleReelCount: 0,
  accessibleReelIds: [],
  queryCount: 0,
  queries: [],
  retrievedCount: 0,
  rerankedCount: 0,
});

describe('DeterministicRetrievalEngineAdapter', () => {
  it('uses an explicit bounded contract for semantic retrieval planning', async () => {
    const { adapter, generateObject } = buildAdapter({
      AI_RETRIEVAL_PLANNER_MODEL: 'test/openai/gpt-oss-20b',
      AI_RETRIEVAL_PLANNER_TIMEOUT_MS: '8000',
    });

    await expect(
      adapter.plan({
        message: 'What project name is spoken?',
        route: transcriptRoute,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        mode: 'REEL_HYBRID',
        queries: ['What project name is spoken?'],
      }),
    );

    const request = generateObject.mock.calls[0]?.[0];
    expect(request).toEqual(
      expect.objectContaining({
        model: 'test/openai/gpt-oss-20b',
        modelRole: 'RETRIEVAL_PLANNER',
        maxTokens: 512,
        timeoutMs: 8_000,
      }),
    );
    expect(request.systemPrompt).toContain('Return exactly these eight fields');
    expect(request.jsonSchema.properties).toEqual(
      expect.objectContaining({
        query: expect.objectContaining({ maxLength: 500 }),
        queries: expect.objectContaining({ minItems: 1, maxItems: 3 }),
        searchLimit: expect.objectContaining({ minimum: 1, maximum: 20 }),
        rerankLimit: expect.objectContaining({ minimum: 1, maximum: 10 }),
        reason: expect.objectContaining({ maxLength: 240 }),
      }),
    );
  });

  it('persists safe planner structured-call diagnostics on success', async () => {
    const { adapter, generateObject } = buildAdapter({
      AI_RETRIEVAL_PLANNER_MODEL: 'test/openai/gpt-oss-20b',
      AI_RETRIEVAL_PLANNER_TIMEOUT_MS: '8000',
    });
    generateObject.mockImplementationOnce(
      (input: GenerateStructuredObjectInput) => {
        input.onDiagnostics?.({
          modelRole: 'RETRIEVAL_PLANNER',
          model: 'test/openai/gpt-oss-20b',
          providerStatus: 200,
          latencyMs: 12,
          configuredTimeoutMs: 8000,
          configuredMaxCompletionTokens: 512,
          attempt: 1,
          requestId: 'must-not-persist',
        });
        return Promise.resolve({
          mode: 'REEL_HYBRID',
          query: 'spoken project',
          rewrittenQuery: 'spoken project',
          queries: ['spoken project', 'project name'],
          searchLimit: 8,
          rerankLimit: 5,
          shouldRerank: true,
          reason: 'Focused transcript search.',
        });
      },
    );

    const result = await adapter.plan({
      message: 'What project name is spoken?',
      route: transcriptRoute,
    });

    expect(result.diagnostics).toEqual(
      expect.objectContaining({
        semanticCalls: [
          expect.objectContaining({
            modelRole: 'RETRIEVAL_PLANNER',
            providerStatus: 200,
          }),
        ],
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      'must-not-persist',
    );
  });

  it('persists safe failed planner diagnostics on fail-closed planning', async () => {
    const { adapter, generateObject } = buildAdapter({
      AI_RETRIEVAL_PLANNER_MODEL: 'test/openai/gpt-oss-20b',
      AI_RETRIEVAL_PLANNER_TIMEOUT_MS: '8000',
    });
    generateObject.mockImplementationOnce(
      (input: GenerateStructuredObjectInput) => {
        input.onDiagnostics?.({
          modelRole: 'RETRIEVAL_PLANNER',
          model: 'test/openai/gpt-oss-20b',
          providerStatus: 429,
          latencyMs: 20,
          configuredTimeoutMs: 8000,
          configuredMaxCompletionTokens: 512,
          attempt: 1,
          errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
          providerCode: 3036,
          providerCategory: 'ACCOUNT_LIMITED',
          requestId: 'must-not-persist',
        });
        return Promise.reject(new Error('provider failure'));
      },
    );

    const result = await adapter.plan({
      message: 'What project name is spoken?',
      route: transcriptRoute,
    });

    expect(result).toEqual(
      expect.objectContaining({
        mode: 'NONE',
        diagnostics: expect.objectContaining({
          providerStatus: 'ERROR',
          decisionSource: 'FAIL_CLOSED',
          semanticCalls: [
            expect.objectContaining({
              errorCode: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
              providerCategory: 'ACCOUNT_LIMITED',
            }),
          ],
        }),
      }),
    );
    expect(JSON.stringify(result.diagnostics)).not.toContain(
      'must-not-persist',
    );
  });

  it('distinguishes empty access from semantic search zero results', async () => {
    const emptyAccess = emptyRetrievalDiagnostics();
    const { adapter } = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    await expect(
      adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: transcriptRoute,
        plan,
        accessibleReelIds: [],
        diagnostics: emptyAccess,
      }),
    ).resolves.toEqual([]);
    expect(emptyAccess).toEqual(
      expect.objectContaining({
        accessibleReelCount: 0,
        queryCount: 0,
        retrievedCount: 0,
      }),
    );

    const noSearchResults = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    noSearchResults.searchChunks.mockResolvedValue([]);
    const diagnostics = emptyRetrievalDiagnostics();
    await expect(
      noSearchResults.adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: transcriptRoute,
        plan,
        accessibleReelIds: ['reel-1'],
        diagnostics,
      }),
    ).resolves.toEqual([]);
    expect(diagnostics).toEqual(
      expect.objectContaining({
        accessibleReelCount: 1,
        queryCount: 1,
        queries: [
          expect.objectContaining({
            semanticCandidateCount: 0,
            hydratedCandidateCount: 0,
            returnedChunkCount: 0,
          }),
        ],
        retrievedCount: 0,
      }),
    );
  });

  it('preserves successful stage counts and identifies rerank loss', async () => {
    const built = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    const diagnostics = emptyRetrievalDiagnostics();
    const retrieved = await built.adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route: transcriptRoute,
      plan,
      accessibleReelIds: ['reel-1'],
      diagnostics,
    });
    expect(retrieved.length).toBeGreaterThan(0);
    expect(diagnostics.queries[0]).toEqual(
      expect.objectContaining({
        semanticCandidateCount: 1,
        hydratedCandidateCount: 1,
        returnedChunkCount: 1,
      }),
    );
    expect(diagnostics.retrievedCount).toBe(1);

    built.rerank.mockResolvedValueOnce([]);
    await expect(
      built.adapter.rerank({
        plan: { ...plan, shouldRerank: true },
        retrievedChunks: retrieved,
        diagnostics,
      }),
    ).resolves.toEqual([]);
    expect(diagnostics).toEqual(
      expect.objectContaining({ retrievedCount: 1, rerankedCount: 0 }),
    );

    const rerankFailure = Object.assign(new Error('rerank failed'), {
      code: 'RERANK_PROVIDER_ERROR',
      providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
    });
    built.rerank.mockRejectedValueOnce(rerankFailure);
    const rerankDiagnostics = emptyRetrievalDiagnostics();
    await expect(
      built.adapter.rerank({
        plan: { ...plan, shouldRerank: true },
        retrievedChunks: retrieved,
        diagnostics: rerankDiagnostics,
      }),
    ).rejects.toBe(rerankFailure);
    expect(rerankDiagnostics).toEqual(
      expect.objectContaining({
        failedStage: 'RERANK',
        errorCode: 'RERANK_PROVIDER_ERROR',
        providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
      }),
    );
  });

  it('records hydration failures after semantic candidates exist', async () => {
    const built = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    built.semanticIndexService.getReelDocument = jest
      .fn()
      .mockRejectedValue(new Error('hydration failed'));
    const diagnostics = emptyRetrievalDiagnostics();

    await expect(
      built.adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: transcriptRoute,
        plan,
        accessibleReelIds: ['reel-1'],
        diagnostics,
      }),
    ).rejects.toThrow('hydration failed');
    expect(diagnostics).toEqual(
      expect.objectContaining({
        failedStage: 'HYDRATION',
        queries: [expect.objectContaining({ semanticCandidateCount: 1 })],
      }),
    );
  });

  it('records embedding failures without changing the thrown runtime error', async () => {
    const built = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    const failure = Object.assign(new Error('embedding failed'), {
      code: 'EMBEDDING_PROVIDER_ERROR',
      providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
    });
    built.embeddingService.generateVector = jest
      .fn()
      .mockRejectedValue(failure);
    const diagnostics = emptyRetrievalDiagnostics();

    await expect(
      built.adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: transcriptRoute,
        plan,
        accessibleReelIds: ['reel-1'],
        diagnostics,
      }),
    ).rejects.toBe(failure);
    expect(diagnostics).toEqual(
      expect.objectContaining({
        failedStage: 'EMBEDDING',
        errorCode: 'EMBEDDING_PROVIDER_ERROR',
        providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
      }),
    );
  });

  it('serves direct retrieval and forces shadow when production hierarchy is requested without approval', async () => {
    const { adapter, hierarchyObservationRepository, searchChunks } =
      buildAdapter({
        NODE_ENV: 'production',
        RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'true',
        RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
        RAG_HIERARCHICAL_RETRIEVAL_PROMOTION_APPROVED: 'false',
      });

    const result = await adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route: transcriptRoute,
      plan,
    });

    expect(result.map((item) => item.chunkId)).toContain('chunk-direct');
    expect(result.map((item) => item.chunkId)).not.toContain(
      'chunk-hierarchical',
    );
    expect(searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { reelIds: ['reel-1'] } }),
    );
    expect(hierarchyObservationRepository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        conversationId: 'conversation-1',
        directChunkIds: expect.arrayContaining(['chunk-direct']),
        hierarchicalChunkIds: expect.arrayContaining(['chunk-hierarchical']),
      }),
    );
  });

  it('allows hierarchical serving in production only with explicit promotion approval', async () => {
    const { adapter, hierarchyObservationRepository } = buildAdapter({
      NODE_ENV: 'production',
      RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'true',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
      RAG_HIERARCHICAL_RETRIEVAL_PROMOTION_APPROVED: 'true',
    });

    const result = await adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route: transcriptRoute,
      plan,
    });

    expect(result.map((item) => item.chunkId)).toContain('chunk-hierarchical');
    expect(result.map((item) => item.chunkId)).not.toContain('chunk-direct');
    expect(hierarchyObservationRepository.save).not.toHaveBeenCalled();
  });

  it('searches visual scenes and skips transcript chunks for visual-only questions', async () => {
    const { adapter, searchChunks, searchVisualScenes } = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'false',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });

    const result = await adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route: visualRoute,
      plan: {
        ...plan,
        query: 'What diagram is visible?',
        queries: ['What diagram is visible?'],
      },
    });

    expect(searchChunks).not.toHaveBeenCalled();
    expect(searchVisualScenes).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { reelIds: ['reel-1'] },
        queryText: 'What diagram is visible?',
      }),
    );
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          chunkId: 'visual-scene-1',
          evidenceType: 'VISUAL',
        }),
      ]),
    );
  });
});
