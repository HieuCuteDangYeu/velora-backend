import type {
  RagChatRouteDecision,
  RagGenerationEvidence,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

const AUXILIARIES = new Set([
  'am',
  'is',
  'are',
  'was',
  'were',
  'be',
  'being',
  'been',
  'has',
  'have',
  'had',
  'do',
  'does',
  'did',
  'can',
  'could',
  'will',
  'would',
  'shall',
  'should',
  'may',
  'might',
  'must',
]);
const SUBJECT_PRONOUNS = new Set([
  'i',
  'you',
  'he',
  'she',
  'it',
  'we',
  'they',
  'this',
  'that',
  'these',
  'those',
]);
const WH_WORDS = new Set(['what', 'who', 'where', 'when', 'why', 'how']);
const SUBORDINATORS = new Set([
  'although',
  'because',
  'before',
  'if',
  'once',
  'since',
  'though',
  'unless',
  'until',
  'when',
  'whereas',
  'while',
]);
const DETERMINERS = new Set([
  'a',
  'an',
  'her',
  'his',
  'its',
  'my',
  'our',
  'the',
  'their',
  'these',
  'this',
  'those',
  'that',
  'your',
]);
const STANDALONE_UTTERANCES = new Set([
  'ah',
  'alright',
  'come',
  'fine',
  'go',
  'good',
  'great',
  'hello',
  'help',
  'hey',
  'hi',
  'huh',
  'listen',
  'look',
  'meow',
  'no',
  'nope',
  'oh',
  'ok',
  'okay',
  'right',
  'stop',
  'thanks',
  'wait',
  'what',
  'yes',
  'yeah',
  'yep',
  'yup',
  'woof',
]);
const NON_VERB_MODAL_COMPLEMENTS = new Set([
  'a',
  'an',
  'for',
  'from',
  'her',
  'his',
  'in',
  'it',
  'my',
  'never',
  'no',
  'not',
  'of',
  'on',
  'our',
  'the',
  'their',
  'to',
  'with',
  'your',
]);
const COMMON_IRREGULAR_VERBS = new Set([
  'became',
  'began',
  'bought',
  'brought',
  'came',
  'caught',
  'did',
  'felt',
  'found',
  'gave',
  'got',
  'grew',
  'heard',
  'held',
  'kept',
  'knew',
  'left',
  'lost',
  'made',
  'met',
  'paid',
  'put',
  'ran',
  'read',
  'said',
  'saw',
  'sat',
  'sold',
  'spoke',
  'stood',
  'thought',
  'told',
  'took',
  'went',
  'won',
  'wrote',
]);

function words(text: string): string[] {
  return (
    text
      .normalize('NFKC')
      .replace(/[’‘]/g, "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)?/gu)
      ?.map((word) => word.toLowerCase()) ?? []
  );
}

function isFiniteVerb(word: string): boolean {
  return (
    AUXILIARIES.has(word) ||
    COMMON_IRREGULAR_VERBS.has(word) ||
    /(?:ed|s)$/.test(word)
  );
}

function startsSubordinateClause(sentenceWords: string[]): boolean {
  return (
    SUBORDINATORS.has(sentenceWords[0]) ||
    (sentenceWords[0] === 'as' && sentenceWords[1] !== 'for')
  );
}

function hasClearIndependentClause(text: string): boolean {
  const sentenceWords = words(text);
  if (sentenceWords.length === 0) return false;
  if (startsSubordinateClause(sentenceWords)) return false;
  if (
    sentenceWords.length === 1 &&
    STANDALONE_UTTERANCES.has(sentenceWords[0])
  ) {
    return true;
  }
  const contractedSubject =
    /^(?:i|you|he|she|it|we|they)('m|'re|'s|'ve|'ll|'d)\b/i.exec(
      text.trim().replace(/[’‘]/g, "'"),
    );
  if (contractedSubject && sentenceWords.length > 1) {
    const following = sentenceWords[1];
    if (
      ["'ll", "'d"].includes(contractedSubject[1].toLowerCase()) &&
      NON_VERB_MODAL_COMPLEMENTS.has(following)
    ) {
      return false;
    }
    return true;
  }
  if (
    WH_WORDS.has(sentenceWords[0]) &&
    (AUXILIARIES.has(sentenceWords[1]) || isFiniteVerb(sentenceWords[1] ?? ''))
  ) {
    return true;
  }
  if (SUBORDINATORS.has(sentenceWords[0])) return false;

  if (
    SUBJECT_PRONOUNS.has(sentenceWords[0]) &&
    sentenceWords.slice(1, 5).some(isFiniteVerb)
  ) {
    return true;
  }

  return sentenceWords.some((word, index) => {
    if (
      index === 0 ||
      !AUXILIARIES.has(word) ||
      sentenceWords[index - 1] === 'to'
    )
      return false;
    return sentenceWords
      .slice(0, index)
      .some((subject) => !DETERMINERS.has(subject));
  });
}

function isClearlyIncompleteSentence(text: string): boolean {
  const sentenceWords = words(text);
  if (sentenceWords.length < 2 || hasClearIndependentClause(text)) return false;
  if (startsSubordinateClause(sentenceWords)) return true;
  if (DETERMINERS.has(sentenceWords[0]) && sentenceWords.length >= 3)
    return true;
  if (/^(?:[A-Z][\p{L}'-]*\s+){1,3}[A-Z][\p{L}'-]*\.$/u.test(text.trim())) {
    return true;
  }
  return /^(?:too|so|very|quite)\s+[\p{L}'-]+[.!]$/iu.test(text.trim());
}

export function reconcileTranscriptSentenceCandidate(
  candidates: Array<{ candidateId: string; text: string }>,
  selectedCandidateId: string,
): string {
  const selectedIndex = candidates.findIndex(
    (candidate) => candidate.candidateId === selectedCandidateId,
  );
  if (selectedIndex < 0) return selectedCandidateId;

  const earlierComplete = candidates
    .slice(0, selectedIndex)
    .find((candidate) => hasClearIndependentClause(candidate.text));
  if (earlierComplete) return earlierComplete.candidateId;

  if (isClearlyIncompleteSentence(candidates[selectedIndex].text)) {
    const nextComplete = candidates
      .slice(selectedIndex + 1)
      .find((candidate) => hasClearIndependentClause(candidate.text));
    if (nextComplete) return nextComplete.candidateId;
  }

  return selectedCandidateId;
}

export function isTranscriptSentenceSelectionRequest(
  route: Pick<RagChatRouteDecision, 'intent' | 'requiredEvidence'> | undefined,
  question: string,
): boolean {
  return (
    route?.intent === 'REEL_VIDEO_QUESTION' &&
    route.requiredEvidence?.includes('TRANSCRIPT') === true &&
    /\b(?:first complete sentence|first (?:statement|sentence)|opening statement)\b/i.test(
      question,
    )
  );
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

export function transcriptSentenceSpans(
  text: string,
  question: string,
): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((span) => span.trim())
    .filter(Boolean);
  if (!/\b(?:why|reason|because)\b/i.test(question)) return sentences;

  return sentences.flatMap((sentence) =>
    sentence
      .split(/\s+(?=(?:because|since|so|therefore)\b)/i)
      .map((span) => span.trim())
      .filter(Boolean),
  );
}
