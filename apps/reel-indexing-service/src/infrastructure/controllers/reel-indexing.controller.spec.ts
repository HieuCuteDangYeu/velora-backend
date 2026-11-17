import { REEL_INDEX_JOB_SCHEMA_VERSION } from '@common/processing/interfaces/reel-index-job.interface';
import { Logger } from '@nestjs/common';
import type { RmqContext } from '@nestjs/microservices';
import { ReelIndexingController } from './reel-indexing.controller';

const job = {
  jobId: 'job-1',
  reelId: 'reel-1',
  userId: 'user-1',
  mediaAttemptId: 'media-1',
  indexAttemptId: 'attempt-1',
  indexVersion: 'reel-index-v2',
  mediaKey: 'reels/user-1/reel-1.mp4',
  sourceDurationMs: 60_000,
  sourceOrientation: 'PORTRAIT',
  sourceLengthClass: 'SHORT',
  tags: [],
  createdAt: '2026-11-16T10:00:00.000Z',
  schemaVersion: REEL_INDEX_JOB_SCHEMA_VERSION,
};

describe('ReelIndexingController failed jobs', () => {
  const channel = { ack: jest.fn(), nack: jest.fn() };
  const message = { fields: { redelivered: false }, properties: {} };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  const publishRetry = jest.fn();
  const publishQuotaRotation = jest.fn();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

  const controllerReturning = (result: unknown) =>
    new ReelIndexingController(
      { execute: jest.fn().mockResolvedValue(result) } as never,
      { publishRetry, publishQuotaRotation },
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('acknowledges a provider quota failure with a warning instead of dead-lettering it', async () => {
    await controllerReturning({
      status: 'PERMANENT_FAILURE',
      error:
        'Visual provider rate limit or quota exhausted; retry this index attempt later: Groq 429',
    }).handle(job, context);

    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('visual provider quota exhausted'),
    );
    expect(error).not.toHaveBeenCalled();
  });

  it('keeps the exhausted-retries error, with the cause, for other permanent failures', async () => {
    await controllerReturning({
      status: 'PERMANENT_FAILURE',
      error: 'Batch embedding failed for 3 items',
    }).handle(job, context);

    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/exhausted retries.*Batch embedding failed/),
    );
  });

  it('puts a quota-failed job back behind the others and counts the pass', async () => {
    const processJob = {
      execute: jest.fn().mockResolvedValue({
        status: 'QUOTA_ROTATE',
        error: 'Visual provider rate limit or quota exhausted',
      }),
    };
    const rotatedMessage = {
      fields: { redelivered: false },
      properties: { headers: { 'x-reel-index-quota-rotation': 2 } },
    };

    await new ReelIndexingController(processJob as never, {
      publishRetry,
      publishQuotaRotation,
    }).handle({ ...job, createdAt: new Date().toISOString() }, {
      getChannelRef: () => channel,
      getMessage: () => rotatedMessage,
    } as unknown as RmqContext);

    expect(processJob.execute).toHaveBeenCalledWith(
      expect.objectContaining({ allowQuotaRotation: true, retryNumber: 0 }),
    );
    expect(publishQuotaRotation).toHaveBeenCalledWith(expect.anything(), 3);
    expect(publishRetry).not.toHaveBeenCalled();
    expect(channel.ack).toHaveBeenCalledWith(rotatedMessage);
    expect(channel.nack).not.toHaveBeenCalled();
  });

  it('stops rotating a job older than the age limit', async () => {
    const processJob = {
      execute: jest.fn().mockResolvedValue({ status: 'COMPLETED' }),
    };

    await new ReelIndexingController(processJob as never, {
      publishRetry,
      publishQuotaRotation,
    }).handle(
      { ...job, createdAt: new Date(Date.now() - 7 * 3_600_000).toISOString() },
      context,
    );

    expect(processJob.execute).toHaveBeenCalledWith(
      expect.objectContaining({ allowQuotaRotation: false }),
    );
  });

  it('sends a retryable failure to the retry lane and acknowledges it', async () => {
    await controllerReturning({ status: 'RETRY', error: 'boom' }).handle(
      job,
      context,
    );

    expect(publishRetry).toHaveBeenCalledWith(job, 1);
    expect(channel.ack).toHaveBeenCalledWith(message);
    expect(channel.nack).not.toHaveBeenCalled();
  });
});
