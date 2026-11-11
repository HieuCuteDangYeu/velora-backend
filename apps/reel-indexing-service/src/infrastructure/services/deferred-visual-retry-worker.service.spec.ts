import type { RetryDeferredVisualAnalysisUseCase } from '@indexing/application/use-cases/retry-deferred-visual-analysis.use-case';
import type { ConfigService } from '@nestjs/config';
import { DeferredVisualRetryWorker } from './deferred-visual-retry-worker.service';

function build(env: Record<string, string> = {}) {
  const execute = jest.fn().mockResolvedValue({
    completed: 0,
    attempted: 0,
    stoppedBecause: 'NONE_LEFT',
  });
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  const worker = new DeferredVisualRetryWorker(config, {
    execute,
  } as unknown as RetryDeferredVisualAnalysisUseCase);
  return { worker, execute };
}

describe('DeferredVisualRetryWorker', () => {
  it('waits until the start minute, then runs once a day', async () => {
    const { worker, execute } = build();
    await expect(worker.tick(new Date('2026-11-11T00:05:00Z'))).resolves.toBe(
      false,
    );
    await expect(worker.tick(new Date('2026-11-11T00:20:00Z'))).resolves.toBe(
      true,
    );
    await expect(worker.tick(new Date('2026-11-11T06:00:00Z'))).resolves.toBe(
      false,
    );
    await expect(worker.tick(new Date('2026-11-12T00:16:00Z'))).resolves.toBe(
      true,
    );
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ maxReels: 4, maxRecentAttempts: 3 }),
    );
  });

  it('honours the configured limit and start minute', async () => {
    const { worker, execute } = build({
      INDEX_DEFERRED_VISUAL_RETRY_MAX_REELS: '2',
      INDEX_DEFERRED_VISUAL_RETRY_START_UTC_MINUTE: '60',
    });
    await expect(worker.tick(new Date('2026-11-11T00:30:00Z'))).resolves.toBe(
      false,
    );
    await expect(worker.tick(new Date('2026-11-11T01:00:00Z'))).resolves.toBe(
      true,
    );
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ maxReels: 2 }),
    );
  });

  it('does not schedule itself in the LONG lane or when disabled, and survives a failed run', async () => {
    jest.useFakeTimers();
    for (const env of [
      { INDEX_WORKER_LANE: 'LONG' },
      { INDEX_DEFERRED_VISUAL_RETRY_ENABLED: 'false' },
    ]) {
      const { worker } = build(env);
      worker.onModuleInit();
      expect(jest.getTimerCount()).toBe(0);
      worker.onModuleDestroy();
    }
    jest.useRealTimers();

    const { worker, execute } = build();
    execute.mockRejectedValueOnce(new Error('rabbit down'));
    await expect(worker.tick(new Date('2026-11-11T00:20:00Z'))).resolves.toBe(
      true,
    );
  });
});
