import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { SearchPublicReelsUseCase } from './search-public-reels.use-case';

describe('SearchPublicReelsUseCase', () => {
  const build = (findSearchablePublicReels: jest.Mock) => {
    const searchPublicReels = jest
      .fn()
      .mockResolvedValue([{ reelId: 'r1', score: 0.9 }]);
    const useCase = new SearchPublicReelsUseCase(
      { findSearchablePublicReels } as unknown as IContentRepository,
      { searchPublicReels },
    );
    return { useCase, searchPublicReels };
  };

  it('returns scored reels in candidate order', async () => {
    const { useCase } = build(
      jest.fn().mockResolvedValue([{ id: 'r1', title: 'One' }]),
    );

    await expect(useCase.execute({ query: ' pets ' })).resolves.toEqual([
      { reel: { id: 'r1', title: 'One' }, score: 0.9 },
    ]);
  });

  it('returns no results, not an error, when the database read fails', async () => {
    const { useCase } = build(
      jest.fn().mockRejectedValue(new Error('pool timeout')),
    );

    await expect(useCase.execute({ query: 'pets' })).resolves.toEqual([]);
  });

  it('skips the search for a blank query', async () => {
    const { useCase, searchPublicReels } = build(jest.fn());

    await expect(useCase.execute({ query: '   ' })).resolves.toEqual([]);
    expect(searchPublicReels).not.toHaveBeenCalled();
  });
});

describe('SearchPublicReelsUseCase result size', () => {
  it('returns at most the requested limit even when the search over-fetches', async () => {
    const candidates = Array.from({ length: 6 }, (_, i) => ({
      reelId: `r${i}`,
      score: 1 - i / 10,
    }));
    const useCase = new SearchPublicReelsUseCase(
      {
        findSearchablePublicReels: jest
          .fn()
          .mockResolvedValue(candidates.map((c) => ({ id: c.reelId }))),
      } as never,
      { searchPublicReels: jest.fn().mockResolvedValue(candidates) },
    );
    const found = await useCase.execute({ query: 'x', limit: 3 });
    expect(found.map((r) => r.reel.id)).toEqual(['r0', 'r1', 'r2']);
  });
});
