import { SEMANTIC_INDEX_EMBEDDING_DIMENSIONS } from '@common/processing/interfaces/semantic-index.interface';
import type { SemanticIndexCandidate } from '@indexing/domain/interfaces/semantic-index.repository.interface';
import { PrismaSemanticIndexRepository } from './prisma-semantic-index.repository';

const embeddingIdentity = {
  provider: 'cloudflare-workers-ai',
  model: '@cf/baai/bge-m3',
  dimensions: SEMANTIC_INDEX_EMBEDDING_DIMENSIONS,
  version: 'cf-bge-m3-v1',
};

const configValues: Record<string, string> = {
  INDEX_EMBEDDING_PROVIDER: embeddingIdentity.provider,
  AI_EMBEDDING_MODEL: embeddingIdentity.model,
  AI_EMBEDDING_DIMENSIONS: String(embeddingIdentity.dimensions),
  AI_EMBEDDING_VERSION: embeddingIdentity.version,
};

const config = {
  get: jest.fn((key: string) => configValues[key]),
};

describe('PrismaSemanticIndexRepository single-vector search', () => {
  it('fails source-order reads closed without an explicit Reel scope', async () => {
    const query = jest.fn();
    const repository = new PrismaSemanticIndexRepository(
      { $queryRaw: query } as never,
      config as never,
    );
    await expect(
      repository.searchChunks({ sourceOrder: 'ASC' }),
    ).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('reads active source windows chronologically within the requested scope', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repository = new PrismaSemanticIndexRepository(
      { $queryRaw: query } as never,
      config as never,
    );
    await repository.searchChunks({
      sourceOrder: 'ASC',
      filters: { reelIds: ['authorized'] },
      requiredIndexVersion: 'v1',
      limit: 1,
    });
    const sql = query.mock.calls[0][0] as {
      strings: string[];
      values: unknown[];
    };
    expect(sql.strings.join('')).toContain(
      'ORDER BY t."startTime" ASC NULLS LAST',
    );
    expect(sql.strings.join('')).toContain('"isActive"');
    expect(sql.values).toContain('authorized');
    expect(sql.values).toContain('v1');
  });
  const queries: unknown[] = [];
  const transaction = {
    $executeRawUnsafe: jest.fn(),
    $queryRaw: jest.fn((query: unknown) => {
      queries.push(query);
      return Promise.resolve([]);
    }),
  };
  const prisma = {
    $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
  };

  beforeEach(() => {
    queries.length = 0;
    jest.clearAllMocks();
  });

  it('queries the canonical 1024-dimensional column with full model identity', async () => {
    const repository = new PrismaSemanticIndexRepository(
      prisma as never,
      config as never,
    );
    await repository.searchChunks({
      queryEmbedding: Array.from(
        { length: SEMANTIC_INDEX_EMBEDDING_DIMENSIONS },
        () => 0.01,
      ),
      queryEmbeddingModel: embeddingIdentity.model,
      queryEmbeddingVersion: embeddingIdentity.version,
    });

    const query = queries[0] as { strings: string[] };
    const sql = query.strings.join('');
    expect(sql).toContain('t."embedding"');
    expect(sql).not.toContain('embeddingV2');
    expect(sql.match(/"embeddingDimensions"/g)).toHaveLength(3);
    expect(sql.match(/"embeddingModel"/g)).toHaveLength(3);
    expect(sql.match(/"embeddingVersion"/g)).toHaveLength(3);
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it.each([384, 768])(
    'rejects a %i-dimensional query before constructing SQL',
    async (dimensions) => {
      const repository = new PrismaSemanticIndexRepository(
        prisma as never,
        config as never,
      );
      await expect(
        repository.searchChunks({
          queryEmbedding: Array.from({ length: dimensions }, () => 0.01),
          queryEmbeddingModel: embeddingIdentity.model,
          queryEmbeddingVersion: embeddingIdentity.version,
        }),
      ).rejects.toThrow('unsupported dimension');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['@cf/google/legacy-embedding', embeddingIdentity.version],
    [embeddingIdentity.model, 'legacy-v1'],
    [undefined, embeddingIdentity.version],
    [embeddingIdentity.model, undefined],
  ])(
    'rejects mismatched query identity model=%s version=%s',
    async (model, version) => {
      const repository = new PrismaSemanticIndexRepository(
        prisma as never,
        config as never,
      );
      await expect(
        repository.searchChunks({
          queryEmbedding: Array.from(
            { length: SEMANTIC_INDEX_EMBEDDING_DIMENSIONS },
            () => 0.01,
          ),
          queryEmbeddingModel: model,
          queryEmbeddingVersion: version,
        }),
      ).rejects.toThrow('model/version does not match');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
});

describe('PrismaSemanticIndexRepository single-vector persistence', () => {
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const transaction = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    reelDocument: { deleteMany },
    reelSection: { deleteMany },
    reelChunk: { deleteMany },
    reelVisualScene: { deleteMany },
    transcriptionSegment: { deleteMany, createMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
      Promise.resolve(callback(transaction)),
    ),
  };

  const candidate = (
    model = embeddingIdentity.model,
  ): SemanticIndexCandidate => ({
    job: {
      jobId: 'job-1',
      reelId: 'reel-1',
      userId: 'user-1',
      mediaAttemptId: 'media-1',
      indexAttemptId: 'attempt-1',
      indexVersion: 'index-v1',
      mediaKey: 'reels/reel-1/source.mp4',
      sourceDurationMs: 30_000,
      sourceOrientation: 'PORTRAIT',
      sourceLengthClass: 'SHORT',
      tags: [],
      createdAt: new Date(0).toISOString(),
      schemaVersion: 1,
    },
    metadata: { title: 'Reel', tags: [] },
    documents: [
      {
        id: 'reel:reel-1',
        reelId: 'reel-1',
        kind: 'REEL',
        ordinal: 0,
        retrievalText: 'A semantic reel document',
        sourceSectionIds: [],
        sourceSegmentIds: [],
        sourceAudioArtifactIds: [],
        retrievalHash: 'retrieval-hash',
        evidenceQuality: 'METADATA_ONLY',
        sectioningVersion: 'section-v1',
        chunkingVersion: 'chunk-v1',
        summaryVersion: 'summary-v1',
        indexVersion: 'index-v1',
        embeddingProvider: embeddingIdentity.provider,
        embeddingModel: model,
        embeddingDimensions: embeddingIdentity.dimensions,
        embeddingVersion: embeddingIdentity.version,
        embeddingInputHash: 'embedding-input-hash',
        embedding: Array.from(
          { length: SEMANTIC_INDEX_EMBEDDING_DIMENSIONS },
          () => 0.01,
        ),
        tokenCount: 4,
      },
    ],
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('persists only the canonical embedding column', async () => {
    const repository = new PrismaSemanticIndexRepository(
      prisma as never,
      config as never,
    );
    await repository.persistCandidate(candidate());

    const insert = transaction.$executeRaw.mock.calls
      .map(([query]) => query as { strings?: string[] })
      .find((query) => query.strings?.join('').includes('INSERT INTO'));
    const sql = insert?.strings?.join('') ?? '';
    expect(sql).toContain('"embedding", "embeddingProvider"');
    expect(sql).not.toContain('embeddingV2');
  });

  it('rejects a document whose embedding model does not match BGE-M3', async () => {
    const repository = new PrismaSemanticIndexRepository(
      prisma as never,
      config as never,
    );
    await expect(
      repository.persistCandidate(candidate('legacy-model')),
    ).rejects.toThrow('incompatible embedding identity or dimension');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PrismaSemanticIndexRepository activation', () => {
  it('deactivates and activates a complete candidate in one transaction', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    const transaction = {
      $executeRaw: jest.fn(),
      reelDocument: { updateMany, deleteMany },
      reelSection: { updateMany, deleteMany },
      reelChunk: { updateMany, deleteMany },
      reelVisualScene: { updateMany, deleteMany },
      transcriptionSegment: { deleteMany },
      indexingAttempt: { updateMany },
    };
    const prisma = {
      $transaction: jest.fn((callback: (tx: typeof transaction) => unknown) =>
        Promise.resolve(callback(transaction)),
      ),
    };
    const repository = new PrismaSemanticIndexRepository(
      prisma as never,
      { get: jest.fn() } as never,
    );

    await repository.activateCandidate('reel-1', 'attempt-2');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: { reelId: 'reel-1', indexAttemptId: 'attempt-2' },
      data: { isActive: true },
    });
    expect(transaction.indexingAttempt.updateMany).toHaveBeenCalledWith({
      where: { reelId: 'reel-1', indexAttemptId: 'attempt-2' },
      data: { status: 'COMPLETED', lastError: null },
    });
  });
});
