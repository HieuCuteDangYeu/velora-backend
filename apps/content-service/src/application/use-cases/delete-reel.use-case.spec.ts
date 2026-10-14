import { DeleteReelUseCase } from './delete-reel.use-case';

describe('DeleteReelUseCase media ownership cleanup', () => {
  it('preserves an output prefix still adopted by another Reel', async () => {
    const storage = {
      listObjects: jest.fn(),
      deleteObjects: jest.fn(),
    };
    const useCase = new DeleteReelUseCase(
      {
        findById: jest.fn().mockResolvedValue({
          id: 'reel-1',
          mediaKey: 'reels/user-1/source.mp4',
          hlsMasterKey: 'reels/user-1/source/legacy/master.m3u8',
          thumbnailKey: 'reels/user-1/source/legacy/thumbnail.jpg',
        }),
        deleteReel: jest.fn().mockResolvedValue(true),
        isReelMediaOutputPrefixProtected: jest.fn().mockResolvedValue(true),
      } as never,
      storage as never,
    );

    await expect(useCase.execute('reel-1', 'user-1')).resolves.toBe(true);
    expect(storage.listObjects).not.toHaveBeenCalled();
    expect(storage.deleteObjects).not.toHaveBeenCalled();
  });
});
