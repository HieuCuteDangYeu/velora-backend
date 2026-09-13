const QUANTITY_QUESTION_PATTERN =
  /\b(?:how many|how much|how low|how high|how long|how old|number of|what (?:number|percentage|percent|year|date))\b/i;

const QUANTITY_RATIONALE_PATTERN =
  /\b(?:not enough|isn't enough|aren't enough|too (?:small|little|low)|(?:cannot|can't|won't|will not) (?:hold|store)|capacity)\b/i;

const EVIDENCE_REFUSAL_PATTERN =
  /^(?:I\s+(?:do not|don't|cannot|can't|could not|couldn't|am unable to)\b|(?:the|this)\s+(?:transcript|audio|ASR|evidence)\s+(?:is|was)\s+(?:too\s+)?(?:garbled|unclear|unreadable|insufficient)\b)/i;

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
    return 'Answer model omitted a directly supported quantity';
  }

  if (
    input.evidenceRequired &&
    unsupportedDistinctiveTokens(input.evidence, answer).length > 0
  ) {
    return 'Answer model introduced an unsupported distinctive token';
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
  return [...answerQuantities].some((value) => evidenceQuantities.has(value));
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

function normalizeDistinctiveToken(value: string): string {
  const normalized = value.normalize('NFKC').toLocaleUpperCase();
  return normalized.endsWith('S') && normalized.length >= 3
    ? normalized.slice(0, -1)
    : normalized;
}
