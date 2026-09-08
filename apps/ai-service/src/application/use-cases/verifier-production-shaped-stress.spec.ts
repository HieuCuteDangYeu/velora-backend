import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { VerifierAgentUseCase } from './verifier-agent.use-case';

const { verifierCases } =
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../../../../../scripts/ops/rag-control-plane-fixtures.cjs') as {
    verifierCases: Array<{
      id: string;
      question: string;
      answer: string;
      claim: string;
      evidence: Array<{
        evidenceType: 'TRANSCRIPT';
        evidenceText: string;
        title: string;
      }>;
    }>;
  };

describe('production-shaped generic verifier contract', () => {
  const config = {
    model: jest.fn((role: string) => `test/test/${role.toLowerCase()}`),
    timeoutMs: jest.fn(() => 20_000),
    maxCompletionTokens: jest.fn(() => 650),
    boolean: jest.fn(() => true),
    number: jest.fn((key: string) =>
      key === 'AI_VERIFIER_MAX_ATTEMPTS' ? 2 : 0.8,
    ),
  } as unknown as IAiApplicationConfig;

  it('contains exactly 15 frozen-independent five-evidence fixtures', () => {
    expect(verifierCases).toHaveLength(15);
    expect(verifierCases.every(({ evidence }) => evidence.length === 5)).toBe(
      true,
    );
    expect(JSON.stringify(verifierCases)).not.toMatch(
      /\bAMI\b|IN1001|IN1002|IN1005|IN1007|\b(?:CD|GB|blue|backup)\b/i,
    );
  });

  it.each(verifierCases)(
    '$id validates one bounded primary decision',
    async (fixture) => {
      const state = {
        userId: 'synthetic-user',
        conversationId: 'synthetic-conversation',
        userMessage: fixture.question,
        answer: fixture.answer,
        answerClaims: [{ claim: fixture.claim, evidenceIds: ['e0'] }],
        route: {
          intent: 'REEL_VIDEO_QUESTION',
          referenceTarget: 'SHARED_REEL',
          needsRetrieval: true,
          needsUserMemory: false,
          needsConversationSummary: false,
          needsVerification: true,
          reelQuestionType: 'TRANSCRIPT_CONTENT',
          requiredEvidence: ['TRANSCRIPT'],
          recommendationAction: { type: 'NONE', reason: 'No discovery.' },
          reason: 'Synthetic verifier fixture.',
        },
        retrievedChunks: [],
        rerankedChunks: fixture.evidence.map((evidence, index) => ({
          ...evidence,
          chunkId: `e${index}`,
          reelId: 'synthetic-authorized-reel',
          chunkText: evidence.evidenceText,
          tags: [],
          startTime: index * 10,
          endTime: index * 10 + 8,
        })),
        retryCount: 0,
        citationRetryCount: 0,
      } as RagChatWorkflowState;
      const service = {
        generateObject: jest.fn().mockResolvedValue({
          passed: true,
          confidence: 0.95,
          issues: [],
          requiresRevision: false,
          revisedInstruction: '',
          contradictions: [],
          supportedClaimMappings: [
            { claim: fixture.claim, evidenceIds: ['e0'] },
          ],
        }),
      };

      await expect(
        new VerifierAgentUseCase(service as never, config).execute(state),
      ).resolves.toMatchObject({
        passed: true,
        diagnostics: { decisionSource: 'LLM_PRIMARY', escalated: false },
      });
      expect(service.generateObject).toHaveBeenCalledTimes(1);
      expect(service.generateObject).toHaveBeenCalledWith(
        expect.objectContaining({
          modelRole: 'VERIFIER',
          temperature: 0,
          timeoutMs: 20_000,
        }),
      );
    },
  );
});
