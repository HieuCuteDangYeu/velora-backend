import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import type {
  RagChatRouteDecision,
  RagContextSufficiencyResult,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

export interface RagPromptConfig {
  get<T = string>(key: string): T | undefined;
}

export interface RagPromptBounds {
  maxUserMessageChars: number;
  maxAnswerChars: number;
  maxClaimChars: number;
  maxClaims: number;
  maxClaimsTotalChars: number;
  maxRecentMessages: number;
  maxRouterEventTypes: number;
  maxRecentMessageChars: number;
  maxRecentTotalChars: number;
  maxSummaryChars: number;
  maxMemories: number;
  maxMemoryItemChars: number;
  maxMemoryTotalChars: number;
  maxEvidenceItems: number;
  maxEvidenceTextChars: number;
  maxEvidenceTotalChars: number;
  maxEvidenceTitleChars: number;
  maxEvidenceDescriptionChars: number;
  maxEvidenceTags: number;
  maxEvidenceTagChars: number;
}

export type TranscriptSegmentRequestKind = 'SUMMARY' | 'MULTI_REEL_COMPARISON';

export const DEFAULT_RAG_PROMPT_BOUNDS: RagPromptBounds = {
  maxUserMessageChars: 1_200,
  maxAnswerChars: 2_500,
  maxClaimChars: 500,
  maxClaims: 12,
  maxClaimsTotalChars: 3_000,
  maxRecentMessages: 4,
  maxRouterEventTypes: 16,
  maxRecentMessageChars: 400,
  maxRecentTotalChars: 1_200,
  maxSummaryChars: 800,
  maxMemories: 4,
  maxMemoryItemChars: 240,
  maxMemoryTotalChars: 800,
  maxEvidenceItems: 5,
  maxEvidenceTextChars: 500,
  maxEvidenceTotalChars: 2_200,
  maxEvidenceTitleChars: 200,
  maxEvidenceDescriptionChars: 350,
  maxEvidenceTags: 8,
  maxEvidenceTagChars: 80,
};

const BOUND_CONFIG: Array<{
  field: keyof RagPromptBounds;
  key: string;
  min: number;
  max: number;
}> = [
  {
    field: 'maxUserMessageChars',
    key: 'RAG_PROMPT_MAX_USER_MESSAGE_CHARS',
    min: 200,
    max: 4_000,
  },
  {
    field: 'maxAnswerChars',
    key: 'RAG_PROMPT_MAX_ANSWER_CHARS',
    min: 500,
    max: 4_000,
  },
  {
    field: 'maxClaimChars',
    key: 'RAG_PROMPT_MAX_CLAIM_CHARS',
    min: 120,
    max: 1_000,
  },
  { field: 'maxClaims', key: 'RAG_PROMPT_MAX_CLAIMS', min: 1, max: 20 },
  {
    field: 'maxClaimsTotalChars',
    key: 'RAG_PROMPT_MAX_CLAIMS_TOTAL_CHARS',
    min: 400,
    max: 8_000,
  },
  {
    field: 'maxRecentMessages',
    key: 'RAG_PROMPT_MAX_RECENT_MESSAGES',
    min: 1,
    max: 12,
  },
  {
    field: 'maxRouterEventTypes',
    key: 'RAG_PROMPT_MAX_ROUTER_EVENT_TYPES',
    min: 4,
    max: 64,
  },
  {
    field: 'maxRecentMessageChars',
    key: 'RAG_PROMPT_MAX_RECENT_MESSAGE_CHARS',
    min: 80,
    max: 2_000,
  },
  {
    field: 'maxRecentTotalChars',
    key: 'RAG_PROMPT_MAX_RECENT_TOTAL_CHARS',
    min: 200,
    max: 8_000,
  },
  {
    field: 'maxSummaryChars',
    key: 'RAG_PROMPT_MAX_SUMMARY_CHARS',
    min: 200,
    max: 4_000,
  },
  { field: 'maxMemories', key: 'RAG_PROMPT_MAX_MEMORIES', min: 0, max: 8 },
  {
    field: 'maxMemoryItemChars',
    key: 'RAG_PROMPT_MAX_MEMORY_ITEM_CHARS',
    min: 80,
    max: 1_000,
  },
  {
    field: 'maxMemoryTotalChars',
    key: 'RAG_PROMPT_MAX_MEMORY_TOTAL_CHARS',
    min: 200,
    max: 4_000,
  },
  {
    field: 'maxEvidenceItems',
    key: 'RAG_PROMPT_MAX_EVIDENCE_ITEMS',
    min: 1,
    max: 8,
  },
  {
    field: 'maxEvidenceTextChars',
    key: 'RAG_PROMPT_MAX_EVIDENCE_CHARS',
    min: 120,
    max: 1_200,
  },
  {
    field: 'maxEvidenceTotalChars',
    key: 'RAG_PROMPT_MAX_EVIDENCE_TOTAL_CHARS',
    min: 400,
    max: 6_000,
  },
  {
    field: 'maxEvidenceTitleChars',
    key: 'RAG_PROMPT_MAX_EVIDENCE_TITLE_CHARS',
    min: 40,
    max: 500,
  },
  {
    field: 'maxEvidenceDescriptionChars',
    key: 'RAG_PROMPT_MAX_EVIDENCE_DESCRIPTION_CHARS',
    min: 80,
    max: 800,
  },
  {
    field: 'maxEvidenceTags',
    key: 'RAG_PROMPT_MAX_EVIDENCE_TAGS',
    min: 0,
    max: 12,
  },
  {
    field: 'maxEvidenceTagChars',
    key: 'RAG_PROMPT_MAX_EVIDENCE_TAG_CHARS',
    min: 20,
    max: 160,
  },
];

export function readRagPromptBounds(config?: RagPromptConfig): RagPromptBounds {
  const bounds = { ...DEFAULT_RAG_PROMPT_BOUNDS };
  const get: ((key: string) => unknown) | undefined =
    config && typeof config.get === 'function'
      ? (key: string) => config.get(key)
      : undefined;
  for (const item of BOUND_CONFIG) {
    const parsed = Number(get?.(item.key));
    if (Number.isFinite(parsed)) {
      bounds[item.field] = Math.round(
        Math.min(item.max, Math.max(item.min, parsed)),
      );
    }
  }
  return bounds;
}

export function transcriptSegmentRequestKind(
  question: string,
  route: Pick<RagChatRouteDecision, 'requiredEvidence'> | undefined,
  plan: Pick<RagRetrievalPlan, 'requiresReelCoverage'> | undefined,
): TranscriptSegmentRequestKind | undefined {
  if (route?.requiredEvidence?.includes('TRANSCRIPT') !== true)
    return undefined;
  if (
    /\b(?:summarize|summary)\b/i.test(question) &&
    /\b(?:speech|transcript)\b/i.test(question) &&
    /\bsegment\b/i.test(question)
  ) {
    return 'SUMMARY';
  }
  if (
    plan?.requiresReelCoverage === true &&
    /\bcompare\b/i.test(question) &&
    /\b(?:first|opening|initial)\b/i.test(question) &&
    /\b(?:indexed )?transcript segments?\b/i.test(question)
  ) {
    return 'MULTI_REEL_COMPARISON';
  }
  return undefined;
}

export function transcriptSegmentPromptBounds(
  bounds: RagPromptBounds,
  requestKind: TranscriptSegmentRequestKind | undefined,
): RagPromptBounds {
  if (!requestKind) return bounds;
  return {
    ...bounds,
    maxEvidenceTextChars: Math.max(bounds.maxEvidenceTextChars, 1_000),
    maxEvidenceTotalChars: Math.max(bounds.maxEvidenceTotalChars, 3_000),
  };
}

export function truncatePromptText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const budget = Math.max(0, maxChars - 3);
  const boundary = normalized.lastIndexOf(' ', budget);
  return `${normalized.slice(0, boundary > Math.floor(budget * 0.6) ? boundary : budget).trim()}...`;
}

/** Select one contiguous source window; never fabricate a quote by joining fragments. */
export function truncateEvidenceText(
  value: string,
  maxChars: number,
  focusText?: string,
): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, Math.floor(maxChars));
  if (!budget) return '';
  const focusTokens: string[] =
    focusText?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const focus = new Set(
    focusTokens.filter(
      (word) =>
        (word.length > 3 || /^\d+$/.test(word)) &&
        ![
          'what',
          'which',
          'does',
          'this',
          'that',
          'with',
          'from',
          'reel',
          'video',
          'statement',
        ].includes(word),
    ),
  );
  const opening =
    /\b(?:opening|first (?:statement|sentence)|beginning)\b/i.test(
      focusText ?? '',
    );
  const matches = [...text.matchAll(/[\p{L}\p{N}]+/gu)];
  let anchor = 0;
  let best = -1;
  if (!opening) {
    for (const match of matches) {
      const score =
        (focus.has(match[0].toLowerCase()) ? 3 : 0) +
        (/^\d/.test(match[0]) ? 1 : 0);
      if (score > best) {
        best = score;
        anchor = match.index ?? 0;
      }
    }
  }
  // Prefer complete request-matched clauses. In particular, do not end a
  // duration/range at "7 or" merely because its first number fits the prefix.
  let spanStart = 0;
  let bestSpan: { start: number; end: number; score: number } | undefined;
  for (const stop of text.matchAll(/[.!?](?=\s|$)/g)) {
    const spanEnd = (stop.index ?? 0) + 1;
    const words = new Set(
      text
        .slice(spanStart, spanEnd)
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    );
    const score = [...words].reduce(
      (sum, word) => sum + (focus.has(word) ? 3 : 0),
      0,
    );
    if (score > 0 && (!bestSpan || score > bestSpan.score))
      bestSpan = { start: spanStart, end: spanEnd, score };
    spanStart = spanEnd;
  }
  if (!opening && bestSpan && bestSpan.end - bestSpan.start <= budget) {
    let start = bestSpan.end <= budget ? 0 : Math.max(0, bestSpan.end - budget);
    if (start > 0 && text[start - 1] !== ' ')
      start = text.indexOf(' ', start) + 1;
    const end = Math.min(text.length, start + budget);
    const boundary = end < text.length ? text.lastIndexOf(' ', end) : end;
    return text.slice(start, boundary > start ? boundary : end).trim();
  }
  // Keep the prefix when it already contains the focus. Moving a near-full
  // window to a later sentence unnecessarily drops earlier source clauses.
  let start =
    anchor < budget ? 0 : Math.max(0, anchor - Math.floor(budget / 3));
  const sentenceStart = text.lastIndexOf('. ', anchor);
  if (start > 0 && sentenceStart >= start) start = sentenceStart + 2;
  if (start > 0 && text[start - 1] !== ' ')
    start = text.indexOf(' ', start) + 1;
  const end = Math.min(text.length, start + budget);
  const boundary = end < text.length ? text.lastIndexOf(' ', end) : end;
  return text.slice(start, boundary > start ? boundary : end).trim();
}

export function boundPromptText(value: unknown, maxChars: number): string {
  return truncatePromptText(typeof value === 'string' ? value : '', maxChars);
}

export function boundClaimMappings<T extends { claim: string }>(
  claims: T[],
  bounds: RagPromptBounds,
): T[] {
  return boundTextItems(
    claims,
    (claim) => claim.claim,
    (claim, text) => ({ ...claim, claim: text }),
    Math.min(bounds.maxClaims, claims.length),
    bounds.maxClaimChars,
    bounds.maxClaimsTotalChars,
  );
}

export function boundRecentMessages<T extends { content: string }>(
  messages: T[],
  bounds: RagPromptBounds,
): T[] {
  const selected: T[] = [];
  let totalChars = 0;
  for (const message of [...messages].reverse()) {
    if (selected.length >= bounds.maxRecentMessages) break;
    const content = truncatePromptText(
      message.content,
      bounds.maxRecentMessageChars,
    );
    const separatorChars = selected.length > 0 ? 1 : 0;
    if (
      totalChars + separatorChars + content.length >
      bounds.maxRecentTotalChars
    ) {
      const remaining =
        bounds.maxRecentTotalChars - totalChars - separatorChars;
      if (remaining < 80) break;
      selected.push({
        ...message,
        content: truncatePromptText(content, remaining),
      });
      break;
    }
    selected.push({ ...message, content });
    totalChars += separatorChars + content.length;
  }
  return selected.reverse();
}

export function boundTextItems<T>(
  items: T[],
  getText: (item: T) => string,
  setText: (item: T, text: string) => T,
  maxItems: number,
  maxItemChars: number,
  maxTotalChars: number,
  truncate: (value: string, maxChars: number) => string = truncatePromptText,
): T[] {
  const output: T[] = [];
  let totalChars = 0;
  for (const item of items.slice(0, maxItems)) {
    const text = truncate(getText(item), maxItemChars);
    const separatorChars = output.length > 0 ? 1 : 0;
    if (totalChars + separatorChars + text.length > maxTotalChars) {
      const remaining = maxTotalChars - totalChars - separatorChars;
      if (remaining < 80) break;
      output.push(setText(item, truncate(text, remaining)));
      break;
    }
    output.push(setText(item, text));
    totalChars += separatorChars + text.length;
  }
  return output;
}

export function boundEvidence(
  candidates: ReelContextSearchResult[],
  bounds: RagPromptBounds,
  options: {
    preserveTail?: boolean;
    focusText?: string;
    preserveReelCoverage?: boolean;
  } = {},
): ReelContextSearchResult[] {
  const truncate = options.focusText?.trim()
    ? (value: string, maxChars: number) =>
        truncateEvidenceText(value, maxChars, options.focusText)
    : options.preserveTail
      ? truncateEvidenceText
      : truncatePromptText;
  const filtered = candidates.filter(
    (candidate) =>
      candidate.evidenceType === 'METADATA' ||
      Boolean(candidate.evidenceText?.trim() || candidate.chunkText?.trim()),
  );
  const ordered = options.preserveReelCoverage
    ? prioritizeReelCoverage(filtered)
    : filtered;
  const bounded = boundTextItems(
    ordered,
    (candidate) =>
      candidate.evidenceText?.trim() ||
      (candidate.evidenceType === 'METADATA'
        ? candidate.chunkText.trim()
        : candidate.chunkText.trim()),
    (candidate, text) => ({
      ...candidate,
      evidenceText: text,
      retrievalText: text,
      chunkText: text,
    }),
    bounds.maxEvidenceItems,
    bounds.maxEvidenceTextChars,
    bounds.maxEvidenceTotalChars,
    truncate,
  );
  return bounded.map((candidate) => ({
    ...candidate,
    title: candidate.title
      ? truncatePromptText(candidate.title, bounds.maxEvidenceTitleChars)
      : candidate.title,
    description: candidate.description
      ? truncatePromptText(
          candidate.description,
          bounds.maxEvidenceDescriptionChars,
        )
      : candidate.description,
    tags: (candidate.tags ?? [])
      .slice(0, bounds.maxEvidenceTags)
      .map((tag) => truncatePromptText(tag, bounds.maxEvidenceTagChars)),
  }));
}

export function preserveReelCoverage(
  candidates: ReelContextSearchResult[],
  maxItems: number,
): ReelContextSearchResult[] {
  const ordered = prioritizeReelCoverage(candidates);
  const reelCount = new Set(candidates.map((candidate) => candidate.reelId))
    .size;
  return ordered.slice(0, Math.max(maxItems, reelCount));
}

function prioritizeReelCoverage(
  candidates: ReelContextSearchResult[],
): ReelContextSearchResult[] {
  const firstByReel = new Map<string, ReelContextSearchResult>();
  for (const candidate of candidates) {
    if (!firstByReel.has(candidate.reelId)) {
      firstByReel.set(candidate.reelId, candidate);
    }
  }
  if (firstByReel.size <= 1) return candidates;
  const first = [...firstByReel.values()];
  const firstIds = new Set(first.map((candidate) => candidate.chunkId));
  return [
    ...first,
    ...candidates.filter((candidate) => !firstIds.has(candidate.chunkId)),
  ];
}

/** Keep single-Reel prompts focused; multi-Reel prompts retain every source when sufficiency selects none. */
export function selectRagAnswerEvidenceIds(
  candidates: ReelContextSearchResult[],
  context: RagContextSufficiencyResult | undefined,
  route: Pick<RagChatRouteDecision, 'requiredEvidence'> | undefined,
  preserveReelCoverage = false,
): Set<string> {
  const supported = new Set(
    (context?.supportedEvidenceIds ?? []).filter(
      (value): value is string => typeof value === 'string',
    ),
  );
  if (supported.size > 0 && !preserveReelCoverage) return supported;

  const required = new Set(
    (route?.requiredEvidence ?? []).filter((value) => value !== 'NONE'),
  );
  const providerStatus = context?.diagnostics?.providerStatus;
  const all = new Set(candidates.map((_candidate, index) => `e${index}`));
  if (
    !context ||
    context.sufficient ||
    preserveReelCoverage ||
    (providerStatus !== 'SUCCESS' && providerStatus !== 'ERROR') ||
    required.size === 0
  ) {
    return all;
  }

  const topRequired = candidates.find((candidate) =>
    required.has(candidate.evidenceType ?? 'TRANSCRIPT'),
  );
  if (!topRequired) return all;

  const focused = new Set(
    candidates.flatMap((candidate, index) =>
      candidate.reelId === topRequired.reelId &&
      required.has(candidate.evidenceType ?? 'TRANSCRIPT')
        ? [`e${index}`]
        : [],
    ),
  );
  return focused.size > 0 ? focused : all;
}
