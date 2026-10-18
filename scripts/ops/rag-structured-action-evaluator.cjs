'use strict';

function evaluateRecommendation({ row, fixture, output }) {
  const expected = row?.metadata?.expectedRecommendationAction;
  if (!expected) return { applicable: false, pass: null, reason: 'No structured recommendation action expected.' };
  const recommendations = Array.isArray(output?.recommendedReels) ? output.recommendedReels : [];
  const suggestions = Array.isArray(output?.suggestedQueries) ? output.suggestedQueries : [];
  if (expected === 'SUGGEST_QUERIES') {
    const pass = suggestions.length > 0 && recommendations.length === 0 && suggestions.every((value) => typeof value === 'string' && value.trim());
    return { applicable: true, pass, reason: pass ? 'Structured query suggestions returned.' : 'Expected non-empty query suggestions without Reel recommendations.' };
  }
  if (expected === 'RECOMMEND_REELS') {
    const catalog = new Map((fixture?.recommendations ?? []).map((item) => [item.id, item]));
    const topic = String(row.input?.question ?? '').match(/about\s+([a-z]+)/i)?.[1]?.toLowerCase();
    const pass = recommendations.length > 0 && suggestions.length === 0 && recommendations.every((item) => {
      const id = item?.id;
      const catalogItem = catalog.get(id);
      return Boolean(catalogItem && (!topic || `${catalogItem.title} ${(catalogItem.tags ?? []).join(' ')}`.toLowerCase().includes(topic)));
    });
    return { applicable: true, pass, reason: pass ? 'Accessible relevant Reel recommendations returned.' : 'Recommendations were empty, included suggestions, invented IDs, or were irrelevant.' };
  }
  return { applicable: true, pass: false, reason: `Unsupported expected action: ${expected}` };
}

module.exports = { evaluateRecommendation };
