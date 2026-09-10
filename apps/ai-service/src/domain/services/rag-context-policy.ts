import type {
  RagChatRouteDecision,
  RagContextSufficiencyResult,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

/**
 * A successful semantic negative is advisory when the required typed evidence
 * is present. Answer generation and the verifier remain the final grounding
 * boundary; unavailable providers and missing modalities still fail closed.
 */
export function allowsGroundedGeneration(
  context: RagContextSufficiencyResult | undefined,
  route: Pick<RagChatRouteDecision, 'requiredEvidence'> | undefined,
): boolean {
  if (!context) return true;
  if (context.sufficient && context.recommendedAction === 'ANSWER') return true;
  if (context.recommendedAction === 'REWRITE_AND_RETRY') return false;
  if (context.diagnostics?.providerStatus !== 'SUCCESS') return false;

  const requiredEvidence = (route?.requiredEvidence ?? []).filter(
    (item) => item !== 'NONE',
  );
  return (
    requiredEvidence.length > 0 &&
    requiredEvidence.every((item) => context.availableEvidence.includes(item))
  );
}
