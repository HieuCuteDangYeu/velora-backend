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

const multimodalRoute: RagChatRouteDecision = {
  ...transcriptRoute,
  reelQuestionType: 'MULTIMODAL_CONTENT',
  requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
  reason: 'Question requires spoken and visual reel evidence.',
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
  it('reads an exact zero-time sampled frame without embeddings or a planner call', async () => {
    const { adapter, semanticIndexService, embeddingService, generateObject } =
      buildAdapter({});
    const scene = {
      ...visualCandidate,
      indexVersion: 'v1',
      startTime: 0,
      endTime: 0,
    };
    (semanticIndexService.searchVisualScenes as jest.Mock).mockResolvedValue([
      scene,
    ]);
    const plan = await adapter.plan({
      message: 'What is visible in the sampled frame at 0 seconds?',
      route: visualRoute,
    });
    const result = await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: visualRoute,
      plan,
      accessibleReelIds: ['reel-1'],
    });
    expect(result).toHaveLength(1);
    expect(semanticIndexService.searchVisualScenes).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceTimestampSec: 0,
        sourceOrder: 'ASC',
        requiredIndexVersion: 'v1',
        filters: { reelIds: ['reel-1'] },
      }),
    );
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('rejects foreign or wrong-time visual evidence returned by the index adapter', async () => {
    const { adapter, semanticIndexService } = buildAdapter({});
    (semanticIndexService.searchVisualScenes as jest.Mock).mockResolvedValue([
      { ...visualCandidate, reelId: 'foreign', startTime: 0, endTime: 0 },
      { ...visualCandidate, startTime: 10, endTime: 10 },
    ]);
    const plan = await adapter.plan({
      message: 'Describe the frame at 0 seconds.',
      route: visualRoute,
    });
    await expect(
      adapter.retrieve({
        userId: 'user',
        conversationId: 'conversation',
        route: visualRoute,
        plan,
        accessibleReelIds: ['reel-1'],
      }),
    ).resolves.toEqual([]);
  });

  it('passes both endpoints for an explicit transcript time window', async () => {
    const { adapter, semanticIndexService, embeddingService, generateObject } =
      buildAdapter({});
    const plan = await adapter.plan({
      message: 'Summarize the transcript segment spanning 11.68-56.38 seconds.',
      route: transcriptRoute,
    });
    await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: transcriptRoute,
      plan,
      accessibleReelIds: ['reel-1'],
    });
    expect(semanticIndexService.searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceOrder: 'ASC',
        sourceTimestampSec: 11.68,
        sourceTimestampEndSec: 56.38,
        limit: 2,
      }),
    );
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('applies independent time constraints to transcript and visual searches', async () => {
    const { adapter, semanticIndexService, embeddingService, generateObject } =
      buildAdapter({});
    const retrievalPlan = await adapter.plan({
      message:
        'What is said in the transcript segment spanning 11.68-56.38 seconds while the frame is at 33.25 seconds?',
      route: multimodalRoute,
    });
    await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: multimodalRoute,
      plan: retrievalPlan,
      accessibleReelIds: ['reel-1'],
    });

    const transcriptSearch = jest.mocked(semanticIndexService.searchChunks).mock
      .calls[0][0];
    const visualSearch = jest.mocked(semanticIndexService.searchVisualScenes)
      .mock.calls[0][0];
    expect(transcriptSearch).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 11.68,
      sourceTimestampEndSec: 56.38,
    });
    expect(visualSearch).toMatchObject({
      sourceOrder: 'ASC',
      sourceTimestampSec: 33.25,
    });
    expect(visualSearch).not.toHaveProperty('sourceTimestampEndSec');
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('keeps modality-specific time constraints separate across multiple Reels', async () => {
    const { adapter, semanticIndexService } = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'false',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: multimodalRoute,
      plan: {
        ...plan,
        sourceOrder: 'ASC',
        visualTimestampSec: 33.25,
        transcriptTimestampSec: 11.68,
        transcriptTimestampEndSec: 56.38,
        query: 'Compare the requested frame and speech.',
        queries: ['Compare the requested frame and speech.'],
      },
      accessibleReelIds: ['reel-1', 'reel-2'],
    });

    expect(semanticIndexService.searchChunks).toHaveBeenCalledTimes(2);
    for (const [request] of jest.mocked(semanticIndexService.searchChunks).mock
      .calls) {
      expect(request).toMatchObject({
        sourceTimestampSec: 11.68,
        sourceTimestampEndSec: 56.38,
      });
    }
    expect(semanticIndexService.searchVisualScenes).toHaveBeenCalledTimes(2);
    for (const [request] of jest.mocked(semanticIndexService.searchVisualScenes)
      .mock.calls) {
      expect(request).toMatchObject({ sourceTimestampSec: 33.25 });
      expect(request).not.toHaveProperty('sourceTimestampEndSec');
    }
  });

  it('retrieves the earliest transcript chunk from each Reel for a first-segment comparison', async () => {
    const { adapter, semanticIndexService, embeddingService, generateObject } =
      buildAdapter({
        NODE_ENV: 'test',
        RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'false',
        RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
      });
    const earliestByReel = new Map([
      ['reel-1', { ...directCandidate, id: 'first-reel-1', reelId: 'reel-1' }],
      ['reel-2', { ...directCandidate, id: 'first-reel-2', reelId: 'reel-2' }],
    ]);
    jest
      .mocked(semanticIndexService.searchChunks)
      .mockImplementation((request) => {
        const reelId = request.filters?.reelIds?.[0];
        const candidate = reelId ? earliestByReel.get(reelId) : undefined;
        return Promise.resolve(candidate ? [candidate] : []);
      });
    jest
      .mocked(semanticIndexService.getReelDocument)
      .mockImplementation((reelId) =>
        Promise.resolve({
          ...reelDocument,
          id: `document-${reelId}`,
          reelId,
          title: `Title ${reelId}`,
        }),
      );

    const question =
      'Compare the first indexed transcript segments of "Episode 11" and "Episode 1". Attribute each statement to its own clip.';
    const retrievalPlan = await adapter.plan({
      message: question,
      route: transcriptRoute,
    });
    const result = await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: transcriptRoute,
      plan: retrievalPlan,
      accessibleReelIds: ['reel-1', 'reel-2'],
    });

    expect(retrievalPlan).toMatchObject({
      sourceOrder: 'ASC',
      requiresReelCoverage: true,
      searchLimit: 1,
    });
    expect(semanticIndexService.searchChunks).toHaveBeenCalledTimes(2);
    for (const [request] of jest.mocked(semanticIndexService.searchChunks).mock
      .calls) {
      expect(request).toMatchObject({
        sourceOrder: 'ASC',
        limit: 1,
        filters: { reelIds: [expect.any(String)] },
      });
    }
    expect(result.map((item) => item.chunkId)).toEqual([
      'first-reel-1',
      'first-reel-2',
    ]);
    expect(result.map((item) => item.title)).toEqual([
      'Title reel-1',
      'Title reel-2',
    ]);
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('does not read the beginning of every shared Reel for a singular first-sentence question', async () => {
    const { adapter, embeddingService } = buildAdapter({
      NODE_ENV: 'test',
      RAG_HIERARCHICAL_RETRIEVAL_ENABLED: 'false',
      RAG_HIERARCHICAL_RETRIEVAL_SHADOW_ENABLED: 'false',
    });
    const retrievalPlan = await adapter.plan({
      message: 'What is the first complete sentence in the shared transcript?',
      route: transcriptRoute,
    });

    expect(retrievalPlan).toMatchObject({
      sourceOrder: 'ASC',
      requiresReelCoverage: false,
    });
    await adapter.retrieve({
      userId: 'user',
      conversationId: 'conversation',
      route: transcriptRoute,
      plan: retrievalPlan,
      accessibleReelIds: ['reel-1', 'reel-2'],
    });

    expect(embeddingService.generateVector).toHaveBeenCalledTimes(1);
  });

  it('reads opening statements in source order instead of retrieving a semantically similar later window', async () => {
    const { adapter, semanticIndexService, embeddingService, generateObject } =
      buildAdapter({});
    const openingPlan = await adapter.plan({
      message: 'What is the opening statement?',
      route: transcriptRoute,
    });
    await adapter.retrieve({
      userId: 'u',
      conversationId: 'c',
      route: transcriptRoute,
      plan: openingPlan,
      accessibleReelIds: ['reel-1'],
    });
    expect(semanticIndexService.searchChunks).toHaveBeenCalledWith({
      filters: { reelIds: ['reel-1'] },
      sourceOrder: 'ASC',
      requiredIndexVersion: 'v1',
      limit: 1,
    });
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('allocates transcript retrieval budget across multiple authorized Reels', async () => {
    const { adapter, semanticIndexService } = buildAdapter({});
    jest
      .mocked(semanticIndexService.getReelDocument)
      .mockImplementation((reelId) =>
        Promise.resolve({
          ...reelDocument,
          reelId,
        }),
      );
    jest.mocked(semanticIndexService.searchChunks).mockImplementation((input) =>
      Promise.resolve([
        {
          ...directCandidate,
          id: `chunk-${input.filters?.reelIds?.[0] ?? 'unknown'}`,
          reelId: input.filters?.reelIds?.[0] ?? 'unknown',
          indexVersion: 'v1',
        },
      ]),
    );
    const result = await adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route: transcriptRoute,
      plan: { ...plan, searchLimit: 4, shouldRerank: false },
      accessibleReelIds: ['reel-1', 'reel-2'],
    });
    expect(semanticIndexService.searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { reelIds: ['reel-1'] }, limit: 2 }),
    );
    expect(semanticIndexService.searchChunks).toHaveBeenCalledWith(
      expect.objectContaining({ filters: { reelIds: ['reel-2'] }, limit: 2 }),
    );
    expect(new Set(result.map((item) => item.reelId))).toEqual(
      new Set(['reel-1', 'reel-2']),
    );
  });

  it('retains every required evidence modality after reranking', async () => {
    const { adapter, rerank } = buildAdapter({});
    rerank.mockResolvedValue([directCandidate as never]);
    const result = await adapter.rerank({
      plan: { ...plan, shouldRerank: true },
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      retrievedChunks: [
        {
          ...directCandidate,
          chunkId: 'transcript',
          evidenceType: 'TRANSCRIPT',
        },
        { ...visualCandidate, chunkId: 'visual', evidenceType: 'VISUAL' },
      ] as never,
    });
    expect(result.map((item) => item.evidenceType)).toEqual(
      expect.arrayContaining(['TRANSCRIPT', 'VISUAL']),
    );
  });

  it('retains one evidence item from every requested comparison Reel after reranking', async () => {
    const { adapter, rerank } = buildAdapter({});
    rerank.mockResolvedValue([directCandidate as never]);
    const result = await adapter.rerank({
      plan: {
        ...plan,
        requiresReelCoverage: true,
        shouldRerank: true,
        rerankLimit: 1,
      },
      retrievedChunks: [
        { ...directCandidate, chunkId: 'reel-1-hit', reelId: 'reel-1' },
        { ...directCandidate, chunkId: 'reel-2-hit', reelId: 'reel-2' },
      ] as never,
    });
    expect(new Set(result.map((item) => item.reelId))).toEqual(
      new Set(['reel-1', 'reel-2']),
    );
  });

  it('restores every required modality for each comparison Reel after reranking', async () => {
    const { adapter, rerank } = buildAdapter({});
    const transcriptOne = {
      ...directCandidate,
      chunkId: 'transcript-1',
      reelId: 'reel-1',
      evidenceType: 'TRANSCRIPT' as const,
    };
    rerank.mockResolvedValue([{ ...transcriptOne, rerankScore: 1 } as never]);

    const result = await adapter.rerank({
      plan: {
        ...plan,
        requiresReelCoverage: true,
        shouldRerank: true,
        rerankLimit: 1,
      },
      requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      retrievedChunks: [
        transcriptOne,
        {
          ...visualCandidate,
          chunkId: 'visual-1',
          reelId: 'reel-1',
          evidenceType: 'VISUAL',
        },
        {
          ...directCandidate,
          chunkId: 'transcript-2',
          reelId: 'reel-2',
          evidenceType: 'TRANSCRIPT',
        },
        {
          ...visualCandidate,
          chunkId: 'visual-2',
          reelId: 'reel-2',
          evidenceType: 'VISUAL',
        },
      ] as never,
    });

    expect(
      new Set(result.map((item) => `${item.reelId}:${item.evidenceType}`)),
    ).toEqual(
      new Set([
        'reel-1:TRANSCRIPT',
        'reel-1:VISUAL',
        'reel-2:TRANSCRIPT',
        'reel-2:VISUAL',
      ]),
    );
  });
  it('reads typed metadata without a planner, embedding, or transcript search', async () => {
    const {
      adapter,
      generateObject,
      embeddingService,
      searchChunks,
      semanticIndexService,
    } = buildAdapter({});
    const route = {
      ...transcriptRoute,
      reelQuestionType: 'REEL_METADATA' as const,
      requiredEvidence: ['METADATA' as const],
    };
    const metadataPlan = await adapter.plan({
      message: 'Which tags are associated with this Reel?',
      route,
    });
    jest
      .mocked(semanticIndexService.getReelDocument)
      .mockResolvedValue({ ...reelDocument, tags: ['canonical-tag'] });
    const result = await adapter.retrieve({
      userId: 'user-1',
      conversationId: 'conversation-1',
      route,
      plan: metadataPlan,
      accessibleReelIds: ['reel-1'],
    });
    expect(result).toEqual([
      expect.objectContaining({
        chunkId: 'reel-document-1',
        evidenceType: 'METADATA',
        tags: ['canonical-tag'],
        evidenceText: expect.stringContaining('Tags: canonical-tag'),
      }),
    ]);
    expect(generateObject).not.toHaveBeenCalled();
    expect(embeddingService.generateVector).not.toHaveBeenCalled();
    expect(searchChunks).not.toHaveBeenCalled();
  });

  it('never returns a metadata document outside Content-resolved access', async () => {
    const { adapter, semanticIndexService } = buildAdapter({});
    jest
      .mocked(semanticIndexService.getReelDocument)
      .mockResolvedValue({ ...reelDocument, reelId: 'private-reel' });
    await expect(
      adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: {
          ...transcriptRoute,
          reelQuestionType: 'REEL_METADATA',
          requiredEvidence: ['METADATA'],
        },
        plan,
        accessibleReelIds: ['reel-1'],
      }),
    ).resolves.toEqual([]);
  });

  it('does not choose an arbitrary Reel when a metadata referent is ambiguous', async () => {
    const { adapter, semanticIndexService } = buildAdapter({});
    jest
      .mocked(semanticIndexService.searchReels)
      .mockResolvedValue([
        reelCandidate,
        { ...reelCandidate, id: 'other', reelId: 'reel-2' },
      ]);
    await expect(
      adapter.retrieve({
        userId: 'user-1',
        conversationId: 'conversation-1',
        route: {
          ...transcriptRoute,
          reelQuestionType: 'REEL_METADATA',
          requiredEvidence: ['METADATA'],
        },
        plan,
        accessibleReelIds: ['reel-1', 'reel-2'],
      }),
    ).resolves.toEqual([]);
    expect(semanticIndexService.getReelDocument).not.toHaveBeenCalled();
  });

  it('expands only selected transcript hits and rejects wrong-version or out-of-scope neighbors', async () => {
    const { adapter, rerank, semanticIndexService } = buildAdapter({});
    const hit = {
      ...directCandidate,
      chunkId: directCandidate.id,
      chunkText: directCandidate.evidenceText!,
      indexVersion: 'v1',
      distance: null,
    };
    rerank.mockResolvedValue([hit]);
    jest.mocked(semanticIndexService.getAdjacentChunks).mockResolvedValue([
      {
        ...directCandidate,
        id: 'good-neighbor',
        ordinal: 1,
        indexVersion: 'v1',
      },
      {
        ...directCandidate,
        id: 'private',
        reelId: 'private-reel',
        indexVersion: 'v1',
      },
      { ...directCandidate, id: 'stale', indexVersion: 'v0' },
    ]);
    const result = await adapter.rerank({
      plan: { ...plan, shouldRerank: true },
      retrievedChunks: [hit],
    });
    expect(result.map((item) => item.chunkId)).toEqual([
      hit.chunkId,
      'good-neighbor',
    ]);
    expect(semanticIndexService.getAdjacentChunks).toHaveBeenCalledWith(
      expect.objectContaining({
        eligibleReelIds: ['reel-1'],
        requiredIndexVersion: 'v1',
        parentId: hit.parentId,
      }),
    );
  });

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
    expect(request.systemPrompt).toContain('Return exactly these nine fields');
    expect(request.jsonSchema.properties).toEqual(
      expect.objectContaining({
        query: expect.objectContaining({ maxLength: 500 }),
        queries: expect.objectContaining({ minItems: 1, maxItems: 3 }),
        searchLimit: expect.objectContaining({ minimum: 1, maximum: 20 }),
        rerankLimit: expect.objectContaining({ minimum: 1, maximum: 10 }),
        requiresReelCoverage: expect.objectContaining({ type: 'boolean' }),
        reason: expect.objectContaining({ maxLength: 240 }),
      }),
    );
  });

  it('keeps episode-level source coverage when the planner turns it off', async () => {
    const { adapter, generateObject } = buildAdapter({
      AI_RETRIEVAL_PLANNER_MODEL: 'test/openai/gpt-oss-20b',
    });
    generateObject.mockResolvedValueOnce({
      mode: 'REEL_HYBRID',
      query: 'spoken episode facts',
      rewrittenQuery: '',
      queries: ['spoken episode facts'],
      searchLimit: 5,
      rerankLimit: 5,
      shouldRerank: true,
      requiresReelCoverage: false,
      reason: 'The model omitted requested source coverage.',
    });

    await expect(
      adapter.plan({
        message:
          'What does the narrator say in Episode 1 and what does William say in Episode 2?',
        route: transcriptRoute,
      }),
    ).resolves.toMatchObject({ requiresReelCoverage: true });
  });

  it('keeps explicit coverage for distinct episodes when the planner omits it', async () => {
    const { adapter, generateObject } = buildAdapter({
      AI_RETRIEVAL_PLANNER_MODEL: 'test/openai/gpt-oss-20b',
    });
    generateObject.mockResolvedValueOnce({
      mode: 'REEL_HYBRID',
      query: 'spoken episode facts',
      rewrittenQuery: '',
      queries: ['spoken episode facts'],
      searchLimit: 5,
      rerankLimit: 5,
      shouldRerank: true,
      requiresReelCoverage: false,
      reason: 'The model omitted requested source coverage.',
    });

    await expect(
      adapter.plan({
        message:
          'What does the narrator say in Episode 1 and what does William say in Episode 2?',
        route: transcriptRoute,
      }),
    ).resolves.toMatchObject({ requiresReelCoverage: true });
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
