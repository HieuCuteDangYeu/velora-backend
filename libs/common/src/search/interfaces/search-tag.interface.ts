export interface SearchTagItem {
  /** Normalized key; pass it back to the tag reels endpoint unchanged. */
  tag: string;
  /** Number of public, playable reels carrying the tag. */
  reelCount: number;
}

export interface SearchTagsResponse {
  tags: SearchTagItem[];
}
