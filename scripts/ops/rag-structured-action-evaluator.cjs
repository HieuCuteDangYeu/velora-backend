'use strict';

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_\x60"'“”‘’]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function answerListItems(answer) {
  return String(answer ?? '')
    .split(/\r?\n/)
    .flatMap((line) => {
      const item = line.match(/^\s*(?:[-*]\s+|\d+[.)]\s+)(.+)$/);
      if (!item) return [];
      const text = item[1].trim();
      const bold = text.match(/\*\*(?:"([^"]+)"|'([^']+)'|(.+?))\*\*/);
      const title = bold?.[1] ?? bold?.[2] ?? bold?.[3] ?? text;
      return [normalizeText(title)];
    });
}

function proseMatches(items, answer) {
  const rendered = answerListItems(answer);
  const expected = items.map((item) => normalizeText(item)).filter(Boolean);
  return (
    rendered.length === expected.length &&
    expected.every((title, index) => rendered[index] === title)
  );
}

function evaluateRecommendation({ row, fixture, output }) {
  const expected = row?.metadata?.expectedRecommendationAction;
  if (!expected)
    return {
      applicable: false,
      pass: null,
      actionPass: null,
      prosePass: null,
      reason: 'No structured recommendation action expected.',
    };

  const recommendations = Array.isArray(output?.recommendedReels)
    ? output.recommendedReels
    : [];
  const suggestions = Array.isArray(output?.suggestedQueries)
    ? output.suggestedQueries
    : [];

  if (expected === 'SUGGEST_QUERIES') {
    const actionPass =
      suggestions.length > 0 &&
      recommendations.length === 0 &&
      suggestions.every((value) => typeof value === 'string' && value.trim());
    const prosePass = proseMatches(suggestions, output?.answer);
    return {
      applicable: true,
      actionPass,
      prosePass,
      pass: actionPass && prosePass,
      reason:
        actionPass && prosePass
          ? 'Structured query suggestions and rendered text agree.'
          : 'Suggestions are missing, mixed with Reel recommendations, or disagree with the rendered text.',
    };
  }

  if (expected === 'RECOMMEND_REELS') {
    const catalog = new Map(
      (fixture?.recommendations ?? []).map((item) => [item.id, item]),
    );
    const topic = String(row.input?.question ?? '')
      .match(/about\s+([a-z]+)/i)?.[1]
      ?.toLowerCase();
    const actionPass =
      recommendations.length > 0 &&
      suggestions.length === 0 &&
      recommendations.every((item) => {
        const catalogItem = catalog.get(item?.id);
        const searchable = [
          catalogItem?.title,
          ...(catalogItem?.tags ?? []),
        ].join(' ');
        return Boolean(
          catalogItem && (!topic || searchable.toLowerCase().includes(topic)),
        );
      });
    const prosePass = proseMatches(
      recommendations.map((item) => item?.title ?? ''),
      output?.answer,
    );
    return {
      applicable: true,
      actionPass,
      prosePass,
      pass: actionPass && prosePass,
      reason:
        actionPass && prosePass
          ? 'Accessible relevant Reel recommendations and prose agree.'
          : 'Recommendations or rendered titles are empty, invented, inaccessible, or irrelevant.',
    };
  }

  return {
    applicable: true,
    pass: false,
    actionPass: false,
    prosePass: false,
    reason: 'Unsupported expected action: ' + expected,
  };
}

module.exports = { answerListItems, evaluateRecommendation, normalizeText };
