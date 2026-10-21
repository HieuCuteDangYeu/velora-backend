'use strict';

const DIMENSIONS = [
  'faithfulness',
  'factualCorrectness',
  'responseRelevancy',
  'contextCompleteness',
];

function applicability(item) {
  const bucket = item?.metadata?.bucket;
  const answerType = item?.metadata?.answerType;
  const all = Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, true]),
  );

  if (bucket === 'CHAT' || answerType === 'NORMAL_CHAT') {
    return {
      ...all,
      faithfulness: false,
      factualCorrectness: false,
      contextCompleteness: false,
      reason: 'Ordinary chat has no Reel evidence or reference fact.',
    };
  }
  if (
    bucket === 'RECOMMENDATION' ||
    answerType === 'RECOMMEND_REELS' ||
    answerType === 'SUGGEST_QUERIES'
  ) {
    return {
      ...all,
      faithfulness: false,
      factualCorrectness: false,
      contextCompleteness: false,
      reason:
        'Recommendation/action correctness requires structured action scoring.',
    };
  }
  if (
    bucket === 'ABSTENTION' ||
    answerType === 'ABSTENTION' ||
    answerType === 'ACCESS_DENIAL'
  ) {
    return {
      ...all,
      faithfulness: false,
      factualCorrectness: false,
      contextCompleteness: false,
      reason:
        'Correct refusal/access denial is scored by refusal and policy evaluators.',
    };
  }
  if (answerType === 'CLARIFICATION') {
    return {
      ...all,
      faithfulness: false,
      factualCorrectness: false,
      responseRelevancy: false,
      contextCompleteness: false,
      reason:
        'Clarification requests are scored by the ambiguity policy evaluator.',
    };
  }
  if (bucket === 'OPERATIONAL' || answerType === 'OPERATIONAL_CONTRACT') {
    return {
      ...all,
      faithfulness: false,
      factualCorrectness: false,
      responseRelevancy: false,
      contextCompleteness: false,
      reason:
        'Operational contract cases use deterministic diagnostics, not answer judges.',
    };
  }
  return { ...all, reason: 'Grounded answer task with reference evidence.' };
}

function isApplicable(item, dimension) {
  if (!DIMENSIONS.includes(dimension))
    throw new Error(`Unknown evaluation dimension: ${dimension}`);
  return applicability(item)[dimension];
}

module.exports = { DIMENSIONS, applicability, isApplicable };
