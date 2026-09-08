import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

const { routerCases } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../../scripts/ops/rag-control-plane-fixtures.cjs') as {
    routerCases: Array<{
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

describe('generic held-out semantic router corpus', () => {
  const config = {
    model: jest.fn(() => 'test/test/primary'),
    timeoutMs: jest.fn(() => 10_000),
    maxCompletionTokens: jest.fn(() => 1_024),
    get: jest.fn((key: string) =>
      key === 'AI_ROUTER_FALLBACK_MODEL' ? 'test/test/secondary' : undefined,
    ),
    number: jest.fn((_key: string, fallback: number) => fallback),
  } as unknown as IAiApplicationConfig;

  it('contains at least 50 frozen-independent cases and no evaluation vocabulary', () => {
    expect(routerCases.length).toBeGreaterThanOrEqual(50);
    const serialized = JSON.stringify(routerCases);
    expect(serialized).not.toMatch(/\bAMI\b|IN1001|IN1002|IN1005|IN1007/i);
    expect(serialized).not.toMatch(/\b(?:CD|GB|blue|backup)\b/i);
    expect(
      routerCases.filter(({ id }) => id.startsWith('implicit-')),
    ).toHaveLength(20);
    expect(
      routerCases.filter(({ id }) => id.startsWith('explicit-')),
    ).toHaveLength(10);
    expect(
      routerCases.filter(({ id }) => id.startsWith('normal-')),
    ).toHaveLength(10);
    expect(
      routerCases.filter(
        ({ id }) =>
          !id.startsWith('implicit-') &&
          !id.startsWith('explicit-') &&
          !id.startsWith('normal-'),
      ).length,
    ).toBeGreaterThanOrEqual(10);
  });

  it.each(routerCases)(
    '$id normalizes a schema-valid semantic decision',
    async (fixture) => {
      const raw = {
        ...fixture.expected,
        needsRetrieval: fixture.expected.intent === 'REEL_VIDEO_QUESTION',
        needsUserMemory: fixture.expected.intent === 'USER_MEMORY_QUESTION',
        needsConversationSummary:
          fixture.expected.intent === 'CONVERSATION_MEMORY_QUESTION',
        needsVerification: fixture.expected.intent !== 'NORMAL_CHAT',
        recommendationAction: {
          type: fixture.expected.recommendationAction,
          query:
            fixture.expected.recommendationAction === 'NONE'
              ? ''
              : 'generic topic',
          minRelevantItems: 0,
          allowPersonalizedFallback: false,
          suggestedQueries:
            fixture.expected.recommendationAction === 'SUGGEST_QUERIES'
              ? ['generic topic']
              : [],
          reason: 'No discovery attachment required.',
        },
        reason: 'Generic semantic fixture.',
      };
      const service = { generateObject: jest.fn().mockResolvedValue(raw) };

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
        recommendationAction: { type: fixture.expected.recommendationAction },
      });
    },
  );
});
