import { RetryNotificationJobsUseCase } from './retry-notification-jobs.use-case';

describe('RetryNotificationJobsUseCase', () => {
  it('processes a backlog with at most two workers and continues after a failure', async () => {
    const jobs = Array.from({ length: 6 }, (_, i) => ({ id: `job-${i}` }));
    let active = 0;
    let peak = 0;
    const processNotificationJob = {
      execute: jest.fn(async (job: { id: string }) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setImmediate(resolve));
        active -= 1;
        if (job.id === 'job-1') throw new Error('provider failed');
        return { status: 'sent' };
      }),
    };
    const useCase = new RetryNotificationJobsUseCase(
      { findRetryable: jest.fn().mockResolvedValue(jobs) } as never,
      processNotificationJob as never,
    );
    const result = await useCase.execute(20);
    expect(peak).toBe(2);
    expect(active).toBe(0);
    expect(result.attemptedCount).toBe(6);
    expect(result.failures).toEqual([
      { jobId: 'job-1', error: expect.any(Error) },
    ]);
    expect(processNotificationJob.execute).toHaveBeenCalledTimes(6);
  });

  it('continues processing after an individual retry fails', async () => {
    const jobs = [{ id: 'job-1' }, { id: 'job-2' }];
    const notificationJobRepository = {
      findRetryable: jest.fn().mockResolvedValue(jobs),
    };
    const error = new Error('delivery unavailable');
    const processNotificationJob = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce({ status: 'sent' }),
    };
    const useCase = new RetryNotificationJobsUseCase(
      notificationJobRepository as never,
      processNotificationJob as never,
    );

    await expect(useCase.execute(20)).resolves.toEqual({
      attemptedCount: 2,
      failures: [{ jobId: 'job-1', error }],
    });
    expect(processNotificationJob.execute).toHaveBeenCalledTimes(2);
  });
});
