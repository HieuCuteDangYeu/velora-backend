import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';

export interface IReelIndexJobPublisher {
  /** Resolves 'skipped' when the job was deliberately not sent to the indexer. */
  publish(job: ReelIndexJob): Promise<void | 'skipped'>;
}
