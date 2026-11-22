/**
 * True when the words a user typed with a photo ask for reels or videos ("find reels like this",
 * "any videos similar to this?", "tìm video giống cái này"). A small router sometimes calls such a
 * turn OFF_TOPIC because it sees a picture of a slide or a street; the user's own words decide.
 * The photo description is never passed in: it is untrusted text from the image.
 */
const REEL_REQUEST =
  /\b(?:reels?|videos?|clips?|similar|related|like\s+(?:this|that|it))\b|\bphim\b|tìm|giống\s+(?:này|vậy)|tương\s+tự|liên\s+quan|相似|类似|視頻|视频/iu;

export function asksForReelsLikePhoto(caption: string): boolean {
  return REEL_REQUEST.test(caption);
}
