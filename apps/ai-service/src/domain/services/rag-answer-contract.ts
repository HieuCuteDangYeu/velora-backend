import type { RagReelQuestionType } from '@ai/domain/interfaces/rag-chat-workflow.interface';

const QUANTITY_QUESTION_PATTERN =
  /\b(?:how many|how much|how low|how high|how long|how old|number of|what (?:number|percentage|percent|year|date))\b/i;

const QUANTITY_RATIONALE_PATTERN =
  /\b(?:not enough|isn't enough|aren't enough|too (?:small|little|low)|(?:cannot|can't|won't|will not) (?:hold|store)|capacity)\b/i;

const LOW_QUANTITY_QUESTION_PATTERN = /\bhow low\b/i;
const HIGH_QUANTITY_QUESTION_PATTERN = /\bhow high\b/i;
const LOW_QUANTITY_EVIDENCE_PATTERN =
  /\b(?:down(?:\s+(?:to|till))?|as\s+low\s+as|minimum(?:\s+of)?)\b[^.!?\n]{0,96}/gi;
const HIGH_QUANTITY_EVIDENCE_PATTERN =
  /\b(?:up(?:\s+to)?|as\s+high\s+as|maximum(?:\s+of)?)\b[^.!?\n]{0,96}/gi;

const EXACT_VALUE_QUESTION_PATTERN =
  /\bwhat\b[^?\n]*\b(?:label|name|code|term|word)\b/i;

const EVIDENCE_REFUSAL_PATTERN =
  /^(?:I\s+(?:do not|don't|cannot|can't|could not|couldn't|am unable to)\b|(?:the|this)\s+(?:transcript|audio|ASR|evidence)\s+(?:is|was)\s+(?:too\s+)?(?:garbled|unclear|unreadable|insufficient)\b)/i;

const QUESTION_ECHO_QUESTION_PATTERN = /\b(?:what|where|which|why|how)\b/i;

const QUESTION_ECHO_STOPWORDS = new Set([
  'a',
  'about',
  'an',
  'and',
  'are',
  'at',
  'be',
  'because',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'have',
  'how',
  'in',
  'into',
  'is',
  'it',
  'of',
  'on',
  'or',
  'say',
  'says',
  'that',
  'the',
  'their',
  'they',
  'this',
  'to',
  'under',
  'up',
  'used',
  'was',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'whose',
  'why',
  'with',
]);

const NUMBER_WORD_VALUES = new Map<string, string>([
  ['zero', '0'],
  ['one', '1'],
  ['two', '2'],
  ['three', '3'],
  ['four', '4'],
  ['five', '5'],
  ['six', '6'],
  ['seven', '7'],
  ['eight', '8'],
  ['nine', '9'],
  ['ten', '10'],
  ['eleven', '11'],
  ['twelve', '12'],
  ['thirteen', '13'],
  ['fourteen', '14'],
  ['fifteen', '15'],
  ['sixteen', '16'],
  ['seventeen', '17'],
  ['eighteen', '18'],
  ['nineteen', '19'],
  ['twenty', '20'],
  ['thirty', '30'],
  ['forty', '40'],
  ['fifty', '50'],
  ['sixty', '60'],
  ['seventy', '70'],
  ['eighty', '80'],
  ['ninety', '90'],
  ['hundred', '100'],
  ['thousand', '1000'],
]);

export interface RagAnswerContractInput {
  answer: string;
  question: string;
  evidence: readonly string[];
  evidenceRequired: boolean;
}

export type RagAnswerShape = 'SHORT_FACT' | 'EXPLANATION' | 'SUMMARY';

export interface RagAnswerBudget {
  shape: RagAnswerShape;
  maxChars: number;
}

export function ragAnswerBudget(
  reelQuestionType: RagReelQuestionType | undefined,
): RagAnswerBudget {
  if (reelQuestionType === 'GENERAL_REEL_SUMMARY') {
    return { shape: 'SUMMARY', maxChars: 1_400 };
  }
  if (reelQuestionType === 'REEL_METADATA') {
    return { shape: 'SHORT_FACT', maxChars: 360 };
  }
  return { shape: 'EXPLANATION', maxChars: 900 };
}

export function ragAnswerDirectnessIssue(
  answer: string,
  budget: RagAnswerBudget,
): string | undefined {
  const { shape, maxChars } = budget;
  if (answer.trim().length <= maxChars) return undefined;
  return `${shape} answer exceeds the ${maxChars}-character direct-answer budget`;
}

/**
 * Validates only bounded, semantics-preserving answer invariants. It does not
 * require literal answer/evidence overlap; the semantic verifier remains the
 * authority for ordinary paraphrases and claim support.
 */
export function validateRagAnswerContract(
  input: RagAnswerContractInput,
): string | undefined {
  const answer = input.answer.trim();
  if (!answer) return 'Answer model returned an empty answer';

  if (input.evidenceRequired && EVIDENCE_REFUSAL_PATTERN.test(answer)) {
    return 'Answer model returned an evidence-dependent refusal';
  }

  if (!hasSupportedQuantity(input.question, input.evidence, answer)) {
    return 'Answer model used a quantity unsupported by the requested relation';
  }

  if (!hasSupportedRequestedValue(input.question, input.evidence, answer)) {
    return 'Answer model introduced an unsupported requested label or name';
  }

  if (
    input.evidenceRequired &&
    unsupportedDistinctiveTokens(input.evidence, answer).length > 0
  ) {
    return 'Answer model introduced an unsupported distinctive token';
  }

  if (
    input.evidenceRequired &&
    isQuestionVocabularyEcho(input.question, input.evidence, answer)
  ) {
    return 'Answer model repeated the question without an evidence-bearing fact';
  }

  return undefined;
}

function hasSupportedQuantity(
  question: string,
  evidence: readonly string[],
  answer: string,
): boolean {
  const evidenceQuantities = quantityTokens(evidence.join(' '));
  if (evidenceQuantities.size === 0) return true;

  const requiresQuantity =
    QUANTITY_QUESTION_PATTERN.test(question) ||
    QUANTITY_RATIONALE_PATTERN.test(question);
  if (!requiresQuantity) return true;

  const answerQuantities = quantityTokens(answer);
  const relationEvidenceQuantities = directionalQuantityTokens(
    question,
    evidence.join(' '),
  );
  if (relationEvidenceQuantities.size === 0) {
    return [...answerQuantities].some((value) => evidenceQuantities.has(value));
  }

  const relationAnswerQuantities = directionalQuantityTokens(question, answer);
  const quantitiesToCheck =
    relationAnswerQuantities.size > 0
      ? relationAnswerQuantities
      : answerQuantities;
  return [...quantitiesToCheck].some((value) =>
    relationEvidenceQuantities.has(value),
  );
}

function directionalQuantityTokens(
  question: string,
  value: string,
): Set<string> {
  const pattern = LOW_QUANTITY_QUESTION_PATTERN.test(question)
    ? LOW_QUANTITY_EVIDENCE_PATTERN
    : HIGH_QUANTITY_QUESTION_PATTERN.test(question)
      ? HIGH_QUANTITY_EVIDENCE_PATTERN
      : undefined;
  if (!pattern) return new Set<string>();

  pattern.lastIndex = 0;
  return new Set(
    [...value.matchAll(pattern)].flatMap((match) => [
      ...quantityTokens(match[0]),
    ]),
  );
}

function hasSupportedRequestedValue(
  question: string,
  evidence: readonly string[],
  answer: string,
): boolean {
  if (!EXACT_VALUE_QUESTION_PATTERN.test(question)) return true;

  const questionTokens = new Set(answerContentTokens(question));
  const evidenceTokens = new Set(
    evidence.flatMap((value) => answerContentTokens(value)),
  );
  const primaryAnswer = answer.split(/[.!?\n]/, 1)[0] ?? answer;
  return answerContentTokens(primaryAnswer).some(
    (token) => !questionTokens.has(token) && evidenceTokens.has(token),
  );
}

function quantityTokens(value: string): Set<string> {
  const tokens: string[] =
    value.toLowerCase().match(/[a-z]+|\d+(?:[.,]\d+)?/g) ?? [];
  return new Set<string>(
    tokens.flatMap((token): string[] => {
      const wordValue = NUMBER_WORD_VALUES.get(token);
      if (wordValue) return [wordValue];
      if (/^\d/.test(token)) return [token.replace(/,/g, '')];
      return [];
    }),
  );
}

function unsupportedDistinctiveTokens(
  evidence: readonly string[],
  answer: string,
): string[] {
  const allowed = new Set(
    evidence
      .flatMap((value) => distinctiveTokens(value))
      .map(normalizeDistinctiveToken),
  );

  return distinctiveTokens(answer).filter(
    (token) => !allowed.has(normalizeDistinctiveToken(token)),
  );
}

function isQuestionVocabularyEcho(
  question: string,
  evidence: readonly string[],
  answer: string,
): boolean {
  if (answer.length < 20 || !QUESTION_ECHO_QUESTION_PATTERN.test(question)) {
    return false;
  }

  const questionTokens = new Set(answerContentTokens(question));
  const evidenceTokens = new Set(
    evidence.flatMap((value) => answerContentTokens(value)),
  );
  const answerTokens = answerContentTokens(answer);
  if (answerTokens.length === 0) return false;

  const evidenceBearingAnswerTokens = answerTokens.filter(
    (token) => !questionTokens.has(token) && evidenceTokens.has(token),
  );
  return evidenceBearingAnswerTokens.length === 0;
}

function distinctiveTokens(value: string): string[] {
  return (value.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*/gu) ?? []).filter(
    (token) => {
      const uppercaseLetters = [...token].filter(
        (character) =>
          character.toLocaleUpperCase() === character &&
          character.toLocaleLowerCase() !== character,
      ).length;
      return uppercaseLetters >= 2 || /\d/.test(token);
    },
  );
}

export function answerContentTokens(value: string): string[] {
  const tokens: string[] =
    value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens
    .filter((token) => !QUESTION_ECHO_STOPWORDS.has(token))
    .map((token: string) =>
      token.endsWith('s') && token.length >= 3 ? token.slice(0, -1) : token,
    );
}

function normalizeDistinctiveToken(value: string): string {
  const normalized = value.normalize('NFKC').toLocaleUpperCase();
  return normalized.endsWith('S') && normalized.length >= 3
    ? normalized.slice(0, -1)
    : normalized;
}
