import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import type {
  RagChatRouteDecision,
  RagContextSufficiencyResult,
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

export function truncatePromptText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;
  const budget = Math.max(0, maxChars - 3);
  const boundary = normalized.lastIndexOf(' ', budget);
  return `${normalized.slice(0, boundary > Math.floor(budget * 0.6) ? boundary : budget).trim()}...`;
}

/**
 * Keep both ends of long evidence windows because a transcript fact may be
 * introduced near the beginning and qualified near the end of a chunk.
 */
export function truncateEvidenceText(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) return normalized;

  const marker = '...';
  const contentBudget = Math.max(2, maxChars - marker.length);
  const headBudget = Math.ceil(contentBudget * 0.6);
  const tailBudget = contentBudget - headBudget;
  const headCandidate = normalized.slice(0, headBudget);
  const headBoundary = headCandidate.lastIndexOf(' ');
  const head = (
    headBoundary > 0 ? headCandidate.slice(0, headBoundary) : headCandidate
  ).trimEnd();
  const tailCandidate = normalized.slice(-tailBudget);
  const tailBoundary = tailCandidate.indexOf(' ');
  const tail = (
    tailBoundary >= 0 ? tailCandidate.slice(tailBoundary + 1) : tailCandidate
  ).trimStart();
  return `${head}${marker}${tail}`;
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
  options: { preserveTail?: boolean } = {},
): ReelContextSearchResult[] {
  const bounded = boundTextItems(
    candidates,
    (candidate) =>
      candidate.evidenceText?.trim() ||
      (candidate.evidenceType === 'METADATA'
        ? candidate.chunkText.trim()
        : (candidate.retrievalText ?? candidate.chunkText).trim()),
    (candidate, text) => ({
      ...candidate,
      evidenceText: text,
      retrievalText: text,
      chunkText: text,
    }),
    bounds.maxEvidenceItems,
    bounds.maxEvidenceTextChars,
    bounds.maxEvidenceTotalChars,
    options.preserveTail ? truncateEvidenceText : truncatePromptText,
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

/**
 * Keep answer/revision prompts focused on the highest-ranked required-evidence
 * reel when semantic sufficiency is advisory but did not select evidence IDs.
 * The original prompt-local IDs remain stable for verifier and citation use.
 */
export function selectRagAnswerEvidenceIds(
  candidates: ReelContextSearchResult[],
  context: RagContextSufficiencyResult | undefined,
  route: Pick<RagChatRouteDecision, 'requiredEvidence'> | undefined,
): Set<string> {
  const supported = new Set(
    (context?.supportedEvidenceIds ?? []).filter(
      (value): value is string => typeof value === 'string',
    ),
  );
  if (supported.size > 0) return supported;

  const required = new Set(
    (route?.requiredEvidence ?? []).filter((value) => value !== 'NONE'),
  );
  const providerStatus = context?.diagnostics?.providerStatus;
  const all = new Set(candidates.map((_candidate, index) => `e${index}`));
  if (
    !context ||
    context.sufficient ||
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
