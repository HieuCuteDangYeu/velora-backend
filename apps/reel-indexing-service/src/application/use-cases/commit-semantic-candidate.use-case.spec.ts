import type { CompleteReelIndexCommand } from '@common/processing/interfaces/complete-reel-index.interface';
import type { ReelIndexJob } from '@common/processing/interfaces/reel-index-job.interface';
import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type { ISemanticCandidateLifecycle } from '@indexing/domain/interfaces/semantic-candidate-lifecycle.interface';
import { ProjectionPendingError } from '@indexing/domain/interfaces/reel-vector-store.interface';
import { CommitSemanticCandidateUseCase } from './commit-semantic-candidate.use-case';

const job = {
  reelId: 'reel-1',
  indexAttemptId: 'attempt-2',
} as ReelIndexJob;

const completion = {
  reelId: 'reel-1',
  indexAttemptId: 'attempt-2',
} as CompleteReelIndexCommand;

const buildContent = (): jest.Mocked<IIndexingContentService> => ({
  claimIndexingAttempt: jest.fn(),
  isIndexingAttemptCurrent: jest.fn(),
  reportProgress: jest.fn(),
  completeIndexing: jest.fn(),
  failIndexing: jest.fn(),
  reindexReel: jest.fn(),
});

const buildLifecycle = (): jest.Mocked<ISemanticCandidateLifecycle> => ({
  activateCandidate: jest.fn(),
  rollbackCandidate: jest.fn(),
  finalizeCandidate: jest.fn(),
  discardCandidate: jest.fn(),
});

describe('CommitSemanticCandidateUseCase', () => {
  it('discards an inactive candidate when the attempt is already stale', async () => {
    const content = buildContent();
    const lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(false);
    lifecycle.discardCandidate.mockResolvedValue();
    const useCase = new CommitSemanticCandidateUseCase(content, lifecycle);

    await expect(useCase.execute({ job, completion })).resolves.toBe('STALE');
    expect(lifecycle.activateCandidate).not.toHaveBeenCalled();
    expect(lifecycle.discardCandidate).toHaveBeenCalledWith({
      reelId: 'reel-1',
      indexAttemptId: 'attempt-2',
    });
  });

  it('rolls back the previous active candidate when content rejects the commit', async () => {
    const content = buildContent();
    const lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(true);
    content.completeIndexing.mockResolvedValue(false);
    lifecycle.activateCandidate.mockResolvedValue({
      previousIndexAttemptId: 'attempt-1',
    });
    lifecycle.rollbackCandidate.mockResolvedValue();
    lifecycle.discardCandidate.mockResolvedValue();
    const useCase = new CommitSemanticCandidateUseCase(content, lifecycle);

    await expect(useCase.execute({ job, completion })).resolves.toBe('STALE');
    expect(lifecycle.rollbackCandidate).toHaveBeenCalledWith({
      reelId: 'reel-1',
      indexAttemptId: 'attempt-2',
      previousIndexAttemptId: 'attempt-1',
    });
    expect(lifecycle.finalizeCandidate).not.toHaveBeenCalled();
  });

  it('finalizes the accepted semantic candidate', async () => {
    const content = buildContent();
    const lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(true);
    content.completeIndexing.mockResolvedValue(true);
    lifecycle.activateCandidate.mockResolvedValue({
      previousIndexAttemptId: 'attempt-1',
    });
    lifecycle.finalizeCandidate.mockResolvedValue();
    const useCase = new CommitSemanticCandidateUseCase(content, lifecycle);

    await expect(useCase.execute({ job, completion })).resolves.toBe(
      'COMPLETED',
    );
    expect(lifecycle.finalizeCandidate).toHaveBeenCalledWith({
      reelId: 'reel-1',
      indexAttemptId: 'attempt-2',
    });
    expect(lifecycle.rollbackCandidate).not.toHaveBeenCalled();
  });
});

describe('durable vector publication', () => {
  it('leaves activation untouched when the durable publication is pending', async () => {
    const content = buildContent(),
      lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(true);
    const publication = {
      defer: jest.fn().mockResolvedValue({ pending: true, generation: '2' }),
      complete: jest.fn(),
    };
    const useCase = new CommitSemanticCandidateUseCase(
      content,
      lifecycle,
      publication,
    );
    await expect(useCase.execute({ job, completion })).rejects.toThrow(
      'projection is pending',
    );
    expect(publication.defer).toHaveBeenCalledWith({ job, completion });
    expect(lifecycle.activateCandidate).not.toHaveBeenCalled();
    expect(content.completeIndexing).not.toHaveBeenCalled();
  });
  it('recovers a continuation after Content accepted it before the worker crashed', async () => {
    const content = buildContent(),
      lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(false);
    content.completeIndexing.mockResolvedValue(true);
    lifecycle.isCandidateActive = jest.fn().mockResolvedValue(true);
    const publication = { defer: jest.fn(), complete: jest.fn() };
    const useCase = new CommitSemanticCandidateUseCase(
      content,
      lifecycle,
      publication,
    );
    await expect(
      useCase.execute({ job, completion, projectionGeneration: '2' }),
    ).resolves.toBe('COMPLETED');
    expect(lifecycle.activateCandidate).not.toHaveBeenCalled();
    expect(lifecycle.finalizeCandidate).toHaveBeenCalledWith({
      reelId: job.reelId,
      indexAttemptId: job.indexAttemptId,
      projectionGeneration: '2',
    });
    expect(publication.complete).toHaveBeenCalledWith(
      job.reelId,
      job.indexAttemptId,
      '2',
    );
  });
  it('retains the continuation if cleanup fails after Content accepts', async () => {
    const content = buildContent(),
      lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(true);
    content.completeIndexing.mockResolvedValue(true);
    lifecycle.activateCandidate.mockResolvedValue({
      projectionGeneration: '2',
    });
    lifecycle.finalizeCandidate.mockRejectedValue(new Error('SQL unavailable'));
    const publication = {
      defer: jest.fn().mockResolvedValue({ pending: false, generation: '2' }),
      complete: jest.fn(),
    };
    await expect(
      new CommitSemanticCandidateUseCase(
        content,
        lifecycle,
        publication,
      ).execute({ job, completion }),
    ).resolves.toBe('COMPLETED');
    expect(publication.complete).not.toHaveBeenCalled();
    expect(lifecycle.rollbackCandidate).not.toHaveBeenCalled();
  });
});

describe('publication ownership and compensation', () => {
  function setup(current: boolean, active = true) {
    const content = buildContent(),
      lifecycle = buildLifecycle();
    content.isIndexingAttemptCurrent.mockResolvedValue(current);
    lifecycle.isCandidateActive = jest.fn().mockResolvedValue(active);
    lifecycle.rollbackCandidate.mockResolvedValue();
    lifecycle.activateCandidate.mockResolvedValue({
      previousIndexAttemptId: 'attempt-1',
      projectionGeneration: '2',
    });
    const publication = {
      defer: jest.fn().mockResolvedValue({
        pending: false,
        generation: '2',
        token: 'owner',
        recovering: true,
      }),
      complete: jest.fn(),
      release: jest.fn(),
    };
    return {
      content,
      lifecycle,
      publication,
      commit: new CommitSemanticCandidateUseCase(
        content,
        lifecycle,
        publication,
      ),
    };
  }
  it.each([false, true])(
    'compensates a recovered activation when current=%s and Content rejects',
    async (current) => {
      const { content, lifecycle, publication, commit } = setup(current);
      content.completeIndexing.mockResolvedValue(false);
      await expect(commit.execute({ job, completion })).resolves.toBe('STALE');
      expect(lifecycle.rollbackCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          projectionGeneration: '2',
          publicationToken: 'owner',
        }),
      );
      expect(lifecycle.discardCandidate).toHaveBeenCalledWith(
        expect.objectContaining({ publicationToken: 'owner' }),
      );
      expect(publication.complete).not.toHaveBeenCalled();
      expect(publication.release).toHaveBeenCalledWith(
        job.reelId,
        job.indexAttemptId,
        '2',
        'owner',
      );
    },
  );
  it('compensates an RPC error but leaves the durable continuation for recovery', async () => {
    const { content, lifecycle, publication, commit } = setup(true);
    content.completeIndexing.mockRejectedValue(new Error('RPC unavailable'));
    await expect(commit.execute({ job, completion })).rejects.toThrow(
      'projection is pending',
    );
    expect(lifecycle.rollbackCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        previousIndexAttemptId: 'attempt-1',
        publicationToken: 'owner',
      }),
    );
    expect(lifecycle.discardCandidate).not.toHaveBeenCalled();
    expect(publication.complete).not.toHaveBeenCalled();
    expect(publication.release).toHaveBeenCalled();
  });
  it('restores a compensated candidate after an idempotent Content acknowledgement', async () => {
    const { content, lifecycle, publication, commit } = setup(false, false);
    content.completeIndexing.mockResolvedValue(true);
    await expect(commit.execute({ job, completion })).resolves.toBe(
      'COMPLETED',
    );
    expect(lifecycle.activateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ publicationToken: 'owner' }),
    );
    expect(lifecycle.finalizeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ publicationToken: 'owner' }),
    );
    expect(publication.complete).toHaveBeenCalledWith(
      job.reelId,
      job.indexAttemptId,
      '2',
      'owner',
    );
  });
  it('does not contact Content or mutate candidates when another publisher owns the lease', async () => {
    const { content, lifecycle, publication, commit } = setup(true);
    publication.defer.mockRejectedValue(new ProjectionPendingError());
    await expect(commit.execute({ job, completion })).rejects.toThrow(
      'projection is pending',
    );
    expect(content.isIndexingAttemptCurrent).not.toHaveBeenCalled();
    expect(lifecycle.activateCandidate).not.toHaveBeenCalled();
    expect(lifecycle.rollbackCandidate).not.toHaveBeenCalled();
  });
});
