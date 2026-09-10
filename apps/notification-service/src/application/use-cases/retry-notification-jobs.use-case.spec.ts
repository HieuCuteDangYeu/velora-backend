import { RetryNotificationJobsUseCase } from './retry-notification-jobs.use-case';

describe('RetryNotificationJobsUseCase', () => {
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
