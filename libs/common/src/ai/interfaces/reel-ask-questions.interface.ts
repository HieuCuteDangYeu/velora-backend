/** Questions offered under a reel's description; tapping one asks the Velora bot about that reel. */
export const REEL_ASK_QUESTION_COUNT = 3;
export const REEL_ASK_QUESTION_MAX_CHARS = 80;
export const REEL_ASK_TRANSCRIPT_MAX_CHARS = 4_000;

export interface SuggestReelQuestionsRequest {
  title?: string;
  description?: string;
  tags: string[];
  /** Transcript text sampled across the whole reel, at most REEL_ASK_TRANSCRIPT_MAX_CHARS. */
  transcript: string;
  /** Spoken language of the transcript (ISO 639-1), when known. */
  language?: string;
}

export interface SuggestReelQuestionsResult {
  questions: string[];
}
