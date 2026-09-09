import { ReviewIndexQualityUseCase } from './review-index-quality.use-case';

describe('ReviewIndexQualityUseCase', () => {
  it('normalizes reviewer output and drops invalid issues', async () => {
    const structuredLlm = {
      generateObject: jest.fn().mockResolvedValue({
        acceptable: false,
        confidence: 1.4,
        summary: 'Section boundary is misleading.',
        issues: [
          {
            category: 'SECTIONING',
            severity: 'HIGH',
            message: 'The second section combines unrelated topics.',
            documentId: 'section-2',
          },
          {
            category: 'UNKNOWN',
            severity: 'HIGH',
            message: 'Ignored.',
          },
        ],
      }),
    };
    const useCase = new ReviewIndexQualityUseCase(
      structuredLlm as never,
      {
        model: jest.fn(() => 'test/test/index-quality'),
        timeoutMs: jest.fn(() => 8_000),
        maxCompletionTokens: jest.fn(() => 768),
      } as never,
    );

    await expect(
      useCase.execute({
        reelId: 'reel-1',
        sourceLengthClass: 'LONG',
        durationMs: 600_000,
        tags: ['nestjs'],
        documents: [
          {
            id: 'section-2',
            kind: 'SECTION',
            ordinal: 1,
            evidenceQuality: 'VERIFIED',
            text: 'Database setup and unrelated outro content.',
          },
        ],
      }),
    ).resolves.toEqual({
      acceptable: false,
      confidence: 1,
      summary: 'Section boundary is misleading.',
      issues: [
        {
          category: 'SECTIONING',
          severity: 'HIGH',
          message: 'The second section combines unrelated topics.',
          documentId: 'section-2',
        },
      ],
    });
  });
});
