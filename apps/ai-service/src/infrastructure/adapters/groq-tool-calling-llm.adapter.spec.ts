import { ConfigService } from '@nestjs/config';
import { GroqKeyPool } from '../services/groq-key-pool.service';
import { GroqToolCallingLlmAdapter } from './groq-tool-calling-llm.adapter';

describe('GroqToolCallingLlmAdapter provider boundaries', () => {
  const config = {
    get: (key: string) => (key === 'GROQ_API_KEYS' ? 'test-key' : undefined),
  } as unknown as ConfigService;
  let pool: GroqKeyPool;
  beforeEach(() => {
    pool = new GroqKeyPool(config);
    pool.onModuleInit();
  });
  afterEach(() => {
    pool.onModuleDestroy();
    jest.restoreAllMocks();
  });
  const input = {
    model: 'tool-model',
    messages: [{ role: 'user' as const, content: 'question' }],
    tools: [],
  };

  it('can use the tool model when the answer model is exhausted', async () => {
    pool.reportTPDExhausted(0, undefined, 'answer-model');
    const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
        }),
      ),
    );
    const adapter = new GroqToolCallingLlmAdapter(config, pool);
    await expect(adapter.complete(input)).resolves.toMatchObject({
      content: 'done',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      adapter.complete({ ...input, model: 'answer-model' }),
    ).rejects.toMatchObject({ code: 'GROQ_KEY_POOL_EXHAUSTED' });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves HTTP status for non-JSON rate-limit responses', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('upstream rate limit', {
        status: 429,
        headers: { 'retry-after': '60' },
      }),
    );
    const adapter = new GroqToolCallingLlmAdapter(config, pool);
    await expect(adapter.complete(input)).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_HTTP_ERROR',
      httpStatus: 429,
    });
  });
});
