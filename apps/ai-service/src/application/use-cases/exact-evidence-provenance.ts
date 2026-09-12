export interface ExactEvidenceCandidate {
  evidenceType: 'TRANSCRIPT' | 'VISUAL' | 'METADATA';
  evidenceText: string;
}

export interface ExactEvidenceProvenance {
  supported: boolean;
  supportingEvidenceIndexes: number[];
}

const MAX_COMBINED_EVIDENCE_CANDIDATES = 3;

/**
 * Structural fallback only: the complete answer must be an exact contiguous
 * source-token span (possibly across a small ordered set of source windows)
 * after Unicode-aware whitespace/punctuation normalization. It deliberately
 * does not interpret the question, relations, synonyms, numbers, units, or
 * language-specific vocabulary.
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

  if (supportingEvidenceIndexes.length > 0) {
    return {
      supported: true,
      supportingEvidenceIndexes,
    };
  }

  // Extractive fallbacks may join a small number of complete, ordered source
  // windows. Treat that as exact provenance too, while keeping the check
  // bounded and preserving the source order. This does not infer relations or
  // semantics; it only recognizes an answer copied from authorized evidence.
  const candidateTokens = input.candidates.map((candidate) =>
    tokens(candidate.evidenceText),
  );
  for (let start = 0; start < candidateTokens.length; start += 1) {
    const combined: string[] = [];
    const endLimit = Math.min(
      candidateTokens.length,
      start + MAX_COMBINED_EVIDENCE_CANDIDATES,
    );
    for (let end = start; end < endLimit; end += 1) {
      combined.push(...candidateTokens[end]);
      if (containsContiguous(combined, answerTokens)) {
        return {
          supported: true,
          supportingEvidenceIndexes: Array.from(
            { length: end - start + 1 },
            (_value, offset) => start + offset,
          ),
        };
      }
    }
  }

  return {
    supported: false,
    supportingEvidenceIndexes: [],
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
