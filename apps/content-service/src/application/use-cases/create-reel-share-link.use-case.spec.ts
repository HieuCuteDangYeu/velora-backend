import { ReelNotReadyError } from '@content/domain/errors/content.error';
import { CreateReelShareLinkUseCase } from './create-reel-share-link.use-case';

describe('CreateReelShareLinkUseCase validated playback boundary', () => {
  it.each([
    { mediaStatus: 'PENDING', hlsMasterKey: 'reels/user/master.m3u8' },
    { mediaStatus: 'FAILED', hlsMasterKey: 'reels/user/master.m3u8' },
    { mediaStatus: 'COMPLETED', hlsMasterKey: null },
  ])(
    'rejects non-ready media even with a legacy completed status',
    async (media) => {
      const createReelShareLink = jest.fn();
      const useCase = new CreateReelShareLinkUseCase({
        findById: jest.fn().mockResolvedValue({
          id: 'reel',
          userId: 'user',
          status: 'COMPLETED',
          visibility: 'public',
          ...media,
        }),
        createReelShareLink,
      } as never);
      await expect(
        useCase.execute({ reelId: 'reel', createdBy: 'user' }),
      ).rejects.toBeInstanceOf(ReelNotReadyError);
      expect(createReelShareLink).not.toHaveBeenCalled();
    },
  );

  it('shares validated playable HLS while indexing is processing', async () => {
    const createReelShareLink = jest.fn().mockResolvedValue({ id: 'link' });
    const useCase = new CreateReelShareLinkUseCase({
      findById: jest.fn().mockResolvedValue({
        id: 'reel',
        userId: 'user',
        status: 'COMPLETED',
        mediaStatus: 'COMPLETED',
        indexStatus: 'PROCESSING',
        hlsMasterKey: 'reels/user/master.m3u8',
        visibility: 'public',
      }),
      findReelShareLinkByToken: jest.fn().mockResolvedValue(null),
      createReelShareLink,
    } as never);
    await expect(
      useCase.execute({
        reelId: 'reel',
        createdBy: 'user',
        reuseExisting: false,
      }),
    ).resolves.toEqual({ id: 'link' });
    expect(createReelShareLink).toHaveBeenCalledTimes(1);
  });
});
