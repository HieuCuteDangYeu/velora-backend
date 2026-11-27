import { SubtitleTranslationSweepService } from './subtitle-translation-sweep.service';

describe('SubtitleTranslationSweepService', () => {
  const result = { translated: ['vi'], alreadyStored: [], failed: [] };

  it('translates each indexed reel that has no subtitle track, one at a time', async () => {
    const order: string[] = [];
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'r1' }, { id: 'r2' }]),
    };
    const preTranslate = {
      execute: jest.fn((id: string) => {
        order.push(id);
        return Promise.resolve(result);
      }),
    };
    await new SubtitleTranslationSweepService(
      prisma as never,
      preTranslate as never,
    ).sweep();
    expect(order).toEqual(['r1', 'r2']);
  });

  it('does not start a second sweep while one is running', async () => {
    let release: () => void = () => undefined;
    const prisma = {
      $queryRaw: jest.fn().mockReturnValue(
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
      ),
    };
    const service = new SubtitleTranslationSweepService(
      prisma as never,
      { execute: jest.fn() } as never,
    );
    const first = service.sweep();
    await service.sweep();
    release();
    await first;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('survives a failed query', async () => {
    const service = new SubtitleTranslationSweepService(
      { $queryRaw: jest.fn().mockRejectedValue(new Error('db down')) } as never,
      { execute: jest.fn() } as never,
    );
    await expect(service.sweep()).resolves.toBeUndefined();
  });
});
