import type {
  RagChatRouteDecision,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

/** Source constraints come from the original question, never a tool rewrite. */
export function sourceRetrievalPlan(
  message: string,
  route: RagChatRouteDecision,
): RagRetrievalPlan | undefined {
  if (!route.needsRetrieval) return undefined;
  const opening =
    route.reelQuestionType === 'TRANSCRIPT_CONTENT' &&
    /\b(?:opening statement|first (?:statement|sentence)|first thing (?:said|spoken))\b/i.test(
      message,
    );
  if (!opening && route.reelQuestionType !== 'REEL_METADATA') return undefined;
  return {
    mode: 'REEL_HYBRID',
    ...(opening ? { sourceOrder: 'ASC' as const } : {}),
    query: message,
    queries: [message],
    searchLimit: opening ? 1 : 5,
    rerankLimit: opening ? 1 : 5,
    shouldRerank: false,
    reason: opening
      ? 'Read the beginning of the authorized transcript.'
      : 'Read typed authorized Reel metadata.',
    diagnostics: {
      modelRole: 'RETRIEVAL_PLANNER',
      providerStatus: 'NOT_CALLED',
      decisionSource: 'NOT_REQUIRED',
    },
  };
}
