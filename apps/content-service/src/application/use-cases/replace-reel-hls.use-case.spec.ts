import { ReplaceReelHlsUseCase } from './replace-reel-hls.use-case';
import {
  reelHlsPlanSha256,
  type ReelHlsReplacementPlan,
} from '@common/content/reel-hls-replacement';

function fixture() {
  const plan = {
    reelId: '12345678-1234-1234-1234-123456789abc',
    userId: 'owner',
    attemptId: '87654321-1234-4234-8234-123456789abc',
    mediaAttemptId: null,
    indexAttemptId: null,
    previousHlsMasterKey:
      'reels/12345678-1234-1234-1234-123456789abc/master.m3u8',
  } as ReelHlsReplacementPlan;
  const repository = {
    reserveReelHlsReplacement: jest.fn(),
    completeReelHlsReplacement: jest
      .fn()
      .mockResolvedValue({ hlsMasterKey: 'new-version' }),
  };
  const validator = { validate: jest.fn() };
  const storage = { checkFileExists: jest.fn().mockResolvedValue(true) };
  const outbox = { trigger: jest.fn() };
  const useCase = new ReplaceReelHlsUseCase(
    repository as never,
    validator,
    storage as never,
    outbox,
  );
  return {
    plan,
    repository,
    validator,
    storage,
    outbox,
    useCase,
    command: {
      action: 'APPLY' as const,
      plan,
      reviewedSha256: reelHlsPlanSha256(plan),
    },
  };
}

describe('ReplaceReelHlsUseCase', () => {
  it('rejects a changed artifact or foreign previous pointer before any storage or repository work', async () => {
    const f = fixture();
    await expect(
      f.useCase.execute({ ...f.command, reviewedSha256: 'incorrect' }),
    ).rejects.toThrow('checksum');
    f.plan.previousHlsMasterKey = 'reels/foreign/source/master.m3u8';
    await expect(
      f.useCase.execute({
        ...f.command,
        reviewedSha256: reelHlsPlanSha256(f.plan),
      }),
    ).rejects.toThrow('ownership');
    expect(f.validator.validate).not.toHaveBeenCalled();
    expect(f.repository.completeReelHlsReplacement).not.toHaveBeenCalled();
  });
  it('never cuts over after failed output validation and reserves without a pointer change', async () => {
    const f = fixture();
    await f.useCase.execute({ ...f.command, action: 'RESERVE' });
    expect(f.repository.reserveReelHlsReplacement).toHaveBeenCalledWith(f.plan);
    expect(f.repository.completeReelHlsReplacement).not.toHaveBeenCalled();
    f.validator.validate.mockRejectedValueOnce(new Error('missing segment'));
    await expect(f.useCase.execute(f.command)).rejects.toThrow(
      'missing segment',
    );
    expect(f.repository.completeReelHlsReplacement).not.toHaveBeenCalled();
    await expect(f.useCase.execute(f.command)).resolves.toEqual({
      hlsMasterKey: 'new-version',
    });
    expect(f.outbox.trigger).toHaveBeenCalledTimes(1);
  });
  it('does not roll back to a missing previous master', async () => {
    const f = fixture();
    f.storage.checkFileExists.mockResolvedValue(false);
    await expect(
      f.useCase.execute({ ...f.command, action: 'ROLLBACK' }),
    ).rejects.toThrow('unavailable');
    expect(f.repository.completeReelHlsReplacement).not.toHaveBeenCalled();
  });
  it('wakes durable invalidation even if the cache fails after a committed cutover', async () => {
    const f = fixture();
    f.repository.completeReelHlsReplacement.mockRejectedValueOnce(
      new Error('cache unavailable'),
    );
    await expect(f.useCase.execute(f.command)).rejects.toThrow(
      'cache unavailable',
    );
    expect(f.outbox.trigger).toHaveBeenCalledTimes(1);
  });
});
