import type {
  RagChatRouteDecision,
  RagContextSufficiencyResult,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { allowsGroundedGeneration } from './rag-context-policy';

const route = {
  requiredEvidence: ['TRANSCRIPT'],
} as Pick<RagChatRouteDecision, 'requiredEvidence'>;

const context = (
  overrides: Partial<RagContextSufficiencyResult> = {},
): RagContextSufficiencyResult => ({
  sufficient: false,
  confidence: 0.2,
  availableEvidence: ['TRANSCRIPT'],
  missingEvidence: ['TRANSCRIPT'],
  reason: 'Semantic negative.',
  recommendedAction: 'REFUSE_NO_CONTEXT',
  diagnostics: {
    providerStatus: 'SUCCESS',
    decisionSource: 'LLM',
  },
  ...overrides,
});

describe('allowsGroundedGeneration', () => {
  it('keeps a successful semantic negative in the verifier-backed path', () => {
    expect(allowsGroundedGeneration(context(), route)).toBe(true);
  });

  it('keeps provider failures in the verifier-backed path when typed evidence exists', () => {
    expect(
      allowsGroundedGeneration(
        context({
          diagnostics: {
            providerStatus: 'ERROR',
            decisionSource: 'FAIL_CLOSED',
          },
        }),
        route,
      ),
    ).toBe(true);
    expect(
      allowsGroundedGeneration(
        context({
          availableEvidence: [],
          diagnostics: {
            providerStatus: 'NOT_CALLED',
            decisionSource: 'DETERMINISTIC_REQUIRED_MODALITY',
          },
        }),
        route,
      ),
    ).toBe(false);
  });

  it('preserves retrieval repair decisions', () => {
    expect(
      allowsGroundedGeneration(
        context({ recommendedAction: 'REWRITE_AND_RETRY' }),
        route,
      ),
    ).toBe(false);
  });
});
