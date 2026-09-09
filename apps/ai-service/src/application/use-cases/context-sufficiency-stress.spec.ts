import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { CheckContextSufficiencyUseCase } from './check-context-sufficiency.use-case';

const { sufficiencyCases } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../../scripts/ops/rag-control-plane-fixtures.cjs') as {
    sufficiencyCases: Array<{
      id: string;
      question: string;
      expectedSufficient: boolean;
      requiredEvidence: Array<'TRANSCRIPT' | 'VISUAL' | 'METADATA'>;
      evidence: Array<{
        evidenceType: 'TRANSCRIPT' | 'VISUAL' | 'METADATA';
        evidenceText: string;
        title: string;
      }>;
    }>;
  };

describe('generic context sufficiency stress corpus', () => {
  const config = {
    model: jest.fn(() => 'test/test/sufficiency'),
    timeoutMs: jest.fn(() => 15_000),
    maxCompletionTokens: jest.fn(() => 512),
  } as unknown as IAiApplicationConfig;

  it('contains exactly 20 varied fixtures', () => {
    expect(sufficiencyCases).toHaveLength(20);
    expect(
      sufficiencyCases.some((fixture) => fixture.evidence.length === 0),
    ).toBe(true);
    expect(
      sufficiencyCases.some(
        (fixture) => fixture.evidence[0]?.evidenceText.length > 1_000,
      ),
    ).toBe(true);
  });

  it.each(sufficiencyCases)(
    '$id preserves the expected semantic boundary',
    async (fixture) => {
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          sufficient: fixture.expectedSufficient,
          confidence: 0.9,
          supportedEvidenceIds: fixture.expectedSufficient ? ['e0'] : [],
          reason: 'Generic semantic judgment.',
          userFacingReason: fixture.expectedSufficient
            ? ''
            : 'The requested relation is unsupported.',
          recommendedAction: fixture.expectedSufficient
            ? 'ANSWER'
            : 'REFUSE_NO_CONTEXT',
        }),
      };
      const state = {
        userMessage: fixture.question,
        route: {
          needsRetrieval: true,
          requiredEvidence: fixture.requiredEvidence,
        },
        rerankedChunks: fixture.evidence.map((item, index) => ({
          ...item,
          chunkId: `generic-${index}`,
          reelId: 'synthetic-authorized-reel',
          chunkText: item.evidenceText,
          tags: [],
        })),
      } as unknown as RagChatWorkflowState;

      await expect(
        new CheckContextSufficiencyUseCase(service as never, config).execute(
          state,
        ),
      ).resolves.toMatchObject({ sufficient: fixture.expectedSufficient });
    },
  );
});
