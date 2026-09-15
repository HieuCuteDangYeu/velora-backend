import { Logger } from '@nestjs/common';

import { NotificationRetryScheduler } from './notification-retry.scheduler';

describe('NotificationRetryScheduler', () => {
  const createMetrics = () => ({
    recordRetrySchedulerRun: jest.fn(),
    recordRetrySchedulerCompletion: jest.fn(),
    setDatabaseAvailability: jest.fn(),
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

  it('records an internal scheduler failure without throwing from the interval callback', async () => {
    const retryNotificationJobs = {
      execute: jest.fn().mockRejectedValue(new Error('unexpected failure')),
    };
    const metrics = createMetrics();
    const scheduler = new NotificationRetryScheduler(
      retryNotificationJobs as never,
      metrics as never,
    );

    await expect(scheduler.handleRetries()).resolves.toBeUndefined();
    expect(metrics.recordRetrySchedulerRun).toHaveBeenCalledWith('error');
    expect(error).toHaveBeenCalledWith(
      'Notification retry scheduler failed: unknown',
    );
  });
});
