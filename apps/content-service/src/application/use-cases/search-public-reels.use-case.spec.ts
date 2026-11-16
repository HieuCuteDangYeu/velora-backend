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
