import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

const { routerEvidenceBoundaryCases } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../../scripts/ops/rag-router-evidence-boundary-fixtures.cjs') as {
    routerEvidenceBoundaryCases: Array<{
      id: string;
      message: string;
      recentHistory: string;
      hasSharedReelContext: boolean;
      sharedReelCount: number;
      referentContext: {
        conversationHasSharedReelContext: boolean;
        accessibleSharedReelCount: number;
        recentShareEvent: boolean;
        turnsSinceRecentShare?: number;
        recentEventTypes: Array<'TEXT' | 'REEL_SHARE'>;
      };
      expected: {
        intent: string;
        referenceTarget: string;
        reelQuestionType: string;
        requiredEvidence: string[];
        recommendationAction: string;
      };
    }>;
  };

describe('generic router evidence minimality boundary', () => {
  const config = {
    model: jest.fn(() => 'test/test/router'),
    timeoutMs: jest.fn(() => 7_000),
    maxCompletionTokens: jest.fn(() => 384),
    get: jest.fn().mockReturnValue(undefined),
    number: jest.fn((_key: string, fallback: number) => fallback),
  } as unknown as IAiApplicationConfig;

  const route = (
    expected: (typeof routerEvidenceBoundaryCases)[number]['expected'],
  ) => ({
    ...expected,
    recommendationAction: {
      type: expected.recommendationAction,
      query: '',
      allowPersonalizedFallback: false,
      suggestedQueries: [],
    },
    reason: 'Generic synthetic evidence-boundary fixture.',
  });

  const executeWith = (
    raw: Record<string, unknown>,
    input: Partial<Parameters<QueryRouterAgentUseCase['execute']>[0]> = {},
  ) => {
    const service = { generateObject: jest.fn().mockResolvedValue(raw) };
    const useCase = new QueryRouterAgentUseCase(service as never, config);
    return {
      service,
      promise: useCase.execute({
        message: 'A generic synthetic question.',
        ...input,
      }),
    };
  };

  it('contains six content facts, three media-object metadata controls, and one summary', () => {
    expect(routerEvidenceBoundaryCases).toHaveLength(10);
    expect(
      routerEvidenceBoundaryCases.filter(
        ({ expected }) => expected.reelQuestionType === 'TRANSCRIPT_CONTENT',
      ),
    ).toHaveLength(6);
    expect(
      routerEvidenceBoundaryCases.filter(
        ({ expected }) => expected.reelQuestionType === 'REEL_METADATA',
      ),
    ).toHaveLength(3);
    expect(
      routerEvidenceBoundaryCases.filter(
        ({ expected }) => expected.reelQuestionType === 'GENERAL_REEL_SUMMARY',
      ),
    ).toHaveLength(1);
    expect(
      routerEvidenceBoundaryCases.every(({ recentHistory }) =>
        recentHistory.includes('ASSISTANT:'),
      ),
    ).toBe(true);
  });

  it.each(routerEvidenceBoundaryCases)(
    '$id preserves its generic evidence boundary',
    async (fixture) => {
      const { promise, service } = executeWith(route(fixture.expected), {
        message: fixture.message,
        recentHistory: fixture.recentHistory,
        hasSharedReelContext: fixture.hasSharedReelContext,
        sharedReelCount: fixture.sharedReelCount,
        referentContext: fixture.referentContext,
      });

      await expect(promise).resolves.toMatchObject({
        ...fixture.expected,
        recommendationAction: {
          type: fixture.expected.recommendationAction,
        },
      });
      expect(service.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps TRANSCRIPT_CONTENT exact when the model over-selects METADATA', async () => {
    const { promise } = executeWith(
      route({
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'TRANSCRIPT_CONTENT',
        requiredEvidence: ['TRANSCRIPT', 'METADATA'],
        recommendationAction: 'NONE',
      }),
      { hasSharedReelContext: true },
    );

    await expect(promise).rejects.toMatchObject({
      code: 'ROUTER_UNAVAILABLE',
      causeCode: 'ROUTER_SEMANTIC_INCONSISTENT',
      semanticInconsistencyType: 'REQUIRED_EVIDENCE_MISMATCH',
      semanticInconsistencyDetails: {
        actualEvidence: ['TRANSCRIPT', 'METADATA'],
        expectedEvidence: ['TRANSCRIPT'],
      },
    });
  });

  it('accepts REEL_METADATA with only METADATA evidence', async () => {
    const { promise } = executeWith(
      route({
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'REEL_METADATA',
        requiredEvidence: ['METADATA'],
        recommendationAction: 'NONE',
      }),
      { hasSharedReelContext: true },
    );

    await expect(promise).resolves.toMatchObject({
      reelQuestionType: 'REEL_METADATA',
      requiredEvidence: ['METADATA'],
    });
  });

  it('accepts GENERAL_REEL_SUMMARY with transcript and metadata evidence', async () => {
    const { promise } = executeWith(
      route({
        intent: 'REEL_VIDEO_QUESTION',
        referenceTarget: 'SHARED_REEL',
        reelQuestionType: 'GENERAL_REEL_SUMMARY',
        requiredEvidence: ['TRANSCRIPT', 'METADATA'],
        recommendationAction: 'NONE',
      }),
      { hasSharedReelContext: true },
    );

    await expect(promise).resolves.toMatchObject({
      reelQuestionType: 'GENERAL_REEL_SUMMARY',
      requiredEvidence: ['TRANSCRIPT', 'METADATA'],
    });
  });
});
