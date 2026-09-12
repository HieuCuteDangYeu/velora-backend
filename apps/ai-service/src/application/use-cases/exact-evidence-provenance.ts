export interface ExactEvidenceCandidate {
  evidenceType: 'TRANSCRIPT' | 'VISUAL' | 'METADATA';
  evidenceText: string;
}

export interface ExactEvidenceProvenance {
  supported: boolean;
  supportingEvidenceIndexes: number[];
}

/**
 * Structural fallback only: the complete answer must be an exact contiguous
 * source-token span after Unicode-aware whitespace/punctuation normalization.
 * It deliberately does not interpret the question, relations, synonyms,
 * numbers, units, or language-specific vocabulary.
 */
export function assessExactEvidenceProvenance(input: {
  answer: string;
  candidates: ExactEvidenceCandidate[];
}): ExactEvidenceProvenance {
  const answerTokens = tokens(input.answer);
  if (answerTokens.length === 0) {
    return { supported: false, supportingEvidenceIndexes: [] };
  }

  const supportingEvidenceIndexes = input.candidates.flatMap(
    (candidate, index) =>
      containsContiguous(tokens(candidate.evidenceText), answerTokens)
        ? [index]
        : [],
  );

  return {
    supported: supportingEvidenceIndexes.length > 0,
    supportingEvidenceIndexes,
  };
}

function tokens(value: string): string[] {
  return (
    value
      .normalize('NFKC')
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function containsContiguous(source: string[], expected: string[]): boolean {
  if (expected.length > source.length) return false;
  for (let start = 0; start <= source.length - expected.length; start += 1) {
    if (expected.every((token, offset) => source[start + offset] === token)) {
      return true;
    }
  }
  return false;
}
