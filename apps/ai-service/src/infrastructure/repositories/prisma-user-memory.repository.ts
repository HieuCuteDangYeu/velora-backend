import { UserMemory } from '@ai/domain/entities/user-memory.entity';
import type {
  IUserMemoryRepository,
  UserMemoryEmbeddingIdentity,
  UserMemoryEmbeddingUpdateInput,
  UserMemorySemanticSearchInput,
  UserMemoryUpsertInput,
} from '@ai/domain/interfaces/user-memory.repository.interface';
import { PrismaService } from '@ai/infrastructure/prisma/prisma.service';
import type { UserMemoryType } from '@common/ai/interfaces/user-memory.interface';
import { Injectable } from '@nestjs/common';
import type { UserMemory as PrismaUserMemory } from '@prisma/ai-client';

type PrismaUserMemoryWithEmbeddingIdentity = Pick<
  PrismaUserMemory,
  | 'id'
  | 'userId'
  | 'type'
  | 'content'
  | 'normalizedContent'
  | 'confidence'
  | 'sourceConversationId'
  | 'embeddingModel'
  | 'lastUsedAt'
  | 'createdAt'
  | 'updatedAt'
> & {
  embeddingDimensions?: number | null;
  embeddingVersion?: string | null;
};

const LEGACY_COMPATIBLE_USER_MEMORY_SELECT = {
  id: true,
  userId: true,
  type: true,
  content: true,
  normalizedContent: true,
  confidence: true,
  sourceConversationId: true,
  embeddingModel: true,
  lastUsedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface UserMemoryRawRecord {
  id: string;
  userId: string;
  type: UserMemoryType;
  content: string;
  normalizedContent: string;
  confidence: number;
  sourceConversationId: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  embeddingVersion: string | null;
  semanticScore?: number | null;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PrismaUserMemoryRepository implements IUserMemoryRepository {
  /** The column type only changes with a migration, so a minute-old answer is safe to reuse. */
  private static readonly dimensionsTtlMs = 60_000;
  private dimensionsLookup?: { expiresAt: number; value: Promise<number> };

  constructor(private readonly prisma: PrismaService) {}

  /** Every retrieval and write checks this; callers in one turn share a single catalog query. */
  getEmbeddingDimensions(): Promise<number> {
    const cached = this.dimensionsLookup;
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const value = this.readEmbeddingDimensions();
    const lookup = {
      expiresAt: Date.now() + PrismaUserMemoryRepository.dimensionsTtlMs,
      value,
    };
    this.dimensionsLookup = lookup;
    // A failed lookup is never remembered: the next call asks the database again.
    value.catch(() => {
      if (this.dimensionsLookup === lookup) this.dimensionsLookup = undefined;
    });
    return value;
  }

  private async readEmbeddingDimensions(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ formattedType: string }>>`
      SELECT format_type(a.atttypid, a.atttypmod) AS "formattedType"
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = 'UserMemory'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped
    `;
    const match = /^vector\((\d+)\)$/.exec(rows[0]?.formattedType ?? '');
    if (!match) throw new Error('UserMemory embedding column is unavailable');
    return Number(match[1]);
  }

  async findByUserId(userId: string, limit: number): Promise<UserMemory[]> {
    const memories = await this.prisma.userMemory.findMany({
      select: LEGACY_COMPATIBLE_USER_MEMORY_SELECT,
      where: {
        userId,
        confidence: {
          gte: 0.5,
        },
      },
      orderBy: [{ updatedAt: 'desc' }, { confidence: 'desc' }],
      take: this.normalizeLimit(limit, 1, 100),
    });

    return memories.map((memory) => this.toDomain(memory));
  }

  async findRelevantByUserId(
    input: UserMemorySemanticSearchInput,
  ): Promise<UserMemory[]> {
    if (input.queryVector.length === 0) {
      return [];
    }

    await this.assertEmbeddingDimensions(input.queryVector);

    const vectorLiteral = `[${input.queryVector.join(',')}]`;
    const limit = this.normalizeLimit(input.limit, 1, 50);
    const minScore = this.clamp(input.minScore ?? 0.42, -1, 1);
    const minConfidence = this.clamp(input.minConfidence ?? 0.5, 0, 1);

    const rows = await this.prisma.$queryRaw<UserMemoryRawRecord[]>`
      WITH ranked AS (
        SELECT
          um.id,
          um."userId",
          um.type::text AS type,
          um.content,
          um."normalizedContent",
          um.confidence,
          um."sourceConversationId",
          um."embeddingModel",
          (to_jsonb(um)->>'embeddingDimensions')::int AS "embeddingDimensions",
          to_jsonb(um)->>'embeddingVersion' AS "embeddingVersion",
          um."lastUsedAt",
          um."createdAt",
          um."updatedAt",
          (um.embedding <=> ${vectorLiteral}::vector)::float AS distance
        FROM "UserMemory" um
        WHERE um."userId" = ${input.userId}
          AND um.embedding IS NOT NULL
          AND um.confidence >= ${minConfidence}
          AND (${input.queryEmbeddingModel ?? null}::text IS NULL OR um."embeddingModel" = ${input.queryEmbeddingModel ?? null})
          AND (${input.queryEmbeddingVersion ?? null}::text IS NULL OR (to_jsonb(um)->>'embeddingVersion') = ${input.queryEmbeddingVersion ?? null})
      ),

      scored AS (
        SELECT
          *,
          (1.0 - LEAST(distance, 1.0))::float AS "semanticScore",
          (
            ((1.0 - LEAST(distance, 1.0)) * 0.82)
            +
            (confidence * 0.12)
            +
            (
              (
                1.0 / (
                  1.0 +
                  (
                    GREATEST(
                      EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - "updatedAt")) / 86400.0,
                      0.0
                    ) / 30.0
                  )
                )
              ) * 0.06
            )
          )::float AS "rankScore"
        FROM ranked
      )

      SELECT
        id,
        "userId",
        type,
        content,
        "normalizedContent",
        confidence,
        "sourceConversationId",
        "embeddingModel",
        "embeddingDimensions",
        "embeddingVersion",
        "semanticScore",
        "lastUsedAt",
        "createdAt",
        "updatedAt"
      FROM scored
      WHERE "semanticScore" >= ${minScore}
      ORDER BY "rankScore" DESC, "semanticScore" DESC
      LIMIT ${limit};
    `;

    return rows.map((row) => this.toDomainFromRaw(row));
  }

  async findWithoutEmbedding(
    limit: number,
    identity?: UserMemoryEmbeddingIdentity,
  ): Promise<UserMemory[]> {
    const normalizedLimit = this.normalizeLimit(limit, 1, 500);

    const rows = await this.prisma.$queryRaw<UserMemoryRawRecord[]>`
      SELECT
        id,
        "userId",
        type::text AS type,
        content,
        "normalizedContent",
        confidence,
        "sourceConversationId",
        "embeddingModel",
        (to_jsonb(um)->>'embeddingDimensions')::int AS "embeddingDimensions",
        to_jsonb(um)->>'embeddingVersion' AS "embeddingVersion",
        NULL::float AS "semanticScore",
        "lastUsedAt",
        "createdAt",
        "updatedAt"
      FROM "UserMemory" um
      WHERE um.embedding IS NULL
        OR (
          ${identity?.model ?? null}::text IS NOT NULL
          AND (
            um."embeddingModel" IS DISTINCT FROM ${identity?.model ?? null}
            OR (to_jsonb(um)->>'embeddingDimensions')::int IS DISTINCT FROM ${identity?.dimensions ?? null}
            OR to_jsonb(um)->>'embeddingVersion' IS DISTINCT FROM ${identity?.version ?? null}
          )
        )
      ORDER BY um."updatedAt" DESC
      LIMIT ${normalizedLimit};
    `;

    return rows.map((row) => this.toDomainFromRaw(row));
  }

  async upsertMany(inputs: UserMemoryUpsertInput[]): Promise<UserMemory[]> {
    const results: UserMemory[] = [];

    for (const input of inputs) {
      if (this.hasEmbedding(input.embedding)) {
        await this.assertEmbeddingDimensions(input.embedding);
      }
      const memory = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.userMemory.upsert({
          select: LEGACY_COMPATIBLE_USER_MEMORY_SELECT,
          where: {
            userId_type_normalizedContent: {
              userId: input.userId,
              type: input.type,
              normalizedContent: input.normalizedContent,
            },
          },
          create: {
            userId: input.userId,
            type: input.type,
            content: input.content,
            normalizedContent: input.normalizedContent,
            confidence: input.confidence,
            sourceConversationId: input.sourceConversationId,
            embeddingModel: input.embeddingModel,
          },
          update: {
            content: input.content,
            confidence: Math.max(input.confidence, 0.5),
            sourceConversationId: input.sourceConversationId,
            embeddingModel: input.embeddingModel,
            updatedAt: new Date(),
          },
        });

        if (this.hasEmbedding(input.embedding)) {
          const vectorLiteral = `[${input.embedding.join(',')}]`;

          await tx.$executeRaw`
            UPDATE "UserMemory"
            SET
              embedding = ${vectorLiteral}::vector,
              "embeddingModel" = ${input.embeddingModel ?? null},
              "embeddingDimensions" = ${input.embeddingDimensions ?? null},
              "embeddingVersion" = ${input.embeddingVersion ?? null},
              "updatedAt" = CURRENT_TIMESTAMP
            WHERE id = ${saved.id}
          `;
        }

        return saved;
      });

      results.push(this.toDomain(memory));
    }

    return results;
  }

  async replaceSimilar(
    memoryId: string,
    input: UserMemoryUpsertInput,
  ): Promise<UserMemory> {
    if (this.hasEmbedding(input.embedding)) {
      await this.assertEmbeddingDimensions(input.embedding);
    }
    const saved = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.userMemory.findUnique({
        select: LEGACY_COMPATIBLE_USER_MEMORY_SELECT,
        where: { id: memoryId },
      });

      if (!existing || existing.userId !== input.userId) {
        throw new Error(
          `User memory ${memoryId} is not available for replacement`,
        );
      }

      const updated = await tx.userMemory.update({
        select: LEGACY_COMPATIBLE_USER_MEMORY_SELECT,
        where: { id: memoryId },
        data: {
          type: input.type,
          content: input.content,
          normalizedContent: input.normalizedContent,
          confidence: Math.max(existing.confidence, input.confidence),
          sourceConversationId: input.sourceConversationId,
          embeddingModel: input.embeddingModel,
          updatedAt: new Date(),
        },
      });

      if (this.hasEmbedding(input.embedding)) {
        const vectorLiteral = `[${input.embedding.join(',')}]`;
        await tx.$executeRaw`
          UPDATE "UserMemory"
          SET
            embedding = ${vectorLiteral}::vector,
            "embeddingModel" = ${input.embeddingModel ?? null},
            "embeddingDimensions" = ${input.embeddingDimensions ?? null},
            "embeddingVersion" = ${input.embeddingVersion ?? null},
            "updatedAt" = CURRENT_TIMESTAMP
          WHERE id = ${memoryId}
        `;
      }

      return updated;
    });

    return this.toDomain(saved);
  }

  async updateEmbedding(input: UserMemoryEmbeddingUpdateInput): Promise<void> {
    if (!this.hasEmbedding(input.embedding)) {
      return;
    }

    await this.assertEmbeddingDimensions(input.embedding);

    const vectorLiteral = `[${input.embedding.join(',')}]`;

    await this.prisma.$executeRaw`
      UPDATE "UserMemory"
      SET
        embedding = ${vectorLiteral}::vector,
        "embeddingModel" = ${input.embeddingModel},
        "embeddingDimensions" = ${input.embeddingDimensions},
        "embeddingVersion" = ${input.embeddingVersion},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.memoryId}
    `;
  }

  async markUsed(memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) {
      return;
    }

    await this.prisma.userMemory.updateMany({
      where: {
        id: {
          in: memoryIds,
        },
      },
      data: {
        lastUsedAt: new Date(),
      },
    });
  }

  private toDomain(memory: PrismaUserMemoryWithEmbeddingIdentity): UserMemory {
    return new UserMemory({
      id: memory.id,
      userId: memory.userId,
      type: memory.type,
      content: memory.content,
      normalizedContent: memory.normalizedContent,
      confidence: memory.confidence,
      sourceConversationId: memory.sourceConversationId ?? undefined,
      embeddingModel: memory.embeddingModel ?? undefined,
      embeddingDimensions: memory.embeddingDimensions ?? undefined,
      embeddingVersion: memory.embeddingVersion ?? undefined,
      lastUsedAt: memory.lastUsedAt ?? undefined,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
  }

  private toDomainFromRaw(memory: UserMemoryRawRecord): UserMemory {
    return new UserMemory({
      id: memory.id,
      userId: memory.userId,
      type: memory.type,
      content: memory.content,
      normalizedContent: memory.normalizedContent,
      confidence: memory.confidence,
      sourceConversationId: memory.sourceConversationId ?? undefined,
      embeddingModel: memory.embeddingModel ?? undefined,
      embeddingDimensions: memory.embeddingDimensions ?? undefined,
      embeddingVersion: memory.embeddingVersion ?? undefined,
      semanticScore: memory.semanticScore ?? undefined,
      lastUsedAt: memory.lastUsedAt ?? undefined,
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });
  }

  private hasEmbedding(value?: number[]): value is number[] {
    return (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === 'number' && Number.isFinite(item))
    );
  }

  private async assertEmbeddingDimensions(embedding: number[]): Promise<void> {
    const storedDimensions = await this.getEmbeddingDimensions();
    if (embedding.length !== storedDimensions) {
      throw new Error(
        `UserMemory embedding dimension mismatch: query=${embedding.length}, stored=${storedDimensions}`,
      );
    }
  }

  private normalizeLimit(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) {
      return min;
    }

    return Math.min(Math.max(Math.floor(value), min), max);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.min(Math.max(value, min), max);
  }
}
