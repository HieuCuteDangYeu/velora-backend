import { ValidatePersistedSemanticCandidateUseCase } from './validate-persisted-semantic-candidate.use-case';

const document = {
  id: 'reel:1',
  reelId: 'reel-1',
  kind: 'REEL' as const,
  ordinal: 0,
  retrievalText: 'A grounded reel about PostgreSQL.',
  sourceSectionIds: [],
  sourceSegmentIds: [],
  sourceAudioArtifactIds: [],
  retrievalHash: 'hash',
  evidenceQuality: 'METADATA_ONLY' as const,
  sectioningVersion: 'v1',
  chunkingVersion: 'v1',
  summaryVersion: 'v1',
  indexVersion: 'v1',
  embeddingProvider: 'test',
  embeddingModel: 'test',
  embeddingDimensions: 2,
  embeddingVersion: 'v1',
  embeddingInputHash: 'hash',
  embedding: [0.1, 0.2],
  tokenCount: 8,
};

const job = {
  reelId: 'reel-1',
  indexAttemptId: 'attempt-1',
  indexVersion: 'v1',
  mediaAttemptId: 'media-1',
  mediaKey: 'reels/reel-1.mp4',
  sourceDurationMs: 60_000,
  sourceLengthClass: 'SHORT' as const,
  sourceOrientation: 'PORTRAIT' as const,
  title: 'PostgreSQL setup',
  description: 'A detailed PostgreSQL setup walkthrough for a NestJS service.',
  tags: ['postgresql', 'nestjs', 'backend'],
};

const input = {
  job: job as never,
  documents: [document],
  transcriptSegmentCount: 0,
};

const advisoryPolicy = {
  enabled: true,
  enforced: false,
  required: false,
  maxDocuments: 36,
};

const qualityReviews = { persist: jest.fn().mockResolvedValue(undefined) };
const config = {
  get: jest.fn((key: string) =>
    key === 'AI_INDEX_QUALITY_MODEL' ? 'openai/gpt-oss-20b' : undefined,
  ),
};

describe('ValidatePersistedSemanticCandidateUseCase', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('runs deterministic validation before advisory semantic review', async () => {
    const callOrder: string[] = [];
    const validator = {
      execute: jest.fn().mockImplementation(() => {
        callOrder.push('validator');
        return Promise.resolve();
      }),
    };
    const ai = {
      reviewIndexQuality: jest.fn().mockImplementation(() => {
        callOrder.push('reviewer');
        return Promise.resolve({
          acceptable: false,
          confidence: 0.9,
          summary: 'Advisory issue.',
          issues: [
            {
              category: 'RETRIEVAL_QUALITY',
              severity: 'MEDIUM',
              message: 'Could be more specific.',
            },
          ],
        });
      }),
    };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      advisoryPolicy,
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).resolves.toBeUndefined();
    expect(callOrder).toEqual(['validator', 'reviewer']);
    expect(qualityReviews.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        reelId: 'reel-1',
        indexAttemptId: 'attempt-1',
        embeddingProvider: 'test',
        embeddingModel: 'test',
        embeddingDimensions: 2,
        embeddingVersion: 'v1',
        reviewProvider: 'groq',
        reviewModel: 'openai/gpt-oss-20b',
        reviewVersion: 'index-quality-review-v1',
        review: expect.objectContaining({ acceptable: false }),
      }),
    );
  });

  it('persists an accepted semantic review before activation continues', async () => {
    const validator = { execute: jest.fn().mockResolvedValue(undefined) };
    const ai = {
      reviewIndexQuality: jest.fn().mockResolvedValue({
        acceptable: true,
        confidence: 0.98,
        summary: 'The index is usable.',
        issues: [],
      }),
    };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      advisoryPolicy,
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).resolves.toBeUndefined();
    expect(qualityReviews.persist).toHaveBeenCalledWith(
      expect.objectContaining({
        review: expect.objectContaining({ acceptable: true, issues: [] }),
      }),
    );
  });

  it('never runs semantic review when deterministic validation fails', async () => {
    const validator = {
      execute: jest.fn().mockRejectedValue(new Error('integrity mismatch')),
    };
    const ai = { reviewIndexQuality: jest.fn() };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      advisoryPolicy,
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).rejects.toThrow('integrity mismatch');
    expect(ai.reviewIndexQuality).not.toHaveBeenCalled();
  });

  it('blocks activation when semantic enforcement is enabled', async () => {
    const validator = { execute: jest.fn().mockResolvedValue(undefined) };
    const ai = {
      reviewIndexQuality: jest.fn().mockResolvedValue({
        acceptable: false,
        confidence: 0.95,
        summary: 'Grounding problem.',
        issues: [
          {
            category: 'GROUNDING',
            severity: 'HIGH',
            message:
              'Retrieval content is not supported by the supplied evidence.',
          },
        ],
      }),
    };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      { ...advisoryPolicy, enforced: true },
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).rejects.toThrow(
      'Semantic quality agent rejected inactive index candidate',
    );
    expect(qualityReviews.persist).toHaveBeenCalledTimes(1);
  });

  it('does not fabricate a review when an advisory agent is unavailable', async () => {
    const validator = { execute: jest.fn().mockResolvedValue(undefined) };
    const ai = {
      reviewIndexQuality: jest
        .fn()
        .mockRejectedValue(new Error('agent unavailable')),
    };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      advisoryPolicy,
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).resolves.toBeUndefined();
    expect(qualityReviews.persist).not.toHaveBeenCalled();
  });

  it('skips semantic review when the policy is disabled', async () => {
    const validator = { execute: jest.fn().mockResolvedValue(undefined) };
    const ai = { reviewIndexQuality: jest.fn() };
    const useCase = new ValidatePersistedSemanticCandidateUseCase(
      validator,
      ai as never,
      { ...advisoryPolicy, enabled: false },
      qualityReviews,
      config as never,
    );

    await expect(useCase.execute(input)).resolves.toBeUndefined();
    expect(validator.execute).toHaveBeenCalledTimes(1);
    expect(ai.reviewIndexQuality).not.toHaveBeenCalled();
    expect(qualityReviews.persist).not.toHaveBeenCalled();
  });
});
