import type {
  IIndexingAiService,
  IndexQualityReviewInput,
  IndexQualityReviewResult,
} from '@indexing/domain/interfaces/ai-service.interface';
import type { IIndexQualityAgentPolicy } from '@indexing/domain/interfaces/index-quality-agent-policy.interface';
import type { IIndexingApplicationConfig } from '@indexing/domain/interfaces/indexing-application-config.interface';
import type { IIndexQualityReviewRepository } from '@indexing/domain/interfaces/index-quality-review.repository.interface';
import type { IPersistedSemanticCandidateValidator } from '@indexing/domain/interfaces/persisted-semantic-candidate-validator.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

type PersistedCandidateInput = Parameters<
  IPersistedSemanticCandidateValidator['execute']
>[0];
type PersistedCandidateDocument = PersistedCandidateInput['documents'][number];

@Injectable()
export class ValidatePersistedSemanticCandidateUseCase {
  private readonly logger = new Logger(
    ValidatePersistedSemanticCandidateUseCase.name,
  );

  constructor(
    @Inject('IPersistedSemanticCandidateValidator')
    private readonly validator: IPersistedSemanticCandidateValidator,
    @Inject('IIndexingAiService')
    private readonly ai: IIndexingAiService,
    @Inject('IIndexQualityAgentPolicy')
    private readonly policy: IIndexQualityAgentPolicy,
    @Inject('IIndexQualityReviewRepository')
    private readonly qualityReviews: IIndexQualityReviewRepository,
    @Inject('IIndexingApplicationConfig')
    private readonly config: IIndexingApplicationConfig,
  ) {}

  async execute(input: PersistedCandidateInput): Promise<void> {
    await this.validator.execute(input);
    if (!this.policy.enabled) return;

    let review: IndexQualityReviewResult;
    try {
      review = await this.ai.reviewIndexQuality(
        this.toReviewRequest(input.job, input.documents),
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.policy.required) throw error;
      this.logger.warn(
        `[IndexQualityAgent] review unavailable; structural gate remains authoritative: ${message}`,
      );
      return;
    }

    const issueSummary = review.issues
      .map((issue) => `${issue.severity}:${issue.category}`)
      .join(',');
    this.logger.log(
      `[IndexQualityAgent] reelId=${input.job.reelId} acceptable=${review.acceptable} confidence=${review.confidence.toFixed(2)} issues=${issueSummary || 'none'}`,
    );

    const reelDocument = input.documents.find(
      (document) => document.kind === 'REEL',
    );
    if (!reelDocument) {
      throw new Error('Semantic quality review requires a Reel document');
    }

    await this.qualityReviews.persist({
      reelId: input.job.reelId,
      indexAttemptId: input.job.indexAttemptId,
      indexVersion: input.job.indexVersion,
      embeddingProvider: reelDocument.embeddingProvider,
      embeddingModel: reelDocument.embeddingModel,
      embeddingDimensions: reelDocument.embeddingDimensions,
      embeddingVersion: reelDocument.embeddingVersion,
      reviewProvider:
        this.config.get<string>('INDEX_QUALITY_REVIEW_PROVIDER')?.trim() ||
        'groq',
      reviewModel:
        this.config.get<string>('AI_INDEX_QUALITY_MODEL')?.trim() || 'unknown',
      reviewVersion:
        this.config.get<string>('INDEX_QUALITY_REVIEW_VERSION')?.trim() ||
        'index-quality-review-v1',
      review,
    });

    if (!review.acceptable && this.policy.enforced) {
      const details = review.issues
        .filter((issue) => issue.severity !== 'LOW')
        .slice(0, 4)
        .map((issue) => issue.message)
        .join('; ');
      throw new Error(
        `Semantic quality agent rejected inactive index candidate${details ? `: ${details}` : ''}`,
      );
    }

    if (!review.acceptable) {
      this.logger.warn(
        `[IndexQualityAgent] advisory rejection reelId=${input.job.reelId}: ${review.summary}`,
      );
    }
  }

  private toReviewRequest(
    job: PersistedCandidateInput['job'],
    documents: PersistedCandidateInput['documents'],
  ): IndexQualityReviewInput {
    const prioritized = [...documents]
      .sort(
        (left, right) =>
          this.kindPriority(left.kind) - this.kindPriority(right.kind),
      )
      .slice(0, this.policy.maxDocuments);

    return {
      reelId: job.reelId,
      sourceLengthClass: job.sourceLengthClass,
      durationMs: job.outputDurationMs ?? job.sourceDurationMs,
      title: job.title,
      description: job.description,
      tags: job.tags,
      documents: prioritized.map((document) => ({
        id: document.id,
        kind: document.kind,
        ordinal: document.ordinal,
        parentId: document.parentId,
        startTime: document.startTime,
        endTime: document.endTime,
        evidenceQuality: document.evidenceQuality,
        text: (
          document.evidenceText ||
          document.derivedSummary ||
          document.retrievalText
        )
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 1_200),
      })),
    };
  }

  private kindPriority(kind: PersistedCandidateDocument['kind']): number {
    if (kind === 'REEL') return 0;
    if (kind === 'SECTION') return 1;
    if (kind === 'VISUAL_SCENE') return 2;
    return 3;
  }
}
