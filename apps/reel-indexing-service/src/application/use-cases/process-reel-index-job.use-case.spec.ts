import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import { ProcessReelIndexJobUseCase, isDeferredProviderQuotaFailure } from './process-reel-index-job.use-case';

describe('ProcessReelIndexJobUseCase', () => {
  const job = {
    jobId: 'job-1',
    reelId: 'reel-1',
    indexAttemptId: 'attempt-1',
  } as ReelIndexJob;

  function build(input: { error: Error }) {
    const workflow = {
      execute: jest.fn().mockRejectedValue(input.error),
    };
    const checkpoints = {
      fail: jest.fn().mockResolvedValue(undefined),
    };
    const content = {
      failIndexing: jest.fn().mockResolvedValue(undefined),
    };
    const candidateLifecycle = {
      discardCandidate: jest.fn().mockResolvedValue(undefined),
    };
    return {
      useCase: new ProcessReelIndexJobUseCase(
        workflow as never,
        checkpoints as never,
        content as never,
        candidateLifecycle as never,
      ),
      workflow,
      checkpoints,
      content,
      candidateLifecycle,
    };
  }

  it('defers provider quota failures instead of retrying them in the same day', async () => {
    const value = build({
      error: new Error(
        'Visual provider rate limit or quota exhausted; retry this index attempt later: daily free allocation',
      ),
    });

    await expect(
      value.useCase.execute({
        job,
        allowReclaim: false,
        allowRetry: true,
      }),
    ).resolves.toEqual({
      status: 'PERMANENT_FAILURE',
      error: expect.stringContaining('quota exhausted'),
    });

    expect(value.content.failIndexing).toHaveBeenCalledWith({
      reelId: 'reel-1',
      indexAttemptId: 'attempt-1',
      errorDetail: expect.stringContaining('quota exhausted'),
    });
    expect(value.workflow.execute).toHaveBeenCalledTimes(1);
  });

  it('keeps transient indexing failures on the bounded retry path', async () => {
    const value = build({ error: new Error('temporary TEI timeout') });

    await expect(
      value.useCase.execute({
        job,
        allowReclaim: false,
        allowRetry: true,
      }),
    ).resolves.toEqual({
      status: 'RETRY',
      error: 'temporary TEI timeout',
    });

    expect(value.content.failIndexing).not.toHaveBeenCalled();
  });

  it('classifies Cloudflare daily allocation errors as deferred provider failures', () => {
    expect(
      isDeferredProviderQuotaFailure(
        'Cloudflare Workers AI vision request failed with status 429: daily free allocation',
      ),
    ).toBe(true);
    expect(isDeferredProviderQuotaFailure('temporary network timeout')).toBe(
      false,
    );
  });
});
