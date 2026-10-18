import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { IndexCheckpointStage } from '../entities/index-checkpoint.entity';

export interface IIndexingContentService {
  claimIndexingAttempt(input: {
    reelId: string;
    indexAttemptId: string;
    allowReclaim?: boolean;
  }): Promise<boolean>;

  isIndexingAttemptCurrent(input: {
    reelId: string;
    indexAttemptId: string;
  }): Promise<boolean>;

  reportProgress(input: {
    reelId: string;
    indexAttemptId: string;
    stage: IndexCheckpointStage;
    progress: number;
  }): Promise<void>;

  completeIndexing(input: CompleteReelIndexCommand): Promise<boolean>;

  failIndexing(input: {
    reelId: string;
    indexAttemptId: string;
    errorDetail: string;
  }): Promise<void>;

  reindexReel(
    reelId: string,
    options?: { requireVisualAnalysis?: boolean },
  ): Promise<{
    queued: boolean;
    indexAttemptId?: string;
  }>;
}
