import { ReelMediaCleanupService } from './reel-media-cleanup.service';

describe('ReelMediaCleanupService', () => {
  it('defaults to no deletion and dry-runs when apply is disabled', async () => {
    const repository = {
      listExpiredReelUploadLeases: jest.fn().mockResolvedValue([
        {
          id: 'lease-1',
          mediaKey: 'reels/user-1/intent.mp4',
          expiresAt: new Date(0),
        },
      ]),
      isReelMediaOutputPrefixProtected: jest.fn().mockResolvedValue(false),
      cleanupExpiredReelUploadLease: jest.fn(),
    };
    const storage = {
      listObjects: jest
        .fn()
        .mockResolvedValue([
          'reels/user-1/source/33333333-3333-4333-8333-333333333333/master.m3u8',
        ]),
      deleteObjects: jest.fn(),
    };
    const service = new ReelMediaCleanupService(
      repository as never,
      storage as never,
      {
        get: jest.fn((key: string) =>
          key === 'REEL_MEDIA_CLEANUP_ENABLED' ? 'true' : 'false',
        ),
      } as never,
    );

    await service.cleanup();

    expect(storage.deleteObjects).not.toHaveBeenCalled();
    expect(repository.cleanupExpiredReelUploadLease).not.toHaveBeenCalled();
  });

  it('applies deletion only when explicitly enabled and unprotected', async () => {
    const repository = {
      listExpiredReelUploadLeases: jest.fn().mockResolvedValue([
        {
          id: 'lease-1',
          mediaKey: 'reels/user-1/intent.mp4',
          expiresAt: new Date(0),
        },
      ]),
      isReelMediaOutputPrefixProtected: jest.fn().mockResolvedValue(false),
      cleanupExpiredReelUploadLease: jest.fn().mockResolvedValue(true),
      completeReelUploadLeaseCleanup: jest.fn().mockResolvedValue(true),
    };
    const storage = {
      listObjects: jest
        .fn()
        .mockResolvedValue([
          'reels/user-1/source/33333333-3333-4333-8333-333333333333/master.m3u8',
          'reels/user-1/source/33333333-3333-4333-8333-333333333333/segment.ts',
        ]),
      deleteObjects: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ReelMediaCleanupService(
      repository as never,
      storage as never,
      {
        get: jest.fn((key: string) =>
          key === 'REEL_MEDIA_CLEANUP_ENABLED' ? 'true' : 'true',
        ),
      } as never,
    );

    await service.cleanup();

    expect(repository.cleanupExpiredReelUploadLease).toHaveBeenCalledWith(
      'lease-1',
      expect.any(Date),
    );
    expect(storage.deleteObjects).toHaveBeenCalledWith([
      'reels/user-1/source/33333333-3333-4333-8333-333333333333/master.m3u8',
      'reels/user-1/source/33333333-3333-4333-8333-333333333333/segment.ts',
    ]);
  });
});
