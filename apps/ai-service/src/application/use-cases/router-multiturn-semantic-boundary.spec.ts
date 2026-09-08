import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

const { routerMultiturnCases } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../../scripts/ops/rag-router-multiturn-fixtures.cjs') as {
    routerMultiturnCases: Array<{
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

describe('generic multi-turn semantic router cohort', () => {
  const config = {
    model: jest.fn(() => 'test/test/router'),
    timeoutMs: jest.fn(() => 7_000),
    maxCompletionTokens: jest.fn(() => 384),
    get: jest.fn().mockReturnValue(undefined),
    number: jest.fn((_key: string, fallback: number) => fallback),
  } as unknown as IAiApplicationConfig;

  it('contains the requested generic multi-turn shapes', () => {
    expect(routerMultiturnCases).toHaveLength(12);
    expect(
      routerMultiturnCases
        .slice(0, 9)
        .every((fixture) => fixture.recentHistory.includes('ASSISTANT:')),
    ).toBe(true);
    expect(routerMultiturnCases[8].referentContext).toMatchObject({
      conversationHasSharedReelContext: true,
      recentShareEvent: false,
    });
    expect(routerMultiturnCases[9].expected.intent).toBe(
      'CONVERSATION_MEMORY_QUESTION',
    );
    expect(routerMultiturnCases[10].expected.intent).toBe('NORMAL_CHAT');
    expect(routerMultiturnCases[11].expected.intent).toBe(
      'USER_MEMORY_QUESTION',
    );
  });

  it.each(routerMultiturnCases)(
    '$id preserves the model-selected semantic boundary in realistic history',
    async (fixture) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          ...fixture.expected,
          recommendationAction: {
            type: fixture.expected.recommendationAction,
            query: '',
            allowPersonalizedFallback: false,
            suggestedQueries: [],
          },
          reason: 'Generic synthetic semantic fixture.',
        }),
      };

      await expect(
        new QueryRouterAgentUseCase(service as never, config).execute({
          message: fixture.message,
          recentHistory: fixture.recentHistory,
          hasSharedReelContext: fixture.hasSharedReelContext,
          sharedReelCount: fixture.sharedReelCount,
          referentContext: fixture.referentContext,
        }),
      ).resolves.toMatchObject({
        ...fixture.expected,
        recommendationAction: {
          type: fixture.expected.recommendationAction,
        },
      });
    },
  );

  it('states the new-media-fact versus conversation-memory boundary generically', async () => {
    const service = {
      generateObject: jest.fn().mockResolvedValue({
        ...routerMultiturnCases[0].expected,
        recommendationAction: {
          type: 'NONE',
          query: '',
          allowPersonalizedFallback: false,
          suggestedQueries: [],
        },
        reason: 'Generic synthetic semantic fixture.',
      }),
    };

    await new QueryRouterAgentUseCase(service as never, config).execute({
      message: routerMultiturnCases[0].message,
      recentHistory: routerMultiturnCases[0].recentHistory,
      hasSharedReelContext: true,
      sharedReelCount: 1,
      referentContext: routerMultiturnCases[0].referentContext,
    });

    const request = service.generateObject.mock.calls[0][0];
    expect(request.systemPrompt).toContain(
      'follow-up asking for new information from shared media',
    );
    expect(request.systemPrompt).toContain(
      'CONVERSATION_MEMORY_QUESTION only when the current message asks',
    );
  });
});
