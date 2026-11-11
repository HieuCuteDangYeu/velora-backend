import type { IIndexingContentService } from '@indexing/domain/interfaces/content-service.interface';
import type {
  DeferredVisualAnalysisAttemptOutcome,
  IDeferredVisualAnalysisRepository,
} from '@indexing/domain/interfaces/deferred-visual-analysis.repository.interface';
import {
  RetryDeferredVisualAnalysisUseCase,
  type RetryDeferredVisualAnalysisOptions,
} from './retry-deferred-visual-analysis.use-case';

const options: RetryDeferredVisualAnalysisOptions = {
  maxReels: 4,
  attemptTimeoutMs: 60_000,
  pollIntervalMs: 1_000,
  maxRecentAttempts: 3,
  recentWindowMs: 7 * 24 * 60 * 60 * 1000,
};

function build(input: {
  reels: string[];
  outcomes: Record<string, DeferredVisualAnalysisAttemptOutcome | null>;
  queued?: (reelId: string) => { queued: boolean; indexAttemptId?: string };
}) {
  const reindexed: string[] = [];
  const repository: IDeferredVisualAnalysisRepository = {
    findReelsAwaitingVisualAnalysis: jest.fn(({ excludeReelIds, limit }) =>
      Promise.resolve(
        input.reels
          .filter((id) => !excludeReelIds.includes(id))
          .slice(0, limit),
      ),
    ),
    getAttemptOutcome: jest.fn((attemptId: string) =>
      Promise.resolve(input.outcomes[attemptId] ?? null),
    ),
  };
  const content = {
    reindexReel: jest.fn((reelId: string) => {
      reindexed.push(reelId);
      return Promise.resolve(
        input.queued?.(reelId) ?? {
          queued: true,
          indexAttemptId: `attempt-${reelId}`,
        },
      );
    }),
  } as unknown as IIndexingContentService;
  let clock = 0;
  const useCase = new RetryDeferredVisualAnalysisUseCase(repository, content);
  const run = (override: Partial<RetryDeferredVisualAnalysisOptions> = {}) =>
    useCase.execute(
      { ...options, ...override },
      {
        now: () => clock,
        sleep: (ms) => {
          clock += ms;
          return Promise.resolve();
        },
      },
    );
  return { run, reindexed, content, repository };
}

describe('RetryDeferredVisualAnalysisUseCase', () => {
  it('re-indexes each waiting reel with visual analysis required, up to the daily limit', async () => {
    const { run, reindexed, content } = build({
      reels: ['a', 'b', 'c', 'd', 'e'],
      outcomes: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e'].map((id) => [
          `attempt-${id}`,
          { status: 'COMPLETED' },
        ]),
      ),
    });
    await expect(run({ maxReels: 3 })).resolves.toEqual({
      completed: 3,
      attempted: 3,
      stoppedBecause: 'LIMIT',
    });
    expect(reindexed).toEqual(['a', 'b', 'c']);
    expect(content.reindexReel).toHaveBeenCalledWith('a', {
      requireVisualAnalysis: true,
    });
  });

  it('stops for the day as soon as the provider reports its allocation is spent', async () => {
    const { run, reindexed } = build({
      reels: ['a', 'b', 'c'],
      outcomes: {
        'attempt-a': { status: 'COMPLETED' },
        'attempt-b': {
          status: 'FAILED',
          lastError:
            'Visual provider rate limit or quota exhausted; retry this index attempt later: 4006 daily free allocation',
        },
      },
    });
    await expect(run()).resolves.toEqual({
      completed: 1,
      attempted: 2,
      stoppedBecause: 'QUOTA',
    });
    expect(reindexed).toEqual(['a', 'b']);
  });

  it('stops after two failures in a row that are not a quota problem', async () => {
    const { run } = build({
      reels: ['a', 'b', 'c'],
      outcomes: {
        'attempt-a': { status: 'FAILED', lastError: 'Qdrant unavailable' },
        'attempt-b': { status: 'FAILED', lastError: 'Qdrant unavailable' },
      },
    });
    await expect(run()).resolves.toMatchObject({
      attempted: 2,
      stoppedBecause: 'FAILURE',
    });
  });

  it('skips a reel that could not be queued without retrying it in the same run', async () => {
    const { run, reindexed } = build({
      reels: ['a', 'b'],
      outcomes: { 'attempt-b': { status: 'COMPLETED' } },
      queued: (id) =>
        id === 'a'
          ? { queued: false }
          : { queued: true, indexAttemptId: 'attempt-b' },
    });
    await expect(run()).resolves.toMatchObject({
      completed: 1,
      stoppedBecause: 'NONE_LEFT',
    });
    expect(reindexed).toEqual(['a', 'b']);
  });

  it('reports NONE_LEFT when nothing is waiting and TIMEOUT when an attempt never finishes', async () => {
    await expect(build({ reels: [], outcomes: {} }).run()).resolves.toEqual({
      completed: 0,
      attempted: 0,
      stoppedBecause: 'NONE_LEFT',
    });
    await expect(
      build({
        reels: ['a'],
        outcomes: { 'attempt-a': { status: 'PROCESSING' } },
      }).run({
        attemptTimeoutMs: 5_000,
      }),
    ).resolves.toMatchObject({ stoppedBecause: 'TIMEOUT' });
  });
});
