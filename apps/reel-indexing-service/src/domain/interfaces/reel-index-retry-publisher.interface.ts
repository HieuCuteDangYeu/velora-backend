import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';

export interface IReelIndexRetryPublisher {
  publishRetry(job: ReelIndexJob, retryNumber: 1 | 2): Promise<void>;
  /**
   * Puts a job whose visual provider quota was spent back behind the other jobs of its lane
   * after a short delay. `rotation` is how many times it has been put back (1 for the first).
   * It does not use up the two ordinary retries.
   */
  publishQuotaRotation(job: ReelIndexJob, rotation: number): Promise<void>;
}
