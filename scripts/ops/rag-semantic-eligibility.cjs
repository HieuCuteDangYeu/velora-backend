'use strict';

const {
  DIMENSIONS,
  applicability,
} = require('./rag-evaluation-applicability.cjs');

function hasAnswer(output) {
  return typeof output?.answer === 'string' && output.answer.trim().length > 0;
}

function hasQuestion(item) {
  return (
    typeof item?.input?.question === 'string' &&
    item.input.question.trim().length > 0
  );
}

function hasReference(item) {
  const expected = item?.expectedOutput || {};
  const values =
    Array.isArray(expected.acceptedAnswers) &&
    expected.acceptedAnswers.length > 0
      ? expected.acceptedAnswers
      : [expected.answer, expected.referenceAnswer];
  return (Array.isArray(values) ? values : [values]).some(
    (value) => typeof value === 'string' && value.trim().length > 0,
  );
}

function hasCapturedContext(output) {
  return (
    output?.contextCaptureStatus === 'CAPTURED' &&
    Array.isArray(output.generationEvidence)
  );
}

function dimensionAvailability(item, output) {
  const applies = applicability(item);
  const answerAvailable = hasAnswer(output);
  const questionAvailable = hasQuestion(item);
  const referenceAvailable = hasReference(item);
  const contextAvailable = hasCapturedContext(output);

  return Object.fromEntries(
    DIMENSIONS.map((dimension) => {
      if (!applies[dimension]) return [dimension, 'NOT_APPLICABLE'];
      if (dimension === 'responseRelevancy' && !questionAvailable)
        return [dimension, 'QUESTION_MISSING'];
      if (
        (dimension === 'responseRelevancy' ||
          dimension === 'factualCorrectness' ||
          dimension === 'faithfulness') &&
        !answerAvailable
      )
        return [dimension, 'ANSWER_MISSING'];
      if (
        (dimension === 'factualCorrectness' ||
          dimension === 'contextCompleteness') &&
        !referenceAvailable
      )
        return [dimension, 'REFERENCE_MISSING'];
      if (
        (dimension === 'faithfulness' || dimension === 'contextCompleteness') &&
        !contextAvailable
      )
        return [dimension, 'GENERATION_CONTEXT_NOT_CAPTURED'];
      return [dimension, 'AVAILABLE'];
    }),
  );
}

module.exports = {
  dimensionAvailability,
  hasAnswer,
  hasCapturedContext,
  hasQuestion,
  hasReference,
};
