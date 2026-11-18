import { ConfigService } from '@nestjs/config';
import { MuseStructuredLlmAdapter } from './muse-structured-llm.adapter';

const schema = {
  type: 'object' as const,
  additionalProperties: false,
  required: ['title', 'tags'],
  properties: {
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
  },
};
const request = { systemPrompt: 's', userPrompt: 'u', jsonSchema: schema };

function reply(content: string, status = 200) {
  return {
    ok: status < 400,
    status,
    text: () => Promise.resolve(''),
    json: () => Promise.resolve({ choices: [{ message: { content } }] }),
  } as unknown as Response;
}

describe('MuseStructuredLlmAdapter', () => {
  let fetchMock: jest.SpyInstance;
  const adapter = new MuseStructuredLlmAdapter({
    get: (key: string) =>
      ({ MUSE_BASE_URL: 'http://muse.test/v1/' })[key as 'MUSE_BASE_URL'],
  } as unknown as ConfigService);

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });
  afterEach(() => fetchMock.mockRestore());

  it('parses a plain JSON reply and posts the schema in the system prompt', async () => {
    fetchMock.mockResolvedValue(reply('{"title":"a","tags":["x"]}'));
    await expect(adapter.generateObject(request)).resolves.toEqual({
      title: 'a',
      tags: ['x'],
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://muse.test/v1/chat/completions');
    const body = JSON.parse(init.body as string) as {
      messages: Array<{ content: string }>;
    };
    expect(body.messages[0].content).toContain('"required":["title","tags"]');
  });

  it('skips a garbled first attempt and uses the complete object after it', async () => {
    fetchMock.mockResolvedValue(
      reply(
        '{"title": "a", "tags": "x", "y", "dark{"title":"good","tags":["x","y"]}',
      ),
    );
    await expect(adapter.generateObject(request)).resolves.toEqual({
      title: 'good',
      tags: ['x', 'y'],
    });
  });

  it('accepts a fenced reply', async () => {
    fetchMock.mockResolvedValue(reply('```json\n{"title":"a","tags":[]}\n```'));
    await expect(adapter.generateObject(request)).resolves.toEqual({
      title: 'a',
      tags: [],
    });
  });

  it('retries once on invalid JSON and then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(reply('no json here'))
      .mockResolvedValueOnce(reply('{"title":"a","tags":[]}'));
    await expect(adapter.generateObject(request)).resolves.toEqual({
      title: 'a',
      tags: [],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects a reply that violates the schema', async () => {
    fetchMock.mockResolvedValue(reply('{"title":1,"tags":[]}'));
    await expect(adapter.generateObject(request)).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
    });
  });

  it('maps a gateway 5xx to a transient provider error after retrying', async () => {
    fetchMock.mockResolvedValue(reply('', 502));
    await expect(adapter.generateObject(request)).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      transient: true,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401', async () => {
    fetchMock.mockResolvedValue(reply('', 401));
    await expect(adapter.generateObject(request)).rejects.toMatchObject({
      providerCategory: 'AUTH_OR_CONFIGURATION_FAILURE',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never runs more than MUSE_MAX_CONCURRENCY requests at once', async () => {
    const limited = new MuseStructuredLlmAdapter({
      get: (key: string): string | undefined =>
        (({ MUSE_MAX_CONCURRENCY: '2' }) as Record<string, string>)[key],
    } as unknown as ConfigService);
    let running = 0;
    let peak = 0;
    fetchMock.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 20));
      running -= 1;
      return reply('{"title":"a","tags":[]}');
    });
    await Promise.all(
      Array.from({ length: 6 }, () => limited.generateObject(request)),
    );
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(peak).toBe(2);
  });

  it('gives up waiting for a slot so the caller can fall back', async () => {
    const limited = new MuseStructuredLlmAdapter({
      get: (key: string): string | undefined =>
        (
          ({ MUSE_MAX_CONCURRENCY: '1', MUSE_TIMEOUT_MS: '5000' }) as Record<
            string,
            string
          >
        )[key],
    } as unknown as ConfigService);
    fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
    jest.useFakeTimers();
    const first = limited.generateObject(request).catch((e: unknown) => e);
    const second = limited
      .generateObject({ ...request, timeoutMs: 1000 })
      .catch((e: unknown) => e);
    await jest.advanceTimersByTimeAsync(6000);
    await expect(second).resolves.toMatchObject({
      code: 'STRUCTURED_COMPLETION_TIMEOUT',
    });
    jest.useRealTimers();
    void first;
  });
});
