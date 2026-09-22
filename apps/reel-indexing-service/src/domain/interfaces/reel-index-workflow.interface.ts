import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';

export type ReelIndexWorkflowStatus = 'COMPLETED' | 'DUPLICATE' | 'STALE';

export interface IReelIndexWorkflow {
  execute(input: {
    job: ReelIndexJob;
    allowReclaim: boolean;
    retryNumber?: number;
    queuedAt?: string;
  }): Promise<ReelIndexWorkflowStatus>;
}
