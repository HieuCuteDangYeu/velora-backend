/**
 * True when the words a user typed with a photo ask for reels or videos ("find reels like this",
 * "any videos similar to this?", "tìm video giống cái này") or which video the picture is from. A small router sometimes calls such a
 * turn OFF_TOPIC because it sees a picture of a slide or a street; the user's own words decide.
 * The photo description is never passed in: it is untrusted text from the image.
 */
const REEL_REQUEST =
  /\b(?:reels?|videos?|clips?|similar|related|like\s+(?:this|that|it))\b|\bphim\b|tìm|giống\s+(?:này|vậy)|tương\s+tự|liên\s+quan|相似|类似|視頻|视频/iu;

// "What is this from?" about a picture of a video asks which video it is.
const SOURCE_REQUEST =
  /\b(?:what|where|which\s+\w+)\s+(?:is\s+|was\s+)?(?:this|that|it)\s+(?:taken\s+)?from\b|\b(?:source|origin)\s+of\s+(?:this|that|it)\b|\b(?:where|which\s+\w+)\s+(?:is|was)\s+this\s+(?:scene|shot|frame|clip)\b|từ\s+(?:đâu|video\s+nào|phim\s+nào)|của\s+(?:video|phim)\s+nào/iu;

export function asksForReelsLikePhoto(caption: string): boolean {
  return REEL_REQUEST.test(caption) || SOURCE_REQUEST.test(caption);
}
