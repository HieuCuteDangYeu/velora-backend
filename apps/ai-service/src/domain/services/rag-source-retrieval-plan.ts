import type {
  RagChatRouteDecision,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

/** Evidence allocation signal; this does not classify the user's intent. */
export function requiresReelCoverage(message: string): boolean {
  return /\b(?:compare|comparison|contrast|difference|different|versus|vs\.?|both|each|between)\b/i.test(
    message,
  );
}

/** Source constraints come from the original question, never a tool rewrite. */
export function sourceRetrievalPlan(
  message: string,
  route: RagChatRouteDecision,
): RagRetrievalPlan | undefined {
  if (!route.needsRetrieval) return undefined;
  const transcriptRequired =
    route.requiredEvidence?.includes('TRANSCRIPT') === true;
  const firstIndexedTranscriptSegment =
    transcriptRequired &&
    /\bfirst\s+(?:indexed\s+)?transcript\s+segments?\b/i.test(message);
  const opening =
    transcriptRequired &&
    (firstIndexedTranscriptSegment ||
      /\b(?:opening statement|first (?:complete )?(?:statement|sentence)|first thing (?:said|spoken))\b/i.test(
        message,
      ));
  const timestamp = message.match(
    /\b(?:frame|scene)\s+(?:(?:is|was)\s+)?at\s+(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/i,
  );
  const transcriptTimestamp = message.match(
    /\b(?:segment|transcript|speech|spoken|said)\b[^\n\r?]*?\b(?:at|around|spanning|from)\s+(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*)?(?:seconds?|s)\b/i,
  );
  const multimodal = route.reelQuestionType === 'MULTIMODAL_CONTENT';
  const visualTimestampSec =
    (route.reelQuestionType === 'VISUAL_CONTENT' || multimodal) && timestamp
      ? Number(timestamp[1])
      : undefined;
  const visual =
    (route.reelQuestionType === 'VISUAL_CONTENT' || multimodal) &&
    (visualTimestampSec !== undefined ||
      /\bfirst (?:indexed |sampled )?(?:visual )?(?:frame|scene)\b/i.test(
        message,
      ));
  const transcriptWindow = transcriptRequired && transcriptTimestamp !== null;
  if (
    !opening &&
    !visual &&
    !transcriptWindow &&
    !multimodal &&
    route.reelQuestionType !== 'REEL_METADATA'
  )
    return undefined;
  const explicitTranscriptTimestampSec =
    transcriptWindow && transcriptTimestamp
      ? Number(transcriptTimestamp[1])
      : undefined;
  const transcriptTimestampSec =
    explicitTranscriptTimestampSec ??
    (multimodal ? visualTimestampSec : undefined);
  const transcriptTimestampEndSec =
    transcriptWindow && transcriptTimestamp?.[2]
      ? Number(transcriptTimestamp[2])
      : undefined;
  const sourceTimestampSec = multimodal
    ? undefined
    : visual && timestamp
      ? Number(timestamp[1])
      : transcriptTimestampSec;
  const sourceTimestampEndSec = multimodal
    ? undefined
    : transcriptTimestampEndSec;
  const sourceReadLimit =
    transcriptTimestampEndSec !== undefined
      ? 2
      : multimodal
        ? 6
        : opening || visual || transcriptWindow
          ? 1
          : 5;
  return {
    mode: 'REEL_HYBRID',
    requiresReelCoverage: requiresReelCoverage(message),
    ...(opening || visual || transcriptWindow
      ? { sourceOrder: 'ASC' as const }
      : {}),
    ...(sourceTimestampSec !== undefined ? { sourceTimestampSec } : {}),
    ...(sourceTimestampEndSec !== undefined ? { sourceTimestampEndSec } : {}),
    ...(visualTimestampSec !== undefined ? { visualTimestampSec } : {}),
    ...(transcriptTimestampSec !== undefined ? { transcriptTimestampSec } : {}),
    ...(transcriptTimestampEndSec !== undefined
      ? { transcriptTimestampEndSec }
      : {}),
    query: message,
    queries: [message],
    searchLimit: sourceReadLimit,
    rerankLimit: sourceReadLimit,
    shouldRerank: false,
    reason: visual
      ? 'Read the user-specified authorized visual scene.'
      : opening
        ? 'Read the beginning of the authorized transcript.'
        : transcriptWindow
          ? 'Read the user-requested authorized transcript time window.'
          : 'Read typed authorized Reel metadata.',
    diagnostics: {
      modelRole: 'RETRIEVAL_PLANNER',
      providerStatus: 'NOT_CALLED',
      decisionSource: 'NOT_REQUIRED',
    },
  };
}
