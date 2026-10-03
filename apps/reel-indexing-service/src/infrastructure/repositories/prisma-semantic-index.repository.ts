import type {
  AdjacentChunkRequest,
  SemanticIndexEvidenceType,
  SemanticIndexSearchFilters,
  SemanticIndexSearchRequest,
  SemanticIndexSearchResult,
  SemanticReelDocument,
} from '@common/processing/interfaces/semantic-index.interface';
import { SEMANTIC_INDEX_EMBEDDING_DIMENSIONS } from '@common/processing/interfaces/semantic-index.interface';
import type {
  ISemanticIndexRepository,
  SemanticIndexCandidate,
} from '@indexing/domain/interfaces/semantic-index.repository.interface';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/reel-indexing-client';
import { randomUUID } from 'crypto';

type SemanticTable =
  | 'ReelDocument'
  | 'ReelSection'
  | 'ReelChunk'
  | 'ReelVisualScene';

interface SearchRow {
  id: string;
  indexVersion?: string;
  reelId: string;
  parentId: string | null;
  ordinal: number;
  userId: string;
  text: string;
  retrievalText: string;
  evidenceText: string | null;
  evidenceType: SemanticIndexEvidenceType;
  tags: string[];
  startTime: number | null;
  endTime: number | null;
  sourceDurationMs: number;
  sourceOrientation: SemanticIndexSearchResult['sourceOrientation'];
  sourceLengthClass: SemanticIndexSearchResult['sourceLengthClass'];
  rrfScore: number;
  vectorDistance: number | null;
  vectorRank: bigint | null;
  keywordRank: bigint | null;
  metadataRank: bigint | null;
}

interface ReelDocumentRow {
  id: string;
  reelId: string;
  userId: string;
  title: string | null;
  description: string | null;
  text: string;
  tags: string[];
  sourceDurationMs: number;
  sourceOrientation: SemanticReelDocument['sourceOrientation'];
  sourceLengthClass: SemanticReelDocument['sourceLengthClass'];
  indexAttemptId: string;
  indexVersion: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
  embeddingVersion: string;
  chunkingVersion: string;
  summaryVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class PrismaSemanticIndexRepository implements ISemanticIndexRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async persistCandidate(input: SemanticIndexCandidate): Promise<void> {
    const reel = input.documents.filter((document) => document.kind === 'REEL');
    const sections = input.documents.filter(
      (document) => document.kind === 'SECTION',
    );
    const chunks = input.documents.filter(
      (document) => document.kind === 'CHUNK',
    );
    const visualScenes = input.documents.filter(
      (document) => document.kind === 'VISUAL_SCENE',
    );
    if (reel.length !== 1) {
      throw new Error('Semantic index requires exactly one Reel document');
    }
    input.documents.forEach((document) => this.validateDocument(document));

    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${input.job.reelId}))`;
      await transaction.transcriptionSegment.deleteMany({
        where: { indexAttemptId: input.job.indexAttemptId },
      });
      await transaction.reelVisualScene.deleteMany({
        where: { indexAttemptId: input.job.indexAttemptId },
      });
      await transaction.reelChunk.deleteMany({
        where: { indexAttemptId: input.job.indexAttemptId },
      });
      await transaction.reelSection.deleteMany({
        where: { indexAttemptId: input.job.indexAttemptId },
      });
      await transaction.reelDocument.deleteMany({
        where: { indexAttemptId: input.job.indexAttemptId },
      });

      await transaction.$executeRaw(
        this.insertDocuments('ReelDocument', reel, input),
      );
      if (sections.length) {
        await transaction.$executeRaw(
          this.insertDocuments('ReelSection', sections, input),
        );
      }
      if (chunks.length) {
        await transaction.$executeRaw(
          this.insertDocuments('ReelChunk', chunks, input),
        );
      }
      if (visualScenes.length) {
        await transaction.$executeRaw(
          this.insertDocuments('ReelVisualScene', visualScenes, input),
        );
      }
      if (input.transcriptSegments?.length) {
        await transaction.transcriptionSegment.createMany({
          data: input.transcriptSegments.map((segment, ordinal) => ({
            id: randomUUID(),
            reelId: input.job.reelId,
            indexAttemptId: input.job.indexAttemptId,
            ordinal,
            startTime: segment.start,
            endTime: segment.end,
            text: segment.text,
          })),
        });
      }
    });
  }

  async activateCandidate(
    reelId: string,
    indexAttemptId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reelId}))`;
      await transaction.reelVisualScene.updateMany({
        where: { reelId, isActive: true },
        data: { isActive: false },
      });
      await transaction.reelChunk.updateMany({
        where: { reelId, isActive: true },
        data: { isActive: false },
      });
      await transaction.reelSection.updateMany({
        where: { reelId, isActive: true },
        data: { isActive: false },
      });
      await transaction.reelDocument.updateMany({
        where: { reelId, isActive: true },
        data: { isActive: false },
      });
      const activated = await transaction.reelDocument.updateMany({
        where: { reelId, indexAttemptId },
        data: { isActive: true },
      });
      if (activated.count !== 1) {
        throw new Error(`Semantic candidate ${indexAttemptId} is missing`);
      }
      await transaction.reelSection.updateMany({
        where: { reelId, indexAttemptId },
        data: { isActive: true },
      });
      await transaction.reelChunk.updateMany({
        where: { reelId, indexAttemptId },
        data: { isActive: true },
      });
      await transaction.reelVisualScene.updateMany({
        where: { reelId, indexAttemptId },
        data: { isActive: true },
      });
      await transaction.reelVisualScene.deleteMany({
        where: { reelId, indexAttemptId: { not: indexAttemptId } },
      });
      await transaction.reelChunk.deleteMany({
        where: { reelId, indexAttemptId: { not: indexAttemptId } },
      });
      await transaction.reelSection.deleteMany({
        where: { reelId, indexAttemptId: { not: indexAttemptId } },
      });
      await transaction.reelDocument.deleteMany({
        where: { reelId, indexAttemptId: { not: indexAttemptId } },
      });
      await transaction.transcriptionSegment.deleteMany({
        where: { reelId, indexAttemptId: { not: indexAttemptId } },
      });
      const completed = await transaction.indexingAttempt.updateMany({
        where: { reelId, indexAttemptId },
        data: { status: 'COMPLETED', lastError: null },
      });
      if (completed.count !== 1) {
        throw new Error(`Indexing attempt ${indexAttemptId} is missing`);
      }
    });
  }

  async discardCandidate(
    reelId: string,
    indexAttemptId: string,
  ): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.reelVisualScene.deleteMany({
        where: { reelId, indexAttemptId, isActive: false },
      }),
      this.prisma.reelChunk.deleteMany({
        where: { reelId, indexAttemptId, isActive: false },
      }),
      this.prisma.reelSection.deleteMany({
        where: { reelId, indexAttemptId, isActive: false },
      }),
      this.prisma.reelDocument.deleteMany({
        where: { reelId, indexAttemptId, isActive: false },
      }),
      this.prisma.transcriptionSegment.deleteMany({
        where: { reelId, indexAttemptId },
      }),
    ]);
  }

  async searchReels(
    input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.search('ReelDocument', input);
  }

  async searchSections(
    input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.search('ReelSection', input);
  }

  async searchChunks(
    input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.search('ReelChunk', input);
  }

  async searchVisualScenes(
    input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    return await this.search('ReelVisualScene', input);
  }

  async getAdjacentChunks(
    input: AdjacentChunkRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    const chunkId = input.chunkId?.trim();
    const reelId = input.reelId?.trim();
    const parentId = input.parentId?.trim();
    const eligibleReelIds = this.cleanStrings(input.eligibleReelIds);
    if (!chunkId || !reelId || !parentId || !eligibleReelIds.includes(reelId)) {
      return [];
    }

    const requiredIndexVersion = input.requiredIndexVersion?.trim();
    const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
      WITH target AS (
        SELECT "ordinal" FROM "ReelChunk"
        WHERE "id" = ${chunkId} AND "reelId" = ${reelId}
          AND "parentId" = ${parentId} AND "isActive" = true
          ${requiredIndexVersion ? Prisma.sql`AND "indexVersion" = ${requiredIndexVersion}` : Prisma.empty}
        LIMIT 1
      )
      SELECT c."id", c."indexVersion", c."reelId", c."parentId", c."ordinal", c."userId",
        c."retrievalText" AS "text", c."retrievalText" AS "retrievalText",
        c."evidenceText", 'TRANSCRIPT'::text AS "evidenceType", c."tags",
        c."startTime", c."endTime", c."sourceDurationMs", c."sourceOrientation",
        c."sourceLengthClass", 0::double precision AS "rrfScore",
        NULL::double precision AS "vectorDistance", NULL::bigint AS "vectorRank",
        NULL::bigint AS "keywordRank", NULL::bigint AS "metadataRank"
      FROM "ReelChunk" c, target
      WHERE c."reelId" = ${reelId}
        AND c."parentId" = ${parentId}
        AND c."isActive" = true
        AND c."ordinal" BETWEEN target."ordinal" - 1 AND target."ordinal" + 1
        ${requiredIndexVersion ? Prisma.sql`AND c."indexVersion" = ${requiredIndexVersion}` : Prisma.empty}
      ORDER BY c."ordinal"
      LIMIT ${this.boundedInt(input.limit, 3, 1, 3)}
    `);
    return rows.map((row) => this.toSearchResult(row));
  }

  async getReelDocument(reelId: string): Promise<SemanticReelDocument | null> {
    const rows = await this.prisma.$queryRaw<ReelDocumentRow[]>(Prisma.sql`
      SELECT "id", "reelId", "userId", "title", "description",
        "retrievalText" AS "text", "tags", "sourceDurationMs",
        "sourceOrientation", "sourceLengthClass", "indexAttemptId", "indexVersion",
        "embeddingProvider", "embeddingModel", "embeddingDimensions", "embeddingVersion",
        "chunkingVersion", "summaryVersion", "createdAt", "updatedAt"
      FROM "ReelDocument"
      WHERE "reelId" = ${reelId} AND "isActive" = true
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      title: row.title ?? undefined,
      description: row.description ?? undefined,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async deleteReel(reelId: string): Promise<boolean> {
    return await this.prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${reelId}))`;
      const deleted = await transaction.reelDocument.deleteMany({
        where: { reelId },
      });
      await transaction.reelVisualScene.deleteMany({ where: { reelId } });
      await transaction.reelSection.deleteMany({ where: { reelId } });
      await transaction.reelChunk.deleteMany({ where: { reelId } });
      await transaction.transcriptionSegment.deleteMany({ where: { reelId } });
      await transaction.embeddingCacheEntry.deleteMany({
        where: {
          OR: [
            { stableItemId: `reel:${reelId}` },
            { stableItemId: { startsWith: `reel:${reelId}:` } },
          ],
        },
      });
      await transaction.indexingAttempt.deleteMany({ where: { reelId } });
      return deleted.count > 0;
    });
  }

  private async search(
    target: SemanticTable,
    input: SemanticIndexSearchRequest,
  ): Promise<SemanticIndexSearchResult[]> {
    if (target === 'ReelChunk' && input.sourceOrder === 'ASC') {
      if (!this.cleanStrings(input.filters?.reelIds).length) return [];
      const where = this.filters(
        input.filters ?? {},
        [],
        input.requiredIndexVersion,
      );
      const limit = this.boundedInt(input.limit, 1, 1, 20);
      const rows = await this.prisma.$queryRaw<SearchRow[]>(Prisma.sql`
        SELECT t."id", t."indexVersion", t."reelId", t."parentId", t."ordinal", t."userId",
          t."retrievalText" AS "text", t."retrievalText", t."evidenceText", 'TRANSCRIPT'::text AS "evidenceType", t."tags",
          t."startTime", t."endTime", t."sourceDurationMs", t."sourceOrientation", t."sourceLengthClass",
          0::double precision AS "rrfScore", NULL::double precision AS "vectorDistance", NULL::bigint AS "vectorRank", NULL::bigint AS "keywordRank", NULL::bigint AS "metadataRank"
        FROM "ReelChunk" t WHERE t."isActive" = true ${where}
        ORDER BY t."startTime" ASC NULLS LAST, t."ordinal" ASC, t."id" ASC LIMIT ${limit}
      `);
      return rows.map((row) => this.toSearchResult(row));
    }
    const normalized = this.normalizeSearch(input);
    const table = Prisma.raw(`"${target}"`);
    const evidenceType: SemanticIndexEvidenceType =
      target === 'ReelVisualScene'
        ? 'VISUAL'
        : target === 'ReelDocument'
          ? 'METADATA'
          : 'TRANSCRIPT';
    const where = this.filters(
      normalized.filters,
      normalized.excludedIds,
      normalized.requiredIndexVersion,
    );
    const vector = normalized.queryEmbedding
      ? `[${normalized.queryEmbedding.join(',')}]`
      : null;
    const vectorColumn = Prisma.raw('t."embedding"');
    const embeddingIdentity = normalized.embeddingDimensions
      ? Prisma.sql`AND t."embeddingDimensions" = ${normalized.embeddingDimensions}
          AND t."embeddingModel" = ${normalized.queryEmbeddingModel}
          AND t."embeddingVersion" = ${normalized.queryEmbeddingVersion}`
      : Prisma.empty;
    const query = Prisma.sql`
      WITH vector_candidates AS (
        SELECT t."rowId",
          row_number() OVER (ORDER BY ${vectorColumn} <=> ${vector}::vector) AS rank,
          ${vectorColumn} <=> ${vector}::vector AS distance
        FROM ${table} t
        WHERE t."isActive" = true AND ${vector}::vector IS NOT NULL
          ${embeddingIdentity}
          ${where}
        ORDER BY ${vectorColumn} <=> ${vector}::vector
        LIMIT ${normalized.candidateLimit}
      ), keyword_candidates AS (
        SELECT t."rowId",
          row_number() OVER (
            ORDER BY ts_rank_cd(t."searchVector", websearch_to_tsquery('simple', ${normalized.queryText})) DESC,
              t."rowId"
          ) AS rank
        FROM ${table} t
        WHERE t."isActive" = true
          AND ${normalized.queryText} <> ''
          AND t."searchVector" @@ websearch_to_tsquery('simple', ${normalized.queryText})
          ${embeddingIdentity}
          ${where}
        ORDER BY ts_rank_cd(t."searchVector", websearch_to_tsquery('simple', ${normalized.queryText})) DESC,
          t."rowId"
        LIMIT ${normalized.candidateLimit}
      ), metadata_candidates AS (
        SELECT t."rowId",
          row_number() OVER (
            ORDER BY cardinality(ARRAY(
              SELECT unnest(t."tags") INTERSECT SELECT unnest(${normalized.queryTags}::text[])
            )) DESC, t."rowId"
          ) AS rank
        FROM ${table} t
        WHERE t."isActive" = true
          AND cardinality(${normalized.queryTags}::text[]) > 0
          AND t."tags" && ${normalized.queryTags}::text[]
          ${embeddingIdentity}
          ${where}
        ORDER BY cardinality(ARRAY(
          SELECT unnest(t."tags") INTERSECT SELECT unnest(${normalized.queryTags}::text[])
        )) DESC, t."rowId"
        LIMIT ${normalized.candidateLimit}
      ), candidates AS (
        SELECT "rowId" FROM vector_candidates
        UNION SELECT "rowId" FROM keyword_candidates
        UNION SELECT "rowId" FROM metadata_candidates
      )
      SELECT t."id", t."indexVersion", t."reelId", t."parentId", t."ordinal", t."userId",
        t."retrievalText" AS "text", t."retrievalText" AS "retrievalText",
        t."evidenceText", ${evidenceType}::text AS "evidenceType", t."tags",
        t."startTime", t."endTime", t."sourceDurationMs", t."sourceOrientation",
        t."sourceLengthClass", v.distance AS "vectorDistance", v.rank AS "vectorRank",
        k.rank AS "keywordRank", m.rank AS "metadataRank",
        (coalesce(1.0 / (60 + v.rank), 0) +
         coalesce(1.0 / (60 + k.rank), 0) +
         coalesce(1.0 / (60 + m.rank), 0))::double precision AS "rrfScore"
      FROM candidates c
      JOIN ${table} t ON t."rowId" = c."rowId"
      LEFT JOIN vector_candidates v ON v."rowId" = c."rowId"
      LEFT JOIN keyword_candidates k ON k."rowId" = c."rowId"
      LEFT JOIN metadata_candidates m ON m."rowId" = c."rowId"
      ORDER BY "rrfScore" DESC, t."id"
      LIMIT ${normalized.limit}
    `;

    const rows = await this.prisma.$transaction(async (transaction) => {
      await this.configureHnsw(transaction);
      return await transaction.$queryRaw<SearchRow[]>(query);
    });
    return rows.map((row) => this.toSearchResult(row));
  }

  private normalizeSearch(input: SemanticIndexSearchRequest): {
    queryText: string;
    queryEmbedding?: number[];
    queryEmbeddingModel?: string;
    queryEmbeddingVersion?: string;
    embeddingDimensions?: number;
    queryTags: string[];
    filters: SemanticIndexSearchFilters;
    excludedIds: string[];
    requiredIndexVersion?: string;
    limit: number;
    candidateLimit: number;
  } {
    const queryText = input.queryText?.trim() ?? '';
    const queryTags = this.cleanStrings(input.queryTags);
    if (input.queryEmbedding) {
      const expected = this.configuredEmbeddingIdentity();
      const queryEmbeddingModel = input.queryEmbeddingModel?.trim();
      const queryEmbeddingVersion = input.queryEmbeddingVersion?.trim();
      if (
        input.queryEmbedding.length !== SEMANTIC_INDEX_EMBEDDING_DIMENSIONS ||
        input.queryEmbedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(
          'queryEmbedding has an unsupported dimension or non-finite value',
        );
      }
      if (
        queryEmbeddingModel !== expected.model ||
        queryEmbeddingVersion !== expected.version
      ) {
        throw new Error(
          'queryEmbedding model/version does not match the configured semantic index',
        );
      }
    }
    if (!queryText && !input.queryEmbedding && queryTags.length === 0) {
      throw new Error('Semantic search requires text, an embedding, or tags');
    }
    const limit = this.boundedInt(input.limit, 20, 1, 100);
    return {
      queryText,
      queryEmbedding: input.queryEmbedding,
      queryEmbeddingModel: input.queryEmbeddingModel?.trim() || undefined,
      queryEmbeddingVersion: input.queryEmbeddingVersion?.trim() || undefined,
      embeddingDimensions: input.queryEmbedding?.length,
      queryTags,
      filters: input.filters ?? {},
      excludedIds: this.cleanStrings(input.excludedIds),
      requiredIndexVersion: input.requiredIndexVersion?.trim() || undefined,
      limit,
      candidateLimit: Math.max(
        limit,
        this.boundedInt(input.candidateLimit, 100, 1, 1_000),
      ),
    };
  }

  private filters(
    filters: SemanticIndexSearchFilters,
    excludedIds: string[] = [],
    requiredIndexVersion?: string,
  ): Prisma.Sql {
    const reelIds = this.cleanStrings(filters.reelIds);
    const userIds = this.cleanStrings(filters.userIds);
    const parentIds = this.cleanStrings(filters.parentIds);
    const tags = this.cleanStrings(filters.tags);
    const lengthClasses = (filters.sourceLengthClasses ?? []).filter(
      (value) => value === 'SHORT' || value === 'LONG',
    );
    return Prisma.sql`
      ${reelIds.length ? Prisma.sql`AND t."reelId" IN (${Prisma.join(reelIds)})` : Prisma.empty}
      ${userIds.length ? Prisma.sql`AND t."userId" IN (${Prisma.join(userIds)})` : Prisma.empty}
      ${parentIds.length ? Prisma.sql`AND t."parentId" IN (${Prisma.join(parentIds)})` : Prisma.empty}
      ${tags.length ? Prisma.sql`AND t."tags" && ${tags}::text[]` : Prisma.empty}
      ${lengthClasses.length ? Prisma.sql`AND t."sourceLengthClass" IN (${Prisma.join(lengthClasses)})` : Prisma.empty}
      ${excludedIds.length ? Prisma.sql`AND t."id" NOT IN (${Prisma.join(excludedIds)})` : Prisma.empty}
      ${requiredIndexVersion ? Prisma.sql`AND t."indexVersion" = ${requiredIndexVersion}` : Prisma.empty}
    `;
  }

  private async configureHnsw(transaction: Prisma.TransactionClient) {
    const efSearch = this.boundedInt(
      Number(this.config.get<string>('INDEX_HNSW_EF_SEARCH')),
      100,
      1,
      1_000,
    );
    const maxScanTuples = this.boundedInt(
      Number(this.config.get<string>('INDEX_HNSW_MAX_SCAN_TUPLES')),
      20_000,
      1,
      1_000_000,
    );
    const scanMemMultiplier = this.positiveNumber(
      this.config.get<string>('INDEX_HNSW_SCAN_MEM_MULTIPLIER'),
      1,
    );
    const configuredScan =
      this.config
        .get<string>('INDEX_HNSW_ITERATIVE_SCAN')
        ?.trim()
        .toLowerCase() ?? 'strict_order';
    const iterativeScan = ['off', 'strict_order', 'relaxed_order'].includes(
      configuredScan,
    )
      ? configuredScan
      : 'strict_order';
    await transaction.$executeRawUnsafe(
      `SET LOCAL hnsw.ef_search = ${efSearch}`,
    );
    await transaction.$executeRawUnsafe(
      `SET LOCAL hnsw.iterative_scan = '${iterativeScan}'`,
    );
    await transaction.$executeRawUnsafe(
      `SET LOCAL hnsw.max_scan_tuples = ${maxScanTuples}`,
    );
    await transaction.$executeRawUnsafe(
      `SET LOCAL hnsw.scan_mem_multiplier = ${scanMemMultiplier}`,
    );
  }

  private insertDocuments(
    table: SemanticTable,
    documents: SemanticIndexCandidate['documents'],
    input: SemanticIndexCandidate,
  ): Prisma.Sql {
    const title = input.metadata.title ?? input.job.title ?? null;
    const description =
      input.metadata.description ?? input.job.description ?? null;
    const tags = this.cleanStrings(input.metadata.tags);
    const rows = documents.map((document) => {
      const vector = `[${document.embedding.join(',')}]`;
      return Prisma.sql`(
      ${randomUUID()}, ${document.id}, ${document.reelId}, ${input.job.indexAttemptId}, false, false,
      ${input.job.userId}, ${document.parentId ?? null}, ${document.ordinal}, ${title}, ${description},
      ${document.evidenceText ?? null}, ${document.retrievalText}, ${document.derivedSummary ?? null},
      ${document.sourceSectionIds}::text[], ${document.sourceSegmentIds}::text[],
      ${document.sourceAudioArtifactIds}::text[], ${document.evidenceHash ?? null},
      ${document.retrievalHash}, ${document.evidenceQuality}::"EvidenceQuality",
      ${document.transcriptVersion ?? null}, ${document.sectioningVersion}, ${document.tokenCount},
      ${tags}::text[], ${document.startTime ?? null}, ${document.endTime ?? null},
      ${input.job.sourceDurationMs}, ${input.job.sourceOrientation}, ${input.job.sourceLengthClass},
      ${vector}::vector, ${document.embeddingProvider},
      ${document.embeddingModel}, ${document.embeddingDimensions}, ${document.embeddingVersion},
      ${document.embeddingInputHash}, ${document.indexVersion}, ${document.chunkingVersion},
      ${document.summaryVersion}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`;
    });
    return Prisma.sql`
      INSERT INTO ${Prisma.raw(`"${table}"`)} (
        "rowId", "id", "reelId", "indexAttemptId", "isActive", "isLegacyImport", "userId", "parentId", "ordinal",
        "title", "description", "evidenceText", "retrievalText", "derivedSummary",
        "sourceSectionIds", "sourceSegmentIds", "sourceAudioArtifactIds", "evidenceHash",
        "retrievalHash", "evidenceQuality", "transcriptVersion", "sectioningVersion",
        "tokenCount", "tags", "startTime", "endTime", "sourceDurationMs",
        "sourceOrientation", "sourceLengthClass", "embedding", "embeddingProvider",
        "embeddingModel", "embeddingDimensions", "embeddingVersion", "embeddingInputHash",
        "indexVersion", "chunkingVersion", "summaryVersion", "createdAt", "updatedAt"
      ) VALUES ${Prisma.join(rows)}
    `;
  }

  private validateDocument(
    document: SemanticIndexCandidate['documents'][number],
  ): void {
    const expected = this.configuredEmbeddingIdentity();
    if (
      document.embeddingProvider !== expected.provider ||
      document.embeddingModel !== expected.model ||
      document.embeddingDimensions !== expected.dimensions ||
      document.embeddingVersion !== expected.version ||
      document.embedding.length !== document.embeddingDimensions ||
      document.embedding.some((value) => !Number.isFinite(value))
    ) {
      throw new Error(
        `Document ${document.id} has an incompatible embedding identity or dimension`,
      );
    }
    if (
      !document.retrievalText.trim() ||
      !document.retrievalHash.trim() ||
      document.tokenCount < 1
    ) {
      throw new Error(`Document ${document.id} has invalid retrieval evidence`);
    }
  }

  private configuredEmbeddingIdentity(): {
    provider: string;
    model: string;
    dimensions: number;
    version: string;
  } {
    const provider =
      this.config.get<string>('INDEX_EMBEDDING_PROVIDER')?.trim() ||
      'self-hosted-tei';
    const model = this.config.get<string>('AI_EMBEDDING_MODEL')?.trim();
    const dimensions = Number(
      this.config.get<string>('AI_EMBEDDING_DIMENSIONS'),
    );
    const version = this.config.get<string>('AI_EMBEDDING_VERSION')?.trim();
    if (
      !model ||
      dimensions !== SEMANTIC_INDEX_EMBEDDING_DIMENSIONS ||
      !version
    ) {
      throw new Error('Invalid reel semantic embedding configuration');
    }
    return { provider, model, dimensions, version };
  }

  private toSearchResult(row: SearchRow): SemanticIndexSearchResult {
    return {
      ...row,
      parentId: row.parentId ?? undefined,
      evidenceText: row.evidenceText ?? undefined,
      startTime: row.startTime ?? undefined,
      endTime: row.endTime ?? undefined,
      vectorDistance: row.vectorDistance ?? undefined,
      vectorRank: row.vectorRank === null ? undefined : Number(row.vectorRank),
      keywordRank:
        row.keywordRank === null ? undefined : Number(row.keywordRank),
      metadataRank:
        row.metadataRank === null ? undefined : Number(row.metadataRank),
    };
  }

  private cleanStrings(values?: string[]): string[] {
    return Array.from(
      new Set((values ?? []).map((value) => value.trim()).filter(Boolean)),
    );
  }

  private boundedInt(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    return Number.isInteger(value) && value! >= minimum && value! <= maximum
      ? value!
      : fallback;
  }

  private positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number(value ?? fallback);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
