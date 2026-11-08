import type {
  RagChatRouteDecision,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { transcriptSegmentRequestKind } from '@ai/domain/services/rag-prompt-bounds';

// shortcut: estimate the observed transcript segment cadence until reads expose total in-window chunk counts.
const TRANSCRIPT_SUMMARY_SECONDS_PER_CHUNK = 8;
// shortcut: cap one summary read at the retrieval API's 20-result limit; page longer windows when supported.
const MAX_TRANSCRIPT_SUMMARY_CHUNKS = 20;

/** Evidence allocation signal; this does not classify the user's intent. */
export function requiresReelCoverage(message: string): boolean {
  const referencedEpisodes = new Set(
    [...message.matchAll(/\b(?:episode|reel)\s*#?\s*(\d+)\b/gi)].map(
      (match) => match[1],
    ),
  );
  return (
    /\b(?:compare|comparison|contrast|difference|different|versus|vs\.?|both|each|between)\b/i.test(
      message,
    ) || referencedEpisodes.size > 1
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
  const reelCoverageRequired = requiresReelCoverage(message);
  const requestKind = transcriptSegmentRequestKind(message, route, {
    requiresReelCoverage: reelCoverageRequired,
  });
  const firstIndexedTranscriptSegment =
    transcriptRequired && requestKind === 'MULTI_REEL_COMPARISON';
  const opening =
    transcriptRequired &&
    (firstIndexedTranscriptSegment ||
      route.transcriptRequestKind === 'FIRST_COMPLETE_UTTERANCE');
  const timestamp = message.match(
    /\b(?:frame|scene)\s+(?:(?:is|was)\s+)?at\s+(\d+(?:\.\d+)?)\s*(?:seconds?|s)\b/i,
  );
  const transcriptTimestamp = message.match(
    /\b(?:segment|transcript|speech|spoken|said|dialogue)\b[^\n\r?]*?\b(?:at|around|spanning|from)\s+(\d+(?:\.\d+)?)\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*)?(?:seconds?|s)\b/i,
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
  const summaryWindowReadLimit =
    requestKind === 'SUMMARY' &&
    explicitTranscriptTimestampSec !== undefined &&
    transcriptTimestampEndSec !== undefined
      ? Math.min(
          MAX_TRANSCRIPT_SUMMARY_CHUNKS,
          Math.max(
            2,
            Math.ceil(
              (transcriptTimestampEndSec - explicitTranscriptTimestampSec) /
                TRANSCRIPT_SUMMARY_SECONDS_PER_CHUNK,
            ),
          ),
        )
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
      ? (summaryWindowReadLimit ?? 2)
      : multimodal
        ? 6
        : opening || visual || transcriptWindow
          ? 1
          : 5;
  return {
    mode: 'REEL_HYBRID',
    requiresReelCoverage: reelCoverageRequired,
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
