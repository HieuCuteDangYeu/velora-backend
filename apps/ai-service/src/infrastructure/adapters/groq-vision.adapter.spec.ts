import { ConfigService } from '@nestjs/config';
import { GroqVisionAdapter } from './groq-vision.adapter';

const config = (values: Record<string, string>) =>
  ({
    get: (key: string) => values[key],
    getOrThrow: (key: string) => {
      if (!(key in values)) throw new Error(`missing ${key}`);
      return values[key];
    },
  }) as unknown as ConfigService;

const answer = (content: unknown) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
  });

const image = {
  image: new Uint8Array([1, 2, 3]),
  mimeType: 'image/jpeg' as const,
};

const authOf = (call: unknown[]): string =>
  (call[1] as { headers: Record<string, string> }).headers.Authorization;
const bodyOf = (
  call: unknown[],
): {
  response_format: unknown;
  messages: Array<{ content: Array<{ image_url?: { url: string } }> }>;
} =>
  JSON.parse((call[1] as { body: string }).body) as ReturnType<typeof bodyOf>;

describe('GroqVisionAdapter', () => {
  const fetchMock = jest.fn<
    ReturnType<typeof fetch>,
    Parameters<typeof fetch>
  >();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock;
  });

  it('sends the frame to the vision model and parses the JSON answer', async () => {
    fetchMock.mockResolvedValueOnce(
      answer(
        JSON.stringify({
          caption: ' A man  in a coat. ',
          ocrText: '',
          objects: ['coat', 'coat', ' hat '],
        }),
      ),
    );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'shared-key', AI_VISION_TIMEOUT_MS: '30000' }),
    );
    await expect(adapter.analyzeImage(image)).resolves.toEqual({
      caption: 'A man in a coat.',
      objects: ['coat', 'hat'],
      provider: 'groq',
      model: 'qwen/qwen3.8-27b',
      version: 'groq-qwen3.8-27b-vision-2026-11',
    });
    const call = fetchMock.mock.calls[0] as unknown[];
    expect(call[0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    const body = bodyOf(call);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[1].content[1].image_url?.url).toBe(
      `data:image/jpeg;base64,${Buffer.from([1, 2, 3]).toString('base64')}`,
    );
  });

  it('uses only the dedicated vision keys when GROQ_VISION_API_KEYS is set', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        answer(
          JSON.stringify({ caption: 'A room.', ocrText: '', objects: [] }),
        ),
      ),
    );
    const adapter = new GroqVisionAdapter(
      config({
        GROQ_API_KEYS: 'free-a,paid-b',
        GROQ_VISION_API_KEYS: 'free-a,free-c',
      }),
    );
    await adapter.analyzeImage(image);
    await adapter.analyzeImage(image);
    await adapter.analyzeImage(image);
    const used = fetchMock.mock.calls.map((call) => authOf(call));
    expect(used).toEqual(['Bearer free-a', 'Bearer free-c', 'Bearer free-a']);
    expect(used).not.toContain('Bearer paid-b');
  });

  it('retries a rate-limited frame on the next key', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"rate_limit_exceeded"}}', {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      )
      .mockResolvedValueOnce(
        answer(JSON.stringify({ caption: 'A room.', objects: [] })),
      );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'key-a,key-b' }),
    );
    await expect(adapter.analyzeImage(image)).resolves.toMatchObject({
      caption: 'A room.',
    });
    expect(fetchMock.mock.calls.map((call) => authOf(call))).toEqual([
      'Bearer key-a',
      'Bearer key-b',
    ]);
  });

  it('reports a rate-limit error the fallback can recognise when every key is limited', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response('{"error":{"message":"rate_limit_exceeded"}}', {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      ),
    );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'key-a,key-b' }),
    );
    await expect(adapter.analyzeImage(image)).rejects.toThrow(
      /429|rate limit/i,
    );
  });

  it.each([
    ['empty content', answer('')],
    ['non-JSON content', answer('not json')],
    ['a missing caption', answer(JSON.stringify({ caption: '', objects: [] }))],
    [
      'invalid objects',
      answer(JSON.stringify({ caption: 'x', objects: 'tree' })),
    ],
  ])('rejects %s', async (_name, response) => {
    fetchMock.mockResolvedValueOnce(response);
    const adapter = new GroqVisionAdapter(config({ GROQ_API_KEYS: 'key-a' }));
    await expect(adapter.analyzeImage(image)).rejects.toThrow(/Groq vision/);
  });

  it('does not retry non-rate-limit failures', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('bad request', { status: 400 }),
    );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'key-a,key-b' }),
    );
    await expect(adapter.analyzeImage(image)).rejects.toThrow(/status 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a timed-out frame on the next key', async () => {
    fetchMock
      .mockImplementationOnce(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            (init?.signal as AbortSignal).addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      )
      .mockImplementationOnce(() =>
        Promise.resolve(
          answer(JSON.stringify({ caption: 'A room.', objects: [] })),
        ),
      );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'key-a,key-b', GROQ_VISION_TIMEOUT_MS: '1000' }),
    );
    await expect(adapter.analyzeImage(image)).resolves.toMatchObject({
      caption: 'A room.',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries a server error and then reports a non-rate-limit failure', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('upstream down', { status: 503 })),
    );
    const adapter = new GroqVisionAdapter(
      config({ GROQ_API_KEYS: 'key-a,key-b' }),
    );
    const failure = adapter.analyzeImage(image);
    await expect(failure).rejects.toThrow(/failed after 2 attempts.*503/);
    await expect(failure).rejects.not.toThrow(/429|rate limit/i);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
