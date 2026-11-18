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

  describe('CDN-hosted segments', () => {
    const prefix = 'reels/user-1/attempt-1';
    const urls = Array.from(
      { length: 48 },
      (_, i) => `https://cdn.example/seg-${i}.png`,
    );
    const originalFetch = global.fetch;
    afterEach(() => {
      global.fetch = originalFetch;
    });

    const build = () =>
      new ValidateReelStreamUseCase({
        objectExists: jest.fn((key: string) =>
          Promise.resolve(
            key === `${prefix}/thumbnail.jpg` ||
              key.endsWith('master.m3u8') ||
              key.endsWith('index.m3u8'),
          ),
        ),
        getObjectText: jest.fn((key: string) =>
          Promise.resolve(
            key.endsWith('master.m3u8')
              ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow/index.m3u8'
              : `#EXTM3U\n${urls.map((u) => `#EXT-X-BYTERANGE:10@67\n${u}`).join('\n')}`,
          ),
        ),
      } as never);
    const run = () =>
      build().execute({
        reelId: 'reel-1',
        s3Prefix: prefix,
        thumbnailKey: `${prefix}/thumbnail.jpg`,
      });

    it('spot-checks six URLs per rendition, including the first and the last, one at a time', async () => {
      const seen: string[] = [];
      let inFlight = 0;
      let peak = 0;
      global.fetch = jest.fn(async (url: string) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        seen.push(url);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        return new Response(null, { status: 206 });
      });

      await expect(run()).resolves.toBeUndefined();
      expect(seen).toHaveLength(6);
      expect(seen[0]).toBe(urls[0]);
      expect(seen[5]).toBe(urls[47]);
      expect(peak).toBe(1);
    });

    it('does not fail the stream for one dropped or not-yet-served CDN request', async () => {
      const calls = new Map<string, number>();
      global.fetch = jest.fn((url: string) => {
        const count = (calls.get(url) ?? 0) + 1;
        calls.set(url, count);
        if (url.endsWith('seg-0.png') && count === 1) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        if (url.endsWith('seg-47.png') && count === 1) {
          return Promise.reject(new Error('socket hang up'));
        }
        return Promise.resolve(new Response(null, { status: 206 }));
      });

      await expect(run()).resolves.toBeUndefined();
      expect(calls.get(urls[0])).toBe(2);
      expect(calls.get(urls[47])).toBe(2);
    });

    it('fails when a sampled URL is not reachable', async () => {
      global.fetch = jest.fn((url: string) =>
        Promise.resolve(
          new Response(null, {
            status: url.endsWith('seg-47.png') ? 404 : 206,
          }),
        ),
      );

      await expect(run()).rejects.toMatchObject({
        technicalReason: expect.stringContaining('seg-47.png'),
      });
    });
  });
});
