import { PrismaUserMemoryRepository } from './prisma-user-memory.repository';

const rawMemory = {
  id: 'memory-1',
  userId: 'user-1',
  type: 'TECHNICAL_CONTEXT',
  content: 'The user deploys PostgreSQL with pgvector.',
  normalizedContent: 'the user deploys postgresql with pgvector.',
  confidence: 0.9,
  sourceConversationId: 'conversation-1',
  embeddingModel: 'test/baai/bge-m3',
  embeddingDimensions: 1024,
  embeddingVersion: 'cf-bge-m3-v1',
  semanticScore: 0.92,
  lastUsedAt: null,
  createdAt: new Date('2026-08-25T00:00:00.000Z'),
  updatedAt: new Date('2026-08-25T00:00:00.000Z'),
};

describe('PrismaUserMemoryRepository', () => {
  it('uses a legacy-compatible projection for ordinary memory reads', async () => {
    const {
      embeddingDimensions,
      embeddingVersion,
      semanticScore,
      ...legacyRow
    } = rawMemory;
    const prisma = {
      userMemory: {
        findMany: jest.fn().mockResolvedValue([legacyRow]),
      },
    };
    const repository = new PrismaUserMemoryRepository(prisma as never);

    await expect(repository.findByUserId('user-1', 10)).resolves.toEqual([
      expect.objectContaining({
        id: 'memory-1',
        content: rawMemory.content,
        embeddingDimensions: undefined,
        embeddingVersion: undefined,
      }),
    ]);

    const select = prisma.userMemory.findMany.mock.calls[0]?.[0]?.select;
    expect(select).toEqual(
      expect.objectContaining({
        id: true,
        userId: true,
        normalizedContent: true,
        embeddingModel: true,
      }),
    );
    expect(select).not.toHaveProperty('embeddingDimensions');
    expect(select).not.toHaveProperty('embeddingVersion');
    expect(embeddingDimensions).toBe(1024);
    expect(embeddingVersion).toBe('cf-bge-m3-v1');
    expect(semanticScore).toBe(0.92);
  });

  it('reads the live vector dimension from PostgreSQL metadata', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ formattedType: 'vector(1024)' }]),
    };
    const repository = new PrismaUserMemoryRepository(prisma as never);

    await expect(repository.getEmbeddingDimensions()).resolves.toBe(1024);
  });

  it('rejects a mismatched query before executing similarity SQL', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([{ formattedType: 'vector(384)' }]),
    };
    const repository = new PrismaUserMemoryRepository(prisma as never);

    await expect(
      repository.findRelevantByUserId({
        userId: 'user-1',
        queryVector: Array.from({ length: 1024 }, () => 0.01),
        limit: 5,
      }),
    ).rejects.toThrow(
      'UserMemory embedding dimension mismatch: query=1024, stored=384',
    );
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('accepts a matching vector and preserves identity metadata in ranking results', async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ formattedType: 'vector(1024)' }])
        .mockResolvedValueOnce([rawMemory]),
    };
    const repository = new PrismaUserMemoryRepository(prisma as never);

    await expect(
      repository.findRelevantByUserId({
        userId: 'user-1',
        queryVector: Array.from({ length: 1024 }, () => 0.01),
        limit: 5,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 'memory-1',
        content: rawMemory.content,
        embeddingModel: 'test/baai/bge-m3',
        embeddingDimensions: 1024,
        embeddingVersion: 'cf-bge-m3-v1',
        semanticScore: 0.92,
      }),
    ]);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
