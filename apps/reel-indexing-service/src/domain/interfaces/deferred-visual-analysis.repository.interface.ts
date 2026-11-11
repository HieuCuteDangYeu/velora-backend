export interface DeferredVisualAnalysisAttemptOutcome {
  status: string;
  lastError?: string;
}

/**
 * Reads the index database for reels that were indexed without visual scenes (for example because the visual model's
 * daily allocation ran out during the upload) so they can be analysed again once the allocation has reset.
 */
export interface IDeferredVisualAnalysisRepository {
  /** Oldest first. Skips excluded reels and reels that already had `maxRecentAttempts` attempts since `recentSince`. */
  findReelsAwaitingVisualAnalysis(input: {
    limit: number;
    excludeReelIds: readonly string[];
    recentSince: Date;
    maxRecentAttempts: number;
  }): Promise<string[]>;

  getAttemptOutcome(
    indexAttemptId: string,
  ): Promise<DeferredVisualAnalysisAttemptOutcome | null>;
}
