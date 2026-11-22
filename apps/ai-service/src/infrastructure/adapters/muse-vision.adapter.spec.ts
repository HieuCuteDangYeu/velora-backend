import { ConfigService } from '@nestjs/config';
import { MuseVisionAdapter } from './muse-vision.adapter';
import { FallbackVisionAdapter } from './fallback-vision.adapter';

const frame = {
  image: new Uint8Array([1, 2, 3]),
  mimeType: 'image/jpeg' as const,
};
const chat = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });
const adapter = (extra: Record<string, string> = {}) =>
  new MuseVisionAdapter(
    new ConfigService({
      MUSE_BASE_URL: 'http://muse:18611/v1',
      MUSE_API_KEY: 'k',
      ...extra,
    }),
  );

describe('MuseVisionAdapter', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends the frame as an image_url and maps the reply', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        chat(
          '{"caption":" A  cat ","ocrText":"","objects":["cat","cat","rug"]}',
        ),
      );
    await expect(adapter().analyzeImage(frame)).resolves.toMatchObject({
      caption: 'A cat',
      objects: ['cat', 'rug'],
      provider: 'muse2api',
    });
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.messages[1].content[1].image_url.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
  });

  it('takes the complete object after a garbled first attempt', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        chat(
          '{"caption": "x", oops {"caption":"A dog","ocrText":"STOP","objects":[]}',
        ),
      );
    await expect(adapter().analyzeImage(frame)).resolves.toMatchObject({
      caption: 'A dog',
      ocrText: 'STOP',
    });
  });

  it('rejects a reply with no caption and a non-2xx status', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValueOnce(chat('no json here'));
    await expect(adapter().analyzeImage(frame)).rejects.toThrow('parsable');
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(new Response('x', { status: 502 }));
    await expect(adapter().analyzeImage(frame)).rejects.toThrow('status 502');
  });

  it('is the overflow when AI_VISION_FALLBACK_PROVIDER=muse', async () => {
    const primary = {
      analyzeImage: jest
        .fn()
        .mockRejectedValue(new Error('daily free allocation spent')),
    };
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(chat('{"caption":"overflow","objects":[]}'));
    const fallback = new FallbackVisionAdapter(
      new ConfigService({
        AI_VISION_FALLBACK_PROVIDER: 'muse',
        MUSE_BASE_URL: 'http://muse:18611/v1',
      }),
      primary,
    );
    await expect(fallback.analyzeImage(frame)).resolves.toMatchObject({
      caption: 'overflow',
      provider: 'muse2api',
    });
  });
});
