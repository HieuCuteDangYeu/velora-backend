import type { TranscriptSegment } from '@common/ai/interfaces/transcription-result.interface';
import type { ReelEvidenceDocument } from '@common/processing/interfaces/reel-index-document.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';

@Injectable()
export class ValidateEvidenceIndexCandidateUseCase {
  constructor(
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
  ) {}

  execute(input: {
    job: ReelIndexJob;
    documents: ReelEvidenceDocument[];
    transcriptSegments?: TranscriptSegment[];
  }): void {
    const { documents, job } = input;
    const reels = documents.filter((document) => document.kind === 'REEL');
    const sections = documents.filter(
      (document) => document.kind === 'SECTION',
    );
    const chunks = documents.filter((document) => document.kind === 'CHUNK');
    const visualScenes = documents.filter(
      (document) => document.kind === 'VISUAL_SCENE',
    );
    if (reels.length !== 1) {
      throw new Error('Index candidate must contain exactly one Reel document');
    }
    if (job.sourceLengthClass === 'LONG' && input.transcriptSegments?.length) {
      if (!sections.length) {
        throw new Error('Long transcript index must contain Section documents');
      }
    }
    if (!chunks.length) {
      throw new Error(
        'Index candidate must contain at least one Chunk document',
      );
    }

    const ids = new Set(documents.map((document) => document.id));
    const ordinals = new Set<string>();
    const maximumTokens = this.positiveInt(
      'INDEX_DOCUMENT_MAX_TOKENS',
      this.positiveInt('INDEX_SHORT_CHUNK_MAX_TOKENS', 340, 20, 4_000),
      20,
      4_000,
    );
    const expectedEmbedding = this.config.embeddingIdentity();
    const expectedProvider =
      this.config.get<string>('INDEX_EMBEDDING_PROVIDER') || 'self-hosted-tei';
    const sourceEvidence = this.normalize(
      (input.transcriptSegments ?? []).map((segment) => segment.text).join(' '),
    );

    for (const document of documents) {
      const ordinalKey = `${document.parentId ?? 'root'}:${document.kind}:${document.ordinal}`;
      if (ordinals.has(ordinalKey)) {
        throw new Error(`Duplicate document ordinal ${ordinalKey}`);
      }
      ordinals.add(ordinalKey);
      if (document.parentId && !ids.has(document.parentId)) {
        throw new Error(`Document ${document.id} has an orphan parent`);
      }
      if (
        document.startTime !== undefined &&
        document.endTime !== undefined &&
        (document.startTime < 0 ||
          document.endTime < document.startTime ||
          document.endTime * 1000 >
            (job.outputDurationMs ?? job.sourceDurationMs) + 1_000)
      ) {
        throw new Error(`Document ${document.id} has invalid timestamps`);
      }
      if (document.tokenCount < 1 || document.tokenCount > maximumTokens) {
        throw new Error(
          `Document ${document.id} violates its model token limit`,
        );
      }
      if (
        document.embeddingProvider !== expectedProvider ||
        document.embeddingModel !== expectedEmbedding.model ||
        document.embeddingDimensions !== expectedEmbedding.dimensions ||
        document.embeddingVersion !== expectedEmbedding.version ||
        document.embedding.length !== expectedEmbedding.dimensions ||
        document.embedding.some((value) => !Number.isFinite(value))
      ) {
        throw new Error(`Document ${document.id} has an invalid embedding`);
      }
      if (
        !document.embeddingProvider.trim() ||
        !document.embeddingModel.trim() ||
        !document.embeddingVersion.trim() ||
        !document.indexVersion.trim()
      ) {
        throw new Error(
          `Document ${document.id} has incomplete model versions`,
        );
      }
      if (document.retrievalHash !== this.hash(document.retrievalText)) {
        throw new Error(
          `Document ${document.id} has an invalid retrieval hash`,
        );
      }
      if (document.evidenceText) {
        const normalizedEvidence = this.normalize(document.evidenceText);
        if (
          document.kind === 'VISUAL_SCENE' &&
          !document.evidenceHash?.trim()
        ) {
          throw new Error(
            `Visual scene ${document.id} has no provenance evidence hash`,
          );
        }
        if (
          document.kind !== 'VISUAL_SCENE' &&
          document.evidenceHash !== this.hash(document.evidenceText)
        ) {
          throw new Error(
            `Document ${document.id} has an invalid evidence hash`,
          );
        }
        if (
          document.kind !== 'VISUAL_SCENE' &&
          sourceEvidence &&
          !sourceEvidence.includes(normalizedEvidence)
        ) {
          throw new Error(
            `Document ${document.id} contains evidence outside the transcript`,
          );
        }
      }
      if (
        document.kind === 'CHUNK' &&
        document.parentId &&
        document.parentId.includes(':section:')
      ) {
        const parent = sections.find(
          (section) => section.id === document.parentId,
        );
        if (
          !parent ||
          document.startTime === undefined ||
          document.endTime === undefined ||
          document.startTime < (parent.startTime ?? 0) - 0.001 ||
          document.endTime > (parent.endTime ?? 0) + 0.001
        ) {
          throw new Error(`Chunk ${document.id} is outside its parent section`);
        }
      }
    }

    const reelDocumentId = reels[0]?.id;
    for (const visualScene of visualScenes) {
      if (
        visualScene.parentId !== reelDocumentId ||
        visualScene.evidenceQuality !== 'VERIFIED' ||
        !visualScene.evidenceText?.trim() ||
        !visualScene.evidenceHash?.trim() ||
        visualScene.startTime === undefined
      ) {
        throw new Error(
          `Visual scene ${visualScene.id} has incomplete grounded provenance`,
        );
      }
    }

    const coveredSegmentIds = new Set(
      chunks.flatMap((chunk) => chunk.sourceSegmentIds),
    );
    for (const [ordinal, segment] of (
      input.transcriptSegments ?? []
    ).entries()) {
      const sourceSegmentId =
        typeof segment['sourceSegmentId'] === 'string'
          ? segment['sourceSegmentId']
          : `transcription:0:${segment.id ?? ordinal}`;
      if (!coveredSegmentIds.has(sourceSegmentId)) {
        throw new Error(
          'Chunk evidence does not cover the complete transcript',
        );
      }
    }
  }

  private normalize(value: string): string {
    return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  }

  private hash(value: string): string {
    return createHash('sha256').update(value.normalize('NFKC')).digest('hex');
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
