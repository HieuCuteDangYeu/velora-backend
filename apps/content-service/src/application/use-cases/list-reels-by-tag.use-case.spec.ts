import { ListReelsByTagUseCase } from '@content/application/use-cases/list-reels-by-tag.use-case';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';

describe('ListReelsByTagUseCase', () => {
  const build = () => {
    const listReelsByTag = jest
      .fn()
      .mockResolvedValue({ items: [], nextCursor: null });
    const getFeedAudience = jest
      .fn()
      .mockResolvedValue({ friendUserIds: [], excludedUserIds: ['blocked'] });
    const useCase = new ListReelsByTagUseCase(
      { listReelsByTag } as unknown as IContentRepository,
      { getFeedAudience } as unknown as IFriendContentAccessService,
    );

    return { useCase, listReelsByTag, getFeedAudience };
  };

  it('normalizes the tag, clamps the limit, and excludes blocked authors', async () => {
    const { useCase, listReelsByTag } = build();

    await useCase.execute({ viewerId: 'viewer', tag: '#Garena', limit: 500 });

    expect(listReelsByTag).toHaveBeenCalledWith({
      tag: 'garena',
      limit: 50,
      cursor: undefined,
      excludedUserIds: ['blocked'],
    });
  });

  it('returns an empty page without touching storage for unusable tags', async () => {
    const { useCase, listReelsByTag, getFeedAudience } = build();

    await expect(
      useCase.execute({ viewerId: 'viewer', tag: '#' }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(listReelsByTag).not.toHaveBeenCalled();
    expect(getFeedAudience).not.toHaveBeenCalled();
  });
});
