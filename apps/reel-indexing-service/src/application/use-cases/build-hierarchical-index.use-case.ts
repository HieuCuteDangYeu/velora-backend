import type { ExtractedReelMetadata } from '@common/ai/interfaces/reel-metadata-extraction.interface';
import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { IndexChunkCheckpoint } from '@common/processing/interfaces/index-chunk-checkpoint.interface';
import type {
  CachedEmbedding,
  EmbeddingCacheIdentity,
  ReelEvidenceDocument,
  ReelEvidenceDocumentDraft,
  ReelEvidenceQuality,
} from '@common/processing/interfaces/reel-index-document.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { VisualSceneEvidence } from '@common/processing/interfaces/visual-scene-evidence.interface';
import { BuildLongEvidenceChunksUseCase } from '@indexing/application/use-cases/build-long-evidence-chunks.use-case';
import { BuildShortEvidenceChunksUseCase } from '@indexing/application/use-cases/build-short-evidence-chunks.use-case';
import type { EvidenceChunk } from '@indexing/domain/entities/evidence-chunk.entity';
import type { TranscriptSection } from '@indexing/domain/entities/index-checkpoint.entity';
import type { IIndexingAiService } from '@indexing/domain/interfaces/ai-service.interface';
import type { IIndexCheckpointRepository } from '@indexing/domain/interfaces/index-checkpoint.repository.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

type DraftInput = Omit<
  ReelEvidenceDocumentDraft,
  keyof EmbeddingCacheIdentity | 'retrievalHash' | 'sectioningVersion'
>;

@Injectable()
export class BuildHierarchicalIndexUseCase {
  constructor(
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
    private readonly shortChunks: BuildShortEvidenceChunksUseCase,
    private readonly longChunks: BuildLongEvidenceChunksUseCase,
    @Inject('IIndexingAiService') private readonly ai: IIndexingAiService,
    @Inject('IIndexCheckpointRepository')
    private readonly checkpoints: IIndexCheckpointRepository,
  ) {}

  async execute(input: {
    job: ReelIndexJob;
    metadata: ExtractedReelMetadata;
    sections: TranscriptSection[];
    transcript?: string;
    transcriptSegments?: TranscriptSegment[];
    visualScenes?: VisualSceneEvidence[];
  }): Promise<{
    documents: ReelEvidenceDocument[];
    chunks: IndexChunkCheckpoint[];
  }> {
    const drafts = await this.validateDocumentTokens(
      this.buildDocumentDrafts(input),
    );
    await this.generateMissingEmbeddings(drafts);
    const documents = await this.materializeDocuments(drafts);
    return { documents, chunks: this.toIndexChunks(documents) };
  }

  buildDocumentDrafts(input: {
    job: ReelIndexJob;
    metadata: ExtractedReelMetadata;
    sections: TranscriptSection[];
    transcript?: string;
    transcriptSegments?: TranscriptSegment[];
    visualScenes?: VisualSceneEvidence[];
  }): ReelEvidenceDocumentDraft[] {
    const hasTimedSegments = Boolean(input.transcriptSegments?.length);
    const normalizedTranscript = this.normalizeEvidence(input.transcript ?? '');
    const segments = input.transcriptSegments?.length
      ? input.transcriptSegments
      : normalizedTranscript
        ? [
            {
              start: 0,
              end:
                (input.job.outputDurationMs ?? input.job.sourceDurationMs) /
                1000,
              text: normalizedTranscript,
              sourceSegmentId: `transcript:${this.hash(normalizedTranscript)}`,
            },
          ]
        : [];
    const reelDocumentId = `reel:${input.job.reelId}`;
    const sectionIds = input.sections.map(
      (section) => `${reelDocumentId}:section:${section.index}`,
    );
    const evidenceQuality: ReelEvidenceQuality = hasTimedSegments
      ? 'VERIFIED'
      : segments.length
        ? 'LOW_CONFIDENCE'
        : 'METADATA_ONLY';
    const drafts: DraftInput[] = [
      {
        id: reelDocumentId,
        reelId: input.job.reelId,
        kind: 'REEL',
        ordinal: 0,
        retrievalText: this.reelRetrievalText(input.metadata),
        derivedSummary: input.metadata.description,
        sourceSectionIds: sectionIds,
        sourceSegmentIds: this.sourceSegmentIds(segments),
        sourceAudioArtifactIds: this.sourceAudioArtifactIds(segments),
        evidenceQuality,
        transcriptVersion: segments.length
          ? this.transcriptVersion()
          : undefined,
        tokenCount: 0,
      },
    ];

    if (input.job.sourceLengthClass === 'LONG') {
      for (const section of input.sections) {
        const id = `${reelDocumentId}:section:${section.index}`;
        const sectionSegments = this.segmentsInside(
          segments,
          section.startMs,
          section.endMs,
        );
        const evidenceText = this.normalizeEvidence(section.text);
        drafts.push({
          id,
          reelId: input.job.reelId,
          kind: 'SECTION',
          ordinal: section.index,
          parentId: reelDocumentId,
          evidenceText,
          retrievalText: this.retrievalText({
            kind: 'Section',
            metadata: input.metadata,
            ordinal: section.index,
            startTime: section.startMs / 1000,
            endTime: section.endMs / 1000,
            evidenceText,
          }),
          derivedSummary: section.summary,
          sourceSectionIds: [id],
          startTime: section.startMs / 1000,
          endTime: section.endMs / 1000,
          sourceSegmentIds: this.sourceSegmentIds(sectionSegments),
          sourceAudioArtifactIds: this.sourceAudioArtifactIds(sectionSegments),
          evidenceHash: this.hash(evidenceText),
          evidenceQuality,
          transcriptVersion: this.transcriptVersion(),
          tokenCount: 0,
        });
      }
    }

    if (segments.length) {
      const chunks: Array<EvidenceChunk & { sectionIndex?: number }> =
        input.job.sourceLengthClass === 'LONG'
          ? this.longChunks.execute(input.sections, segments)
          : this.shortChunks
              .execute(segments)
              .map((chunk) => ({ ...chunk, sectionIndex: undefined }));
      chunks.forEach((chunk, ordinal) => {
        const sectionId =
          chunk.sectionIndex === undefined
            ? undefined
            : `${reelDocumentId}:section:${chunk.sectionIndex}`;
        const evidenceText = this.normalizeEvidence(chunk.evidenceText);
        drafts.push({
          id: `${reelDocumentId}:chunk:${ordinal}`,
          reelId: input.job.reelId,
          kind: 'CHUNK',
          ordinal,
          parentId: sectionId ?? reelDocumentId,
          evidenceText,
          retrievalText: this.retrievalText({
            kind: 'Chunk',
            metadata: input.metadata,
            ordinal,
            startTime: chunk.startTime,
            endTime: chunk.endTime,
            evidenceText,
          }),
          sourceSectionIds: sectionId ? [sectionId] : [],
          startTime: chunk.startTime,
          endTime: chunk.endTime,
          sourceSegmentIds: chunk.sourceSegmentIds,
          sourceAudioArtifactIds: chunk.sourceAudioArtifactIds,
          evidenceHash: this.hash(evidenceText),
          evidenceQuality,
          transcriptVersion: this.transcriptVersion(),
          tokenCount: 0,
        });
      });
    } else {
      const retrievalText = this.reelRetrievalText(input.metadata);
      if (retrievalText) {
        drafts.push({
          id: `${reelDocumentId}:chunk:0`,
          reelId: input.job.reelId,
          kind: 'CHUNK',
          ordinal: 0,
          parentId: reelDocumentId,
          retrievalText,
          sourceSectionIds: [],
          sourceSegmentIds: [],
          sourceAudioArtifactIds: [],
          evidenceQuality: 'METADATA_ONLY',
          tokenCount: 0,
        });
      }
    }

    for (const [ordinal, scene] of (input.visualScenes ?? []).entries()) {
      const evidenceText = this.visualEvidenceText(scene);
      if (!evidenceText) continue;
      const timestamp = Math.max(0, scene.timestampMs / 1000);
      drafts.push({
        id: `${reelDocumentId}:visual:${ordinal}`,
        reelId: input.job.reelId,
        kind: 'VISUAL_SCENE',
        ordinal,
        parentId: reelDocumentId,
        evidenceText,
        retrievalText: this.visualRetrievalText({
          metadata: input.metadata,
          ordinal,
          timestamp,
          evidenceText,
        }),
        derivedSummary: this.normalizeEvidence(scene.caption),
        sourceSectionIds: [],
        startTime: timestamp,
        endTime: timestamp,
        sourceSegmentIds: [],
        sourceAudioArtifactIds: [],
        evidenceHash: this.hash(
          `${scene.frameChecksum}:${scene.provider}:${scene.model}:${scene.version}:${evidenceText}`,
        ),
        evidenceQuality: 'VERIFIED',
        tokenCount: 0,
      });
    }

    return drafts.map((draft) => this.versionedDraft(draft, input.job));
  }

  async validateDocumentTokens(
    drafts: ReelEvidenceDocumentDraft[],
  ): Promise<ReelEvidenceDocumentDraft[]> {
    let current = drafts;
    const maximum = this.positiveInt(
      'INDEX_DOCUMENT_MAX_TOKENS',
      this.positiveInt('INDEX_SHORT_CHUNK_MAX_TOKENS', 340, 20, 4_000),
      20,
      4_000,
    );
    const model = current[0]?.embeddingModel;
    if (!model || !current.length) return current;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const counts = new Map<string, number>();
      for (let offset = 0; offset < current.length; offset += 100) {
        const batch = current.slice(offset, offset + 100);
        const result = await this.ai.countDocumentTokens({
          model,
          items: batch.map((draft) => ({
            id: draft.id,
            text: draft.retrievalText,
          })),
        });
        const expected = new Set(batch.map((draft) => draft.id));
        if (
          result.items.length !== batch.length ||
          result.items.some(
            (item) =>
              !expected.has(item.id) ||
              !Number.isInteger(item.tokenCount) ||
              item.tokenCount < 1,
          )
        ) {
          throw new Error('Token counter returned incomplete document results');
        }
        result.items.forEach((item) => counts.set(item.id, item.tokenCount));
      }

      const oversized = current.filter(
        (draft) => (counts.get(draft.id) ?? maximum + 1) > maximum,
      );
      current = current.map((draft) => ({
        ...draft,
        tokenCount: counts.get(draft.id),
      }));
      if (!oversized.length) return current;
      if (attempt === 2) {
        throw new Error(
          `Unable to fit ${oversized.length} documents within the model token limit`,
        );
      }
      current = current.map((draft) => {
        const count = counts.get(draft.id)!;
        if (count <= maximum) return draft;
        const words = draft.retrievalText.split(/\s+/);
        const keep = Math.max(
          1,
          Math.floor(words.length * (maximum / count) * 0.9),
        );
        return this.reversionDraft(
          { ...draft, retrievalText: words.slice(0, keep).join(' ') },
          draft,
        );
      });
    }
    return current;
  }

  async generateMissingEmbeddings(
    drafts: ReelEvidenceDocumentDraft[],
  ): Promise<void> {
    const cached = (
      await this.checkpoints.findReusableEmbeddings(drafts)
    ).filter((entry) => this.isValidCachedEmbedding(entry));
    const existing = new Set(cached.map((entry) => entry.cacheKey));
    const missing = drafts.filter((draft) => !existing.has(draft.cacheKey));
    const batchSize = this.positiveInt(
      'INDEX_EMBEDDING_BATCH_SIZE',
      32,
      2,
      100,
    );

    for (let offset = 0; offset < missing.length; offset += batchSize) {
      const batch = missing.slice(offset, offset + batchSize);
      const result = await this.ai.generateEmbeddingBatch({
        items: batch.map((draft) => ({
          id: draft.id,
          text: draft.retrievalText,
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      });
      const byId = new Map(batch.map((draft) => [draft.id, draft]));
      const completed: CachedEmbedding[] = [];
      const invalidIds: string[] = [];
      for (const embedding of result.embeddings) {
        const draft = byId.get(embedding.id);
        if (!draft) {
          throw new Error(`Unexpected batch embedding item ${embedding.id}`);
        }
        const provider = embedding.provider || draft.embeddingProvider;
        const model = embedding.model.replace(/^models\//, '');
        const version = embedding.version || draft.embeddingVersion;
        if (
          embedding.values.length !== draft.embeddingDimensions ||
          embedding.dimensions !== embedding.values.length ||
          embedding.values.some((value) => !Number.isFinite(value)) ||
          provider !== draft.embeddingProvider ||
          model !== draft.embeddingModel ||
          version !== draft.embeddingVersion
        ) {
          invalidIds.push(embedding.id);
          continue;
        }
        completed.push({
          ...this.identity(draft),
          embedding: embedding.values,
        });
      }
      const returnedIds = new Set(result.embeddings.map((entry) => entry.id));
      const missingIds = batch
        .filter((draft) => !returnedIds.has(draft.id))
        .map((draft) => draft.id);
      if (result.errors.length || missingIds.length || invalidIds.length) {
        throw new Error(
          `Batch embedding failed for ${
            new Set([
              ...result.errors.map((error) => error.id),
              ...missingIds,
              ...invalidIds,
            ]).size
          } items`,
        );
      }
      await this.checkpoints.saveEmbeddings(completed);
    }
  }

  async materializeDocuments(
    drafts: ReelEvidenceDocumentDraft[],
  ): Promise<ReelEvidenceDocument[]> {
    const cached = await this.checkpoints.findReusableEmbeddings(drafts);
    const byKey = new Map(cached.map((entry) => [entry.cacheKey, entry]));
    return drafts.map((draft) => {
      const embedding = byKey.get(draft.cacheKey);
      if (!embedding || !this.isValidCachedEmbedding(embedding)) {
        throw new Error(`Missing valid embedding for document ${draft.id}`);
      }
      return {
        ...draft,
        tokenCount: draft.tokenCount ?? 0,
        embedding: embedding.embedding,
      };
    });
  }

  toIndexChunks(documents: ReelEvidenceDocument[]): IndexChunkCheckpoint[] {
    return documents
      .filter((document) => document.kind === 'CHUNK')
      .map((document) => ({
        chunkIndex: document.ordinal,
        text: document.evidenceText ?? document.retrievalText,
        startTime: document.startTime,
        endTime: document.endTime,
        embedding: document.embedding,
        embeddingModel: [
          document.embeddingProvider,
          document.embeddingModel,
          document.embeddingDimensions,
          document.embeddingVersion,
        ].join(':'),
      }));
  }

  private versionedDraft(
    draft: DraftInput,
    job: ReelIndexJob,
  ): ReelEvidenceDocumentDraft {
    const embeddingIdentity = this.config.embeddingIdentity();
    const base = {
      ...draft,
      retrievalHash: this.hash(draft.retrievalText),
      sectioningVersion:
        this.config.get<string>('INDEX_SECTIONING_VERSION') ||
        'reel-section-v2',
      stableItemId: draft.id,
      documentKind: draft.kind,
      embeddingProvider:
        this.config.get<string>('INDEX_EMBEDDING_PROVIDER') ||
        'self-hosted-tei',
      embeddingModel: embeddingIdentity.model.replace(/^models\//, ''),
      embeddingDimensions: embeddingIdentity.dimensions,
      embeddingVersion: embeddingIdentity.version,
      indexVersion: job.indexVersion,
      chunkingVersion:
        this.config.get<string>('INDEX_CHUNKING_VERSION') || 'reel-chunk-v3',
      summaryVersion:
        this.config.get<string>('INDEX_SUMMARY_VERSION') || 'reel-summary-v1',
    };
    return this.reversionDraft(base, base);
  }

  private reversionDraft(
    draft: Omit<ReelEvidenceDocumentDraft, 'cacheKey' | 'embeddingInputHash'> &
      Partial<
        Pick<ReelEvidenceDocumentDraft, 'cacheKey' | 'embeddingInputHash'>
      >,
    identity: Pick<
      ReelEvidenceDocumentDraft,
      | 'stableItemId'
      | 'documentKind'
      | 'embeddingProvider'
      | 'embeddingModel'
      | 'embeddingDimensions'
      | 'embeddingVersion'
      | 'indexVersion'
      | 'chunkingVersion'
      | 'summaryVersion'
    >,
  ): ReelEvidenceDocumentDraft {
    const embeddingInputHash = this.hash(draft.retrievalText);
    const identityWithoutKey = {
      stableItemId: identity.stableItemId,
      documentKind: identity.documentKind,
      embeddingInputHash,
      embeddingProvider: identity.embeddingProvider,
      embeddingModel: identity.embeddingModel,
      embeddingDimensions: identity.embeddingDimensions,
      embeddingVersion: identity.embeddingVersion,
      indexVersion: identity.indexVersion,
      chunkingVersion: identity.chunkingVersion,
      summaryVersion: identity.summaryVersion,
    };
    return {
      ...draft,
      retrievalHash: this.hash(draft.retrievalText),
      ...identityWithoutKey,
      cacheKey: this.hash(JSON.stringify(identityWithoutKey)),
    };
  }

  private reelRetrievalText(metadata: ExtractedReelMetadata): string {
    return [
      metadata.title?.trim(),
      metadata.description?.trim(),
      metadata.tags.length ? metadata.tags.join(' ') : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .trim();
  }

  private retrievalText(input: {
    kind: 'Section' | 'Chunk';
    metadata: ExtractedReelMetadata;
    ordinal: number;
    startTime: number;
    endTime: number;
    evidenceText: string;
  }): string {
    return [
      input.metadata.title,
      input.metadata.tags.length ? input.metadata.tags.join(' ') : undefined,
      input.evidenceText,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
  }

  private visualEvidenceText(scene: VisualSceneEvidence): string {
    return [
      scene.caption.trim() ? this.normalizeEvidence(scene.caption) : undefined,
      scene.ocrText?.trim() ? this.normalizeEvidence(scene.ocrText) : undefined,
      scene.objects.length
        ? scene.objects
            .map((value) => this.normalizeEvidence(value))
            .filter(Boolean)
            .join(' ')
        : undefined,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n')
      .trim();
  }

  private visualRetrievalText(input: {
    metadata: ExtractedReelMetadata;
    ordinal: number;
    timestamp: number;
    evidenceText: string;
  }): string {
    return [
      input.metadata.title,
      input.metadata.tags.length ? input.metadata.tags.join(' ') : undefined,
      input.evidenceText,
    ]
      .filter((value): value is string => Boolean(value))
      .join('\n');
  }

  private segmentsInside(
    segments: TranscriptSegment[],
    startMs: number,
    endMs: number,
  ): TranscriptSegment[] {
    return segments.filter(
      (segment) =>
        segment.start * 1000 >= startMs && segment.start * 1000 < endMs,
    );
  }

  private sourceSegmentIds(segments: TranscriptSegment[]): string[] {
    return [
      ...new Set(
        segments.map((segment, ordinal) =>
          typeof segment['sourceSegmentId'] === 'string'
            ? segment['sourceSegmentId']
            : `transcription:0:${segment.id ?? ordinal}`,
        ),
      ),
    ];
  }

  private sourceAudioArtifactIds(segments: TranscriptSegment[]): string[] {
    return [
      ...new Set(
        segments
          .map((segment) => segment['sourceAudioArtifactId'])
          .filter((value): value is string => typeof value === 'string'),
      ),
    ];
  }

  private normalizeEvidence(text: string): string {
    return text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  private transcriptVersion(): string {
    return (
      this.config.get<string>('INDEX_TRANSCRIPT_VERSION') ||
      'normalized-transcript-v1'
    );
  }

  private hash(value: string): string {
    return createHash('sha256').update(value.normalize('NFKC')).digest('hex');
  }

  private identity(draft: ReelEvidenceDocumentDraft): EmbeddingCacheIdentity {
    return {
      cacheKey: draft.cacheKey,
      stableItemId: draft.stableItemId,
      documentKind: draft.documentKind,
      embeddingInputHash: draft.embeddingInputHash,
      embeddingProvider: draft.embeddingProvider,
      embeddingModel: draft.embeddingModel,
      embeddingDimensions: draft.embeddingDimensions,
      embeddingVersion: draft.embeddingVersion,
      indexVersion: draft.indexVersion,
      chunkingVersion: draft.chunkingVersion,
      summaryVersion: draft.summaryVersion,
    };
  }

  private isValidCachedEmbedding(entry: CachedEmbedding): boolean {
    return (
      entry.embedding.length === entry.embeddingDimensions &&
      entry.embedding.length > 0 &&
      entry.embedding.every((value) => Number.isFinite(value))
    );
  }

  private positiveInt(
    key: string,
    fallback: number,
    minimum: number,
    maximum: number,
  ): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isInteger(value)
      ? Math.min(maximum, Math.max(minimum, value))
      : fallback;
  }
}
