import { GroqKeyPoolExhaustedError } from '../services/groq-key-pool.service';
import { GroqStructuredLlmAdapter } from './groq-structured-llm.adapter';
import { GroqHttpError, GroqTextClient } from './groq-text.client';

const schema = {
  type: 'object' as const,
  properties: { route: { type: 'string', enum: ['rag', 'chat'] } },
  required: ['route'],
  additionalProperties: false,
};

function adapter(chat: jest.Mock) {
  return new GroqStructuredLlmAdapter({ chat } as unknown as GroqTextClient);
}

const input = (overrides: Record<string, unknown> = {}) => ({
  model: 'llama-3.1-8b-instant',
  modelRole: 'ROUTER',
  systemPrompt: 'Route the query.',
  userPrompt: 'hello',
  jsonSchema: schema,
  ...overrides,
});

describe('GroqStructuredLlmAdapter', () => {
  it('uses json_object mode with the schema in the prompt for Llama 3.x', async () => {
    const chat = jest.fn().mockResolvedValue({
      content: '{"route":"rag"}',
      finishReason: 'stop',
      promptTokens: 10,
      completionTokens: 4,
    });
    const diagnostics = jest.fn();
    await expect(
      adapter(chat).generateObject(input({ onDiagnostics: diagnostics })),
    ).resolves.toEqual({ route: 'rag' });
    const request = chat.mock.calls[0][0];
    expect(request.responseFormat).toEqual({ type: 'json_object' });
    expect(request.messages[0].content).toContain('"route"');
    expect(diagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointContract: 'GROQ_CHAT_JSON_OBJECT',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      }),
    );
  });

  it('uses strict json_schema decoding on models that support it', async () => {
    const chat = jest.fn().mockResolvedValue({ content: '{"route":"chat"}' });
    await adapter(chat).generateObject(input({ model: 'openai/gpt-oss-20b' }));
    expect(chat.mock.calls[0][0].responseFormat).toEqual({
      type: 'json_schema',
      json_schema: { name: 'structured_output', strict: true, schema },
    });
  });

  it.each([
    [{ content: '{"route":"other"}' }, 'STRUCTURED_COMPLETION_SCHEMA_INVALID'],
    [{ content: 'not json' }, 'STRUCTURED_COMPLETION_INVALID_JSON'],
    [{ content: '' }, 'STRUCTURED_COMPLETION_EMPTY_CONTENT'],
    [
      { content: '{"route":', finishReason: 'length' },
      'STRUCTURED_COMPLETION_TRUNCATED',
    ],
  ])(
    'maps bad completions to structured error codes',
    async (response, code) => {
      const chat = jest.fn().mockResolvedValue(response);
      await expect(adapter(chat).generateObject(input())).rejects.toMatchObject(
        {
          code,
        },
      );
    },
  );

  it('maps provider failures and retries transient ones for non-router roles', async () => {
    const chat = jest
      .fn()
      .mockRejectedValueOnce(new GroqHttpError(503, 'down'))
      .mockResolvedValueOnce({ content: '{"route":"rag"}' });
    await expect(
      adapter(chat).generateObject(input({ modelRole: 'ANSWER' })),
    ).resolves.toEqual({ route: 'rag' });
    expect(chat).toHaveBeenCalledTimes(2);

    const rateLimited = jest
      .fn()
      .mockRejectedValue(
        new GroqHttpError(
          429,
          'slow down',
          new Headers({ 'retry-after': '3' }),
        ),
      );
    await expect(
      adapter(rateLimited).generateObject(input()),
    ).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
      providerCategory: 'RATE_LIMITED',
      retryAfterMs: 3000,
    });
  });

  it('maps client timeouts and lets pool exhaustion through unmapped', async () => {
    const timeout = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('t'), { code: 'GROQ_TIMEOUT' }),
      );
    await expect(
      adapter(timeout).generateObject(input()),
    ).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_TIMEOUT',
    });
    const exhausted = jest
      .fn()
      .mockRejectedValue(new GroqKeyPoolExhaustedError(2, 2, 0));
    await expect(
      adapter(exhausted).generateObject(input()),
    ).rejects.toBeInstanceOf(GroqKeyPoolExhaustedError);
  });
});
