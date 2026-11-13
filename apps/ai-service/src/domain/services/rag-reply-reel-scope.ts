/**
 * Narrows the Reels the AI may use to the one the user swipe-replied to, so "this reel" is not
 * ambiguous when several Reels are shared in the chat. The reply target only ever narrows the
 * set: a Reel that is not already accessible in this conversation is ignored, so the hint can
 * never widen access.
 */
export function scopeAccessibleReelsToReplyTarget(
  accessibleReelIds: readonly string[],
  replyToReelId: string | undefined,
): string[] {
  const target = replyToReelId?.trim();

  if (target && accessibleReelIds.includes(target)) {
    return [target];
  }

  return [...accessibleReelIds];
}
