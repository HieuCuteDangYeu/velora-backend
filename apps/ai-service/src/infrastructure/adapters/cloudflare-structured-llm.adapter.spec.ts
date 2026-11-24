import { ConfigService } from '@nestjs/config';
import { CloudflareStructuredLlmAdapter } from './cloudflare-structured-llm.adapter';

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

describe('CloudflareStructuredLlmAdapter', () => {
  let fetchMock: jest.SpyInstance;
  const values: Record<string, string> = {
    CLOUDFLARE_ACCOUNT_ID: 'acct',
    CLOUDFLARE_API_TOKEN: 'tok',
    AI_CLOUDFLARE_LLM_MODEL: '@cf/test/big-model',
  };
  const adapter = new CloudflareStructuredLlmAdapter({
    get: (key: string) => values[key],
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
    expect(url).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/v1/chat/completions',
    );
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

  it('fails as a configuration error, without calling the network, when no model is set', async () => {
    const unconfigured = new CloudflareStructuredLlmAdapter({
      get: (key: string) =>
        key === 'CLOUDFLARE_ACCOUNT_ID' ? 'acct' : undefined,
    } as unknown as ConfigService);
    await expect(unconfigured.generateObject(request)).rejects.toMatchObject({
      status: undefined,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
