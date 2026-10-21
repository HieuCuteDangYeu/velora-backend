'use strict';

function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function referenceAnswers(expectedOutput) {
  const accepted =
    Array.isArray(expectedOutput?.acceptedAnswers) &&
    expectedOutput.acceptedAnswers.length
      ? expectedOutput.acceptedAnswers
      : [expectedOutput?.answer, expectedOutput?.referenceAnswer];
  return accepted
    .filter((answer) => typeof answer === 'string')
    .map((answer) => answer.trim())
    .filter(Boolean);
}

function tokenF1(answer, reference) {
  const answerTokens = normalizeAnswer(answer).split(/\s+/).filter(Boolean);
  const referenceTokens = normalizeAnswer(reference)
    .split(/\s+/)
    .filter(Boolean);
  if (!answerTokens.length || !referenceTokens.length) return 0;

  const remaining = new Map();
  for (const token of referenceTokens)
    remaining.set(token, (remaining.get(token) || 0) + 1);
  let overlap = 0;
  for (const token of answerTokens) {
    const count = remaining.get(token) || 0;
    if (!count) continue;
    overlap += 1;
    remaining.set(token, count - 1);
  }
  const precision = overlap / answerTokens.length;
  const recall = overlap / referenceTokens.length;
  return precision + recall === 0
    ? 0
    : (2 * precision * recall) / (precision + recall);
}

function answerOverlapMetrics(answer, expectedOutput) {
  const references = referenceAnswers(expectedOutput);
  if (!references.length)
    return { exactMatch: null, containment: null, tokenF1: null };

  const normalizedAnswer = normalizeAnswer(answer);
  const normalizedReferences = references.map(normalizeAnswer);
  return {
    exactMatch: Number(
      normalizedReferences.some((ref) => ref === normalizedAnswer),
    ),
    containment: Number(
      normalizedReferences.some((ref) => ref && normalizedAnswer.includes(ref)),
    ),
    tokenF1: Math.max(
      ...references.map((reference) => tokenF1(answer, reference)),
    ),
  };
}

module.exports = {
  answerOverlapMetrics,
  normalizeAnswer,
  referenceAnswers,
  tokenF1,
};
