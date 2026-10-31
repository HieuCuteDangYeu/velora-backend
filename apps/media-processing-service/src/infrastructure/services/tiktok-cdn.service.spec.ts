import { ConfigService } from '@nestjs/config';
import { TikTokCdnService } from './tiktok-cdn.service';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

describe('TikTok adaptive playlist upload', () => {
  let directory: string;
  const originalFetch = global.fetch;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'velora-cdn-'));
    for (const variant of ['0', '1']) {
      fs.mkdirSync(path.join(directory, variant));
      fs.writeFileSync(
        path.join(directory, variant, 'segment_000000.ts'),
        `transport-${variant}`,
      );
      fs.writeFileSync(
        path.join(directory, variant, 'stream.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXTINF:2,\nsegment_000000.ts\n#EXT-X-ENDLIST\n',
      );
    }
    fs.writeFileSync(
      path.join(directory, 'master.m3u8'),
      '#EXTM3U\n0/stream.m3u8\n1/stream.m3u8\n',
    );
  });
  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  function service() {
    return new TikTokCdnService(
      new ConfigService({
        TIKTOK_CDN_UPLOAD_ENDPOINT: 'https://upload.example',
        TIKTOK_CDN_CSRF_TOKEN: 'test',
        TIKTOK_CDN_UUID: 'test',
        TIKTOK_CDN_COOKIE: 'test',
      }),
    );
  }

  it('binds repeated segment basenames to their actual rendition directory', async () => {
    let counter = 0;
    global.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            code: 0,
            data: { url: `https://cdn.example/${counter++}.png` },
          }),
        ),
      ),
    );
    await service().uploadHlsDirectory(directory);
    const first = fs.readFileSync(
      path.join(directory, '0/stream.m3u8'),
      'utf8',
    );
    const second = fs.readFileSync(
      path.join(directory, '1/stream.m3u8'),
      'utf8',
    );
    expect(first).toContain('https://cdn.example/0.png');
    expect(second).toContain('https://cdn.example/1.png');
    expect(second).not.toContain('https://cdn.example/0.png');
    expect(first).toContain('#EXT-X-BYTERANGE:11@67');
    expect(
      fs.readFileSync(path.join(directory, 'master.m3u8'), 'utf8'),
    ).toContain('0/stream.m3u8');
  });

  it('keeps local playlists and segments when a partial upload fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('upload failed'));
    await expect(service().uploadHlsDirectory(directory)).rejects.toThrow(
      'upload failed',
    );
    expect(fs.existsSync(path.join(directory, '0/segment_000000.ts'))).toBe(
      true,
    );
    expect(
      fs.readFileSync(path.join(directory, '1/stream.m3u8'), 'utf8'),
    ).toContain('segment_000000.ts');
  });
});
