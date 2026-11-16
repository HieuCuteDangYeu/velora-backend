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

describe('ReelIndexingController dead-lettering', () => {
  const channel = { ack: jest.fn(), nack: jest.fn() };
  const message = { fields: { redelivered: false }, properties: {} };
  const context = {
    getChannelRef: () => channel,
    getMessage: () => message,
  } as unknown as RmqContext;
  const publishRetry = jest.fn();
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();

  const controllerReturning = (result: unknown) =>
    new ReelIndexingController(
      { execute: jest.fn().mockResolvedValue(result) } as never,
      { publishRetry },
    );

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dead-letters a provider quota failure with an accurate warning, not an error', async () => {
    await controllerReturning({
      status: 'PERMANENT_FAILURE',
      error:
        'Visual provider rate limit or quota exhausted; retry this index attempt later: Groq 429',
    }).handle(job, context);

    expect(channel.nack).toHaveBeenCalledWith(message, false, false);
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
