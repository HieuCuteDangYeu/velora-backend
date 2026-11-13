export const MIN_REEL_SEARCH_TAG_LENGTH = 2;
export const MAX_REEL_SEARCH_TAG_LENGTH = 32;

/**
 * Canonical tag key used for tag search/browse. Mirrors the
 * reel_normalize_search_tags() SQL function that fills Reel.searchTags.
 */
export function normalizeReelSearchTag(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^#+/, '')
    .replace(/[\s_-]+/g, ' ')
    .trim()
    .toLowerCase();

  if (
    normalized.length < MIN_REEL_SEARCH_TAG_LENGTH ||
    normalized.length > MAX_REEL_SEARCH_TAG_LENGTH ||
    /^\d+$/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}
