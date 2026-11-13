import { SearchReelTagsUseCase } from '@content/application/use-cases/search-reel-tags.use-case';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';

describe('SearchReelTagsUseCase', () => {
  const build = () => {
    const searchReelTags = jest.fn().mockResolvedValue([]);
    const useCase = new SearchReelTagsUseCase({
      searchReelTags,
    } as unknown as IContentRepository);

    return { useCase, searchReelTags };
  };

  it('lists trending tags when no query is given', async () => {
    const { useCase, searchReelTags } = build();

    await useCase.execute({ limit: 10 });

    expect(searchReelTags).toHaveBeenCalledWith({ limit: 10 });
  });

  it('normalizes the query and clamps the limit', async () => {
    const { useCase, searchReelTags } = build();

    await useCase.execute({ query: '  #Corporate_Humor ', limit: 99 });

    expect(searchReelTags).toHaveBeenCalledWith({
      query: 'corporate humor',
      limit: 30,
    });
  });

  it('falls back to trending when the query is only a hash', async () => {
    const { useCase, searchReelTags } = build();

    await useCase.execute({ query: '#' });

    expect(searchReelTags).toHaveBeenCalledWith({ limit: 12 });
  });
});
