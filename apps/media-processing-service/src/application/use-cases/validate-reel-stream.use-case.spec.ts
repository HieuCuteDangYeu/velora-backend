import {
  ReelStreamValidationError,
  ValidateReelStreamUseCase,
} from './validate-reel-stream.use-case';

describe('ValidateReelStreamUseCase', () => {
  const masterKey = 'reels/user-1/attempt-1/master.m3u8';
  const objects = new Map<string, string>([
    [
      masterKey,
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000\nhigh/index.m3u8',
    ],
    [
      'reels/user-1/attempt-1/low/index.m3u8',
      '#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nseg-0.ts\n#EXTINF:2,\nseg-1.ts',
    ],
    [
      'reels/user-1/attempt-1/high/index.m3u8',
      '#EXTM3U\n#EXTINF:2,\nhigh-0.ts\n#EXTINF:2,\nhigh-1.ts',
    ],
    ['reels/user-1/attempt-1/low/init.mp4', 'binary'],
    ['reels/user-1/attempt-1/low/seg-0.ts', 'binary'],
    ['reels/user-1/attempt-1/low/seg-1.ts', 'binary'],
    ['reels/user-1/attempt-1/high/high-0.ts', 'binary'],
    ['reels/user-1/attempt-1/high/high-1.ts', 'binary'],
    ['reels/user-1/attempt-1/thumbnail.jpg', 'binary'],
  ]);

  const makeUseCase = () =>
    new ValidateReelStreamUseCase({
      objectExists: jest.fn((key: string) => Promise.resolve(objects.has(key))),
      getObjectText: jest.fn((key: string) =>
        Promise.resolve(objects.get(key) ?? ''),
      ),
    } as never);

  it('checks every variant, segment, init map, and thumbnail before passing', async () => {
    await expect(
      makeUseCase().execute({
        reelId: 'reel-1',
        s3Prefix: 'reels/user-1/attempt-1',
        thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
      }),
    ).resolves.toBeUndefined();
  });

  it('rejects when a later required segment is missing', async () => {
    objects.delete('reels/user-1/attempt-1/high/high-1.ts');

    await expect(
      makeUseCase().execute({
        reelId: 'reel-1',
        s3Prefix: 'reels/user-1/attempt-1',
        thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
      }),
    ).rejects.toBeInstanceOf(ReelStreamValidationError);

    objects.set('reels/user-1/attempt-1/high/high-1.ts', 'binary');
  });

  it('checks segments concurrently but reports the first missing object in playlist order', async () => {
    const segments = Array.from({ length: 40 }, (_, i) => `seg-${i}.ts`);
    const playlist = `#EXTM3U\n${segments.map((s) => `#EXTINF:2,\n${s}`).join('\n')}`;
    const stored = new Map<string, string>([
      [masterKey, '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow/index.m3u8'],
      ['reels/user-1/attempt-1/low/index.m3u8', playlist],
      ['reels/user-1/attempt-1/thumbnail.jpg', 'binary'],
    ]);
    // seg-30 and seg-12 are missing; seg-12 comes first in the playlist.
    segments
      .filter((s) => s !== 'seg-30.ts' && s !== 'seg-12.ts')
      .forEach((s) => stored.set(`reels/user-1/attempt-1/low/${s}`, 'binary'));

    let inFlight = 0;
    let peak = 0;
    const useCase = new ValidateReelStreamUseCase({
      objectExists: jest.fn(async (key: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return stored.has(key);
      }),
      getObjectText: jest.fn((key: string) =>
        Promise.resolve(stored.get(key) ?? ''),
      ),
    } as never);

    await expect(
      useCase.execute({
        reelId: 'reel-1',
        s3Prefix: 'reels/user-1/attempt-1',
        thumbnailKey: 'reels/user-1/attempt-1/thumbnail.jpg',
      }),
    ).rejects.toMatchObject({
      technicalReason: expect.stringContaining('low/seg-12.ts'),
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(16);
  });
});
