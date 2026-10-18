import { CloudflareVisionAdapter } from './cloudflare-vision.adapter';

describe('CloudflareVisionAdapter', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  const config = {
    getOrThrow: jest.fn((key: string) => {
      const values: Record<string, string> = {
        CLOUDFLARE_ACCOUNT_ID: 'account',
        CLOUDFLARE_API_TOKEN: 'token',
        AI_VISION_MODEL: '@cf/test/vision',
        AI_VISION_VERSION: 'vision-v2',
        AI_VISION_TIMEOUT_MS: '30000',
      };
      const value = values[key];
      if (!value) throw new Error(`Missing ${key}`);
      return value;
    }),
    get: jest.fn((key: string) =>
      key === 'CLOUDFLARE_AI_GATEWAY_ENABLED' ? 'false' : undefined,
    ),
  };

  it('sends an OpenAI-compatible multimodal request and parses JSON', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '{"caption":"A sampled frame","ocrText":"VLR-9281","objects":["text"]}',
              },
            },
          ],
        }),
      ),
    });
    const adapter = new CloudflareVisionAdapter(config as never);

    await expect(
      adapter.analyzeImage({
        image: new Uint8Array([1]),
        mimeType: 'image/jpeg',
      }),
    ).resolves.toMatchObject({
      caption: 'A sampled frame',
      ocrText: 'VLR-9281',
      objects: ['text'],
      model: '@cf/test/vision',
      version: 'vision-v2',
    });

    const [, request] = (global.fetch as jest.Mock).mock.calls[0];
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body['model']).toBe('@cf/test/vision');
    expect(body['response_format']).toMatchObject({ type: 'json_object' });
    expect(JSON.stringify(body['messages'])).toContain(
      'data:image/jpeg;base64,AQ==',
    );
    expect(JSON.stringify(body['messages'])).toContain(
      'caption (a non-empty factual string)',
    );
    expect(JSON.stringify(body['messages'])).toContain(
      'ocrText (a string containing only clearly readable text and empty when it cannot be read)',
    );
    expect(JSON.stringify(body['messages'])).toContain(
      'objects (an array of short grounded strings)',
    );
    expect(request.headers).toMatchObject({ 'cf-aig-skip-cache': 'true' });
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['prose instead of JSON', 'A sampled frame'],
    [
      'a malformed objects array',
      '{"caption":"A frame","ocrText":"","objects":[7]}',
    ],
  ])('rejects %s', async (_case, content) => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: jest
        .fn()
        .mockResolvedValue(
          JSON.stringify({ choices: [{ message: { content } }] }),
        ),
    });
    const adapter = new CloudflareVisionAdapter(config as never);

    await expect(
      adapter.analyzeImage({
        image: new Uint8Array([1]),
        mimeType: 'image/png',
      }),
    ).rejects.toThrow(/structured JSON|invalid objects/);
  });
});
