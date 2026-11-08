import { ConfigService } from '@nestjs/config';
import {
  GroqKeyPool,
  GroqKeyPoolExhaustedError,
} from '../services/groq-key-pool.service';
import { GroqHttpError, GroqTextClient } from './groq-text.client';

const config = (values: Record<string, string>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

function client(keys: string) {
  const configService = config({ GROQ_API_KEYS: keys });
  const pool = new GroqKeyPool(configService);
  pool.onModuleInit();
  return { client: new GroqTextClient(configService, pool), pool };
}

const completion = (content: string) =>
  new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    }),
    { status: 200 },
  );

describe('GroqTextClient', () => {
  const fetchMock = jest.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  it('sends the pooled key and returns content with token usage', async () => {
    fetchMock.mockResolvedValueOnce(completion('hello'));
    const { client: groq, pool } = client('key-a,key-b');
    const result = await groq.chat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result).toEqual({
      content: 'hello',
      finishReason: 'stop',
      promptTokens: 12,
      completionTokens: 3,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer key-a');
    pool.onModuleDestroy();
  });

  it('retries a rate-limited call on the next organization key', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response('{"error":{"message":"rate_limit_exceeded"}}', {
          status: 429,
          headers: { 'retry-after': '2' },
        }),
      )
      .mockResolvedValueOnce(completion('ok'));
    const { client: groq, pool } = client('key-a,key-b');
    const result = await groq.chat({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(result.content).toBe('ok');
    expect(
      fetchMock.mock.calls.map(([, init]) => init.headers.Authorization),
    ).toEqual(['Bearer key-a', 'Bearer key-b']);
    pool.onModuleDestroy();
  });

  it('does not retry client errors', async () => {
    fetchMock.mockResolvedValueOnce(new Response('bad model', { status: 404 }));
    const { client: groq, pool } = client('key-a,key-b');
    await expect(
      groq.chat({ model: 'nope', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toBeInstanceOf(GroqHttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    pool.onModuleDestroy();
  });

  it('streams SSE tokens and reports usage', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":7,"completion_tokens":2}}}',
      'data: [DONE]',
      '',
    ].join('\n\n');
    fetchMock.mockResolvedValueOnce(new Response(sse, { status: 200 }));
    const { client: groq, pool } = client('key-a');
    const tokens: string[] = [];
    const result = await groq.chat({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'hi' }],
      onToken: (token) => tokens.push(token),
    });
    expect(tokens).toEqual(['Hel', 'lo']);
    expect(result).toMatchObject({
      content: 'Hello',
      finishReason: 'stop',
      promptTokens: 7,
      completionTokens: 2,
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).stream).toBe(true);
    pool.onModuleDestroy();
  });

  it('surfaces pool exhaustion once every key is spent for the day', async () => {
    const { client: groq, pool } = client('key-a');
    pool.reportTPDExhausted(0, 'test', 'llama-3.1-8b-instant');
    await expect(
      groq.chat({
        model: 'llama-3.1-8b-instant',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).rejects.toBeInstanceOf(GroqKeyPoolExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
    pool.onModuleDestroy();
  });
});
