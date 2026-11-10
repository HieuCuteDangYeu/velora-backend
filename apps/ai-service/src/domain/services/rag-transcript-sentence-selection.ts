import type {
  RagChatRouteDecision,
  RagGenerationEvidence,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

export function isTranscriptSentenceSelectionRequest(
  route:
    | Pick<
        RagChatRouteDecision,
        'intent' | 'requiredEvidence' | 'transcriptRequestKind'
      >
    | undefined,
): boolean {
  return (
    route?.intent === 'REEL_VIDEO_QUESTION' &&
    route.requiredEvidence?.includes('TRANSCRIPT') === true &&
    route.transcriptRequestKind === 'FIRST_COMPLETE_UTTERANCE'
  );
}

export function startsInsidePriorTranscriptSentence(
  span: string,
  priorTranscript: string,
): boolean {
  const normalize = (value: string) =>
    value
      .normalize('NFKC')
      .replace(/[’‘]/g, "'")
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .toLocaleLowerCase();
  const needle = normalize(span).trim();
  const context = normalize(priorTranscript);
  if (!needle || !context) return false;

  let cursor = 0;
  let continuationCount = 0;
  let sentenceStartCount = 0;
  while (cursor < context.length) {
    const index = context.indexOf(needle, cursor);
    if (index < 0) break;
    const preceding = context.slice(0, index);
    const boundary = Math.max(
      preceding.lastIndexOf('.'),
      preceding.lastIndexOf('?'),
      preceding.lastIndexOf('!'),
      preceding.lastIndexOf('\n'),
    );
    const sentencePrefix = preceding.slice(boundary + 1, index).trim();
    if (
      sentencePrefix &&
      !/^(?:and|but|for|nor|or|so|yet)$/iu.test(sentencePrefix)
    ) {
      continuationCount += 1;
    } else {
      sentenceStartCount += 1;
    }
    cursor = index + needle.length;
  }
  return continuationCount > 0 && sentenceStartCount === 0;
}

export function selectTimestampTranscriptEvidence<
  T extends RagGenerationEvidence,
>(
  evidence: T[],
  plan: Pick<RagRetrievalPlan, 'sourceTimestampSec' | 'sourceTimestampEndSec'>,
): T | undefined {
  const start = plan.sourceTimestampSec;
  if (start === undefined) return undefined;
  const end = plan.sourceTimestampEndSec ?? start;
  const transcript = evidence.filter(
    (item) =>
      item.evidenceType === 'TRANSCRIPT' &&
      typeof item.startTime === 'number' &&
      typeof item.endTime === 'number',
  );
  const coveringRange = transcript.filter(
    (item) => item.startTime! <= start && item.endTime! >= end,
  );
  const coveringPoint = transcript.filter(
    (item) => item.startTime! <= start && item.endTime! >= start,
  );
  return [...(coveringRange.length ? coveringRange : coveringPoint)].sort(
    (left, right) =>
      Math.abs(left.startTime! - start) - Math.abs(right.startTime! - start) ||
      left.endTime! - right.endTime!,
  )[0];
}

// A full stop after one of these does not end a sentence ("Mr. Darius, ...").
const NON_TERMINAL_ABBREVIATION =
  /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Mt|vs)\.$/i;

export function transcriptSentenceSpans(text: string): string[] {
  const spans: string[] = [];
  for (const raw of text.split(/(?<=[.!?])\s+|\n+/)) {
    const span = raw.trim();
    if (!span) continue;
    const previous = spans[spans.length - 1];
    if (previous && NON_TERMINAL_ABBREVIATION.test(previous)) {
      spans[spans.length - 1] = `${previous} ${span}`;
    } else {
      spans.push(span);
    }
  }
  // Drop fragments with no letters or digits, such as the stray "." that ASR leaves at the start of a chunk.
  return spans.filter((span) => /[\p{L}\p{N}]/u.test(span));
}

export function firstCompleteTranscriptSentenceCandidate(
  text: string,
  priorTranscript?: string,
): string | undefined {
  return transcriptSentenceSpans(text).find((span, index) => {
    if (
      hasIncompleteTranscriptEnding(span) ||
      isLikelyIncompleteTranscriptUtterance(span)
    ) {
      return false;
    }
    const continuesBeforeWindow =
      index === 0 &&
      Boolean(
        priorTranscript &&
          startsInsidePriorTranscriptSentence(span, priorTranscript),
      );
    const completeUtteranceStart =
      isShortTerminalTranscriptUtterance(span) ||
      /^please,\s+\p{L}/iu.test(span) ||
      /^(?:i|you|we|they|he|she|it)(?:['’](?:m|re|ve|ll|d))?\s+\p{L}/iu.test(
        span,
      );
    return !continuesBeforeWindow || completeUtteranceStart;
  });
}

export function isLikelyIncompleteTranscriptUtterance(text: string): boolean {
  const normalized = text.normalize('NFKC').trim();
  if (hasIncompleteTranscriptEnding(normalized)) return true;
  const span = normalized.replace(/[.!?。！？]+$/u, '').trim();
  const words = span.match(/[\p{L}\p{N}]+/gu) ?? [];
  const firstWord = words[0]?.toLocaleLowerCase() ?? '';
  if (/^(?:i|you|we|they|he|she|it)$/iu.test(span)) return true;
  const auxiliary = /^(?:i|you|we|they|he|she|it)(?:['’](?:ll|d|ve|re)|\s+(?:will|would|could|should|can|may|might|must))\s+/iu;
  const match = auxiliary.exec(span);
  if (
    match &&
    /^(?:(?:of|to|from|in|on|at|for|by|with)\s+)?(?:a|an|the|my|your|his|her|their|our|this|that|these|those)\b/iu.test(
      span.slice(match[0].length),
    )
  ) {
    return true;
  }
  if (
    /^[\p{L}]+ing\s+(?:if|whether|what|who|where|when|why|how)\b/iu.test(
      span,
    ) ||
    /^(?:is|are|was|were|has|have|does|did)\s+(?:a|an|the|this|that|these|those)\b/iu.test(
      span,
    ) ||
    /^[\p{L}]+ly\s+[\p{L}]+(?:ed|en)\b/iu.test(span)
  ) {
    return true;
  }

  const lowerStart = /^\p{Ll}/u.test(span);
  const terminalPeriod = /[.。]$/u.test(normalized);
  const bareDeterminerPhrase =
    terminalPeriod &&
    words.length === 2 &&
    /^(?:a|an|the|my|your|his|her|their|our|this|that|these|those)$/iu.test(
      firstWord,
    );
  if (bareDeterminerPhrase) return true;
  const hasSubjectOrPredicateSignal =
    /^(?:i|you|we|they|he|she|it)\b/iu.test(span) ||
    /\b(?:am|is|are|was|were|has|have|had|do|does|did|can|could|will|would|should|may|might|must)\b/iu.test(
      span,
    ) ||
    words.some((word) => /(?:ed|ing|s)$/iu.test(word));
  // shortcut: simple fragment shapes only; use a syntax parser if source review finds false exclusions.
  return (
    terminalPeriod &&
    !span.includes(',') &&
    words.length > 1 &&
    words.length <= 3 &&
    !hasSubjectOrPredicateSignal &&
    lowerStart
  );
}

export function isShortTerminalTranscriptUtterance(span: string): boolean {
  const normalized = span
    .normalize('NFKC')
    .trim()
    .replace(/["'’”»)\]}]+$/u, '')
    .trim();
  const wordCount = normalized.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return (
    wordCount === 1 &&
    /[!?！？]$/u.test(normalized) &&
    !hasIncompleteTranscriptEnding(normalized)
  );
}

export function hasIncompleteTranscriptEnding(text: string): boolean {
  const tail = text
    .normalize('NFKC')
    .trim()
    .replace(/["'’”»)\]}]+$/u, '')
    .trim();
  if (!tail) return false;
  if (/\.{3}$|…$/u.test(tail)) return true;
  return !/[.!?。！？]$/u.test(tail);
}

export function hasUnsupportedTranscriptTailCompletion(
  answer: string,
  evidenceText: string,
): boolean {
  if (!answer.trim() || !hasIncompleteTranscriptEnding(evidenceText)) return false;
  const source = evidenceText
    .normalize('NFKC')
    .trim()
    .replace(/["'’”»)\]}]+$/u, '')
    .trim();
  const boundary = Math.max(
    source.lastIndexOf('.'),
    source.lastIndexOf('?'),
    source.lastIndexOf('!'),
    source.lastIndexOf('\n'),
  );
  const tail = source.slice(boundary + 1).trim();
  if (!tail) return false;
  const escapedTail = tail.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const matches = new RegExp(
    `(^|[^\\p{L}\\p{N}])(${escapedTail})(?=$|[^\\p{L}\\p{N}])`,
    'giu',
  );
  for (const match of answer.matchAll(matches)) {
    const fragmentStart = match.index! + match[1].length;
    const afterFragment = answer.slice(fragmentStart + match[2].length);
    if (/^\s*["'’”]/u.test(afterFragment)) continue;
    const afterInSentence = afterFragment.split(/[.!?。！？\n]/u, 1)[0];
    if (!/\p{L}/u.test(afterInSentence)) continue;
    const prefixBoundary = Math.max(
      answer.lastIndexOf('.', fragmentStart),
      answer.lastIndexOf('?', fragmentStart),
      answer.lastIndexOf('!', fragmentStart),
      answer.lastIndexOf('\n', fragmentStart),
    );
    const prefix = answer.slice(prefixBoundary + 1, fragmentStart);
    if (
      /\b(?:transcript|excerpt|segment|text)\s+(?:ends?|stops?|finishes?)\s+(?:with|at)\s*$/iu.test(
        prefix,
      ) &&
      /^\s*,?\s*(?:(?:at\s+(?:the\s+)?(?:end|boundary))|(?:as\s+(?:the\s+)?(?:last|final)\s+(?:word|fragment))|(?:(?:the\s+)?(?:last|final|clipped|trailing)\s+(?:word|fragment|utterance)))\b/iu.test(
        afterFragment,
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
}

export function isNearVerbatimTranscriptSummary(
  answer: string,
  evidenceText: string,
): boolean {
  const answerTokens: string[] = answer
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  const sourceTokens: string[] = evidenceText
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [];
  if (answerTokens.length < 16 || sourceTokens.length < 20) return false;

  let previous = new Array<number>(sourceTokens.length + 1).fill(0);
  let longestMatch = 0;
  for (const token of answerTokens) {
    const current = new Array<number>(sourceTokens.length + 1).fill(0);
    for (let sourceIndex = 1; sourceIndex <= sourceTokens.length; sourceIndex++) {
      if (token !== sourceTokens[sourceIndex - 1]) continue;
      current[sourceIndex] = previous[sourceIndex - 1] + 1;
      longestMatch = Math.max(longestMatch, current[sourceIndex]);
    }
    previous = current;
  }
  const answerCoverage = longestMatch / answerTokens.length;
  const sourceCoverage = longestMatch / sourceTokens.length;
  const answerSourceLength = answerTokens.length / sourceTokens.length;
  // shortcut: token-order overlap only, replace if paraphrase false positives appear.
  return (
    answerCoverage >= 0.75 &&
    sourceCoverage >= 0.65 &&
    answerSourceLength >= 0.75
  );
}

export function transcriptFallbackSpans(
  text: string,
  question: string,
): string[] {
  const sentences = transcriptSentenceSpans(text);
  if (!/\b(?:why|reason|because)\b/i.test(question)) return sentences;
  return sentences.flatMap((sentence) =>
    sentence
      .split(/\s+(?=(?:because|since|so|therefore)\b)/i)
      .map((span) => span.trim())
      .filter(Boolean),
  );
}
