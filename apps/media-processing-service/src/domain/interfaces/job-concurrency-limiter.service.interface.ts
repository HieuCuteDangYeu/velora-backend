export type JobPriority = 'NORMAL' | 'LOW';

export interface IJobConcurrencyLimiterService {
  /**
   * Runs `job` once fewer than `limit` jobs are running. When several are waiting, NORMAL jobs
   * start before LOW ones, so a waiting encode is never held up by waiting evidence work.
   */
  runExclusive<T>(
    job: () => Promise<T>,
    limit: number,
    priority?: JobPriority,
  ): Promise<T>;
}
