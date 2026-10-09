import { Logger } from '@nestjs/common';

import { NotificationRetryScheduler } from './notification-retry.scheduler';

describe('NotificationRetryScheduler', () => {
  const createMetrics = () => ({
    recordRetrySchedulerRun: jest.fn(),
    recordRetrySchedulerCompletion: jest.fn(),
    recordRetryJobs: jest.fn(),
    setDatabaseAvailability: jest.fn(),
    recordBacklog: jest.fn(),
    setBacklogSampleAvailability: jest.fn(),
  });

  let log: jest.SpiedFunction<Logger['log']>;
  let error: jest.SpiedFunction<Logger['error']>;

  beforeEach(() => {
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('isolates database outages and logs one outage followed by recovery', async () => {
    const databaseError = Object.assign(new Error('database unavailable'), {
      code: 'P1001',
    });
    const retryNotificationJobs = {
      execute: jest
        .fn()
        .mockRejectedValueOnce(databaseError)
        .mockRejectedValueOnce(databaseError)
        .mockResolvedValueOnce({ attemptedCount: 0, failures: [] }),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retryNotificationJobs as never,
      metrics as never,
      {
        readBacklog: jest.fn().mockResolvedValue({
          counts: { pending: 0, failed: 0, processing: 0 },
          oldestCreatedAt: null,
        }),
      } as never,
    );

    await scheduler.handleRetries();
    await scheduler.handleRetries();
    await scheduler.handleRetries();

    expect(metrics.setDatabaseAvailability).toHaveBeenNthCalledWith(1, false);
    expect(metrics.setDatabaseAvailability).toHaveBeenNthCalledWith(2, false);
    expect(metrics.setDatabaseAvailability).toHaveBeenLastCalledWith(true);
    expect(metrics.recordRetrySchedulerRun).toHaveBeenNthCalledWith(
      1,
      'database_unavailable',
    );
    expect(metrics.recordRetrySchedulerRun).toHaveBeenLastCalledWith('success');
    expect(metrics.recordRetrySchedulerCompletion).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(
      'Notification retry scheduler database connection recovered',
    );
  });

  it('does not overlap retry polls while a prior poll is active', async () => {
    let finish!: (value: { attemptedCount: number; failures: [] }) => void;
    const retryNotificationJobs = {
      execute: jest.fn(
        () =>
          new Promise<{ attemptedCount: number; failures: [] }>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retryNotificationJobs as never,
      metrics as never,
      {
        readBacklog: jest.fn().mockResolvedValue({
          counts: { pending: 0, failed: 0, processing: 0 },
          oldestCreatedAt: null,
        }),
      } as never,
    );

    const firstRun = scheduler.handleRetries();
    await Promise.resolve();
    await scheduler.handleRetries();
    finish({ attemptedCount: 0, failures: [] });
    await firstRun;

    expect(retryNotificationJobs.execute).toHaveBeenCalledTimes(1);
    expect(metrics.recordRetrySchedulerRun).toHaveBeenCalledWith('overlap');
    expect(metrics.recordRetrySchedulerRun).toHaveBeenCalledWith('success');
  });

  it('drains up to five full batches per poll and then yields', async () => {
    const retry = {
      execute: jest
        .fn()
        .mockResolvedValue({ attemptedCount: 20, failures: [] }),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retry as never,
      metrics as never,
      {
        readBacklog: jest.fn().mockResolvedValue({
          counts: { pending: 0, failed: 0, processing: 0 },
          oldestCreatedAt: null,
        }),
      } as never,
    );
    await scheduler.handleRetries();
    expect(retry.execute).toHaveBeenCalledTimes(5);
    expect(metrics.recordRetryJobs).toHaveBeenCalledWith(100, 0);
  });

  it('stops draining on a failed batch so DB/provider failures do not spin', async () => {
    const failure = { jobId: 'job', error: new Error('unavailable') };
    const retry = {
      execute: jest
        .fn()
        .mockResolvedValue({ attemptedCount: 20, failures: [failure] }),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retry as never,
      metrics as never,
      {
        readBacklog: jest.fn().mockResolvedValue({
          counts: { pending: 0, failed: 0, processing: 0 },
          oldestCreatedAt: null,
        }),
      } as never,
    );
    await scheduler.handleRetries();
    expect(retry.execute).toHaveBeenCalledTimes(1);
    expect(metrics.recordRetryJobs).toHaveBeenCalledWith(20, 1);
  });

  it('records an internal scheduler failure without throwing from the interval callback', async () => {
    const retryNotificationJobs = {
      execute: jest.fn().mockRejectedValue(new Error('unexpected failure')),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retryNotificationJobs as never,
      metrics as never,
      {
        readBacklog: jest.fn().mockResolvedValue({
          counts: { pending: 0, failed: 0, processing: 0 },
          oldestCreatedAt: null,
        }),
      } as never,
    );

    await expect(scheduler.handleRetries()).resolves.toBeUndefined();
    expect(metrics.recordRetrySchedulerRun).toHaveBeenCalledWith('error');
    expect(error).toHaveBeenCalledWith(
      'Notification retry scheduler failed: unknown',
    );
  });
  it('samples after draining, no more than every ten seconds, and isolates failed samples', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000);
    const retry = {
      execute: jest.fn().mockResolvedValue({ attemptedCount: 0, failures: [] }),
    };
    const snapshot = {
      counts: { pending: 3, processing: 0, failed: 0 },
      oldestCreatedAt: new Date(5_000),
    };
    const jobs = {
      readBacklog: jest
        .fn()
        .mockResolvedValueOnce(snapshot)
        .mockRejectedValueOnce(new Error('DB unavailable'))
        .mockResolvedValueOnce(snapshot),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retry as never,
      metrics as never,
      jobs as never,
    );
    await scheduler.handleRetries();
    expect(jobs.readBacklog.mock.invocationCallOrder[0]).toBeGreaterThan(
      retry.execute.mock.invocationCallOrder[0],
    );
    expect(metrics.recordBacklog).toHaveBeenCalledWith(snapshot);
    now.mockReturnValue(19_999);
    await scheduler.handleRetries();
    expect(jobs.readBacklog).toHaveBeenCalledTimes(1);
    now.mockReturnValue(20_000);
    await scheduler.handleRetries();
    expect(metrics.setBacklogSampleAvailability).toHaveBeenCalledWith(false);
    expect(metrics.recordBacklog).toHaveBeenCalledTimes(1);
    expect(metrics.recordRetrySchedulerRun).not.toHaveBeenCalledWith('error');
    now.mockReturnValue(20_001);
    await scheduler.handleRetries();
    expect(jobs.readBacklog).toHaveBeenCalledTimes(2);
    now.mockReturnValue(30_000);
    await scheduler.handleRetries();
    expect(metrics.recordBacklog).toHaveBeenCalledTimes(2);
  });

  it('keeps the poll non-overlapping until its backlog snapshot settles', async () => {
    let release!: () => void;
    const retry = {
      execute: jest.fn().mockResolvedValue({ attemptedCount: 0, failures: [] }),
    };
    const jobs = {
      readBacklog: jest.fn(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      ),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retry as never,
      metrics as never,
      jobs as never,
    );
    const poll = scheduler.handleRetries();
    await Promise.resolve();
    await scheduler.handleRetries();
    expect(retry.execute).toHaveBeenCalledTimes(1);
    expect(metrics.recordRetrySchedulerRun).toHaveBeenCalledWith('overlap');
    release();
    await poll;
  });
});
