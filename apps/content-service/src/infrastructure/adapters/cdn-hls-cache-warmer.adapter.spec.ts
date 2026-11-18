import { ConfigService } from '@nestjs/config';
import { CdnHlsCacheWarmerAdapter } from './cdn-hls-cache-warmer.adapter';

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=480x854
480p/index.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=720x1280
720p/index.m3u8
`;
const VARIANT = `#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
seg0.m4s
#EXTINF:4.0,
seg1.m4s
`;

function response(body: string, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
  } as unknown as Response;
}

describe('CdnHlsCacheWarmerAdapter', () => {
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation((input: string | URL) => {
        const url = String(input);
        if (url.endsWith('master.m3u8'))
          return Promise.resolve(response(MASTER));
        if (url.endsWith('index.m3u8'))
          return Promise.resolve(response(VARIANT));
        return Promise.resolve(response('', 206));
      });
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const build = (env: Record<string, string>) =>
    new CdnHlsCacheWarmerAdapter(new ConfigService(env));
  const urls = () => fetchMock.mock.calls.map(([input]) => String(input));

  it('requests the master, every variant, and each variant first segment and init segment', async () => {
    build({ R2_PUBLIC_DOMAIN: 'https://cdn.example.test/' }).warm(
      'reels/r1/a/master.m3u8',
    );
    for (let tick = 0; tick < 10; tick += 1) await settle();

    expect(urls().sort()).toEqual(
      [
        'https://cdn.example.test/reels/r1/a/master.m3u8',
        'https://cdn.example.test/reels/r1/a/480p/index.m3u8',
        'https://cdn.example.test/reels/r1/a/480p/init.mp4',
        'https://cdn.example.test/reels/r1/a/480p/seg0.m4s',
        'https://cdn.example.test/reels/r1/a/720p/index.m3u8',
        'https://cdn.example.test/reels/r1/a/720p/init.mp4',
        'https://cdn.example.test/reels/r1/a/720p/seg0.m4s',
      ].sort(),
    );
    const segmentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).endsWith('.m4s'),
    );
    for (const [, init] of segmentCalls) {
      expect((init as RequestInit).headers).toEqual({ Range: 'bytes=0-0' });
    }
  });

  it('does nothing when switched off or without a CDN domain', () => {
    build({
      R2_PUBLIC_DOMAIN: 'https://cdn.example.test',
      HLS_CDN_WARM_ENABLED: 'false',
    }).warm('reels/r1/master.m3u8');
    build({}).warm('reels/r1/master.m3u8');

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never throws or rejects when the CDN fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const adapter = build({ R2_PUBLIC_DOMAIN: 'https://cdn.example.test' });

    expect(() => adapter.warm('reels/r1/master.m3u8')).not.toThrow();
    for (let tick = 0; tick < 5; tick += 1) await settle();
  });

  it('keeps going when one variant playlist is missing', async () => {
    fetchMock.mockImplementation((input: string | URL) => {
      const url = String(input);
      if (url.endsWith('master.m3u8')) return Promise.resolve(response(MASTER));
      if (url.includes('480p/index.m3u8'))
        return Promise.resolve(response('', 404));
      if (url.endsWith('index.m3u8')) return Promise.resolve(response(VARIANT));
      return Promise.resolve(response('', 206));
    });
    build({ R2_PUBLIC_DOMAIN: 'https://cdn.example.test' }).warm(
      'reels/r1/master.m3u8',
    );
    for (let tick = 0; tick < 10; tick += 1) await settle();

    expect(urls()).toContain('https://cdn.example.test/reels/r1/720p/seg0.m4s');
  });
});
