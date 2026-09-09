import { ConfigService } from '@nestjs/config';
import {
  GroqStructuredCompletionProviderError,
  GroqStructuredLlmAdapter,
} from './groq-structured-llm.adapter';

describe('GroqStructuredLlmAdapter', () => {
  const schema = {
    type: 'object' as const,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  };

  const config = (values: Record<string, string> = {}) =>
    new ConfigService({
      GROQ_API_KEY: 'test-key',
      GROQ_BASE_URL: 'https://groq.test/openai/v1',
      GROQ_STRUCTURED_STRICT: 'false',
      ...values,
    });

  const requestBody = async (
    values: Record<string, string>,
    modelRole: string,
  ) => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answer: 'ok' }) },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await new GroqStructuredLlmAdapter(config(values)).generateObject({
      model: 'openai/gpt-oss-20b',
      modelRole,
      systemPrompt: 'Return JSON.',
      userPrompt: 'Hello',
      jsonSchema: schema,
    });

    return JSON.parse(fetchMock.mock.calls[0][1]?.body as string) as {
      response_format: {
        json_schema: { strict: boolean };
      };
    };
  };

  afterEach(() => jest.restoreAllMocks());

  it('uses the Groq OpenAI-compatible structured-output contract', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answer: 'ok' }) },
            },
          ],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200 },
      ),
    );
    const diagnostics: unknown[] = [];
    const result = await new GroqStructuredLlmAdapter(config()).generateObject({
      model: 'openai/gpt-oss-20b',
      modelRole: 'ROUTER',
      systemPrompt: 'Return JSON.',
      userPrompt: 'Hello',
      jsonSchema: schema,
      schemaVersion: 'test-v1',
      maxTokens: 128,
      onDiagnostics: (value) => diagnostics.push(value),
    });

    expect(result).toEqual({ answer: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://groq.test/openai/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.model).toBe('openai/gpt-oss-20b');
    expect(request.max_completion_tokens).toBe(128);
    expect(request.response_format.json_schema.strict).toBe(false);
    expect(request.response_format.json_schema.schema).toEqual(schema);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({ providerStatus: 200, attempt: 1 }),
    );
    expect(diagnostics[0]).not.toHaveProperty('requestId');
  });

  it('uses the citation role strict override without changing the global default', async () => {
    const request = await requestBody(
      {
        GROQ_STRUCTURED_STRICT: 'false',
        GROQ_STRUCTURED_STRICT_CITATION_ATTRIBUTION: 'true',
      },
      'CITATION_ATTRIBUTION',
    );

    expect(request.response_format.json_schema.strict).toBe(true);
  });

  it('keeps unrelated roles on the global strict setting', async () => {
    const request = await requestBody(
      {
        GROQ_STRUCTURED_STRICT: 'false',
        GROQ_STRUCTURED_STRICT_CITATION_ATTRIBUTION: 'true',
      },
      'ROUTER',
    );

    expect(request.response_format.json_schema.strict).toBe(false);
  });

  it('falls back to the global setting when the citation override is absent', async () => {
    const request = await requestBody(
      { GROQ_STRUCTURED_STRICT: 'true' },
      'CITATION_ATTRIBUTION',
    );

    expect(request.response_format.json_schema.strict).toBe(true);
  });

  it('honors an explicit false citation override over a true global setting', async () => {
    const request = await requestBody(
      {
        GROQ_STRUCTURED_STRICT: 'true',
        GROQ_STRUCTURED_STRICT_CITATION_ATTRIBUTION: 'false',
      },
      'CITATION_ATTRIBUTION',
    );

    expect(request.response_format.json_schema.strict).toBe(false);
  });

  it('forwards the configured low reasoning effort to Qwen 3.8', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: { content: JSON.stringify({ answer: 'ok' }) },
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const qwenConfig = new ConfigService({
      GROQ_API_KEY: 'test-key',
      GROQ_BASE_URL: 'https://groq.test/openai/v1',
      GROQ_STRUCTURED_STRICT: 'false',
      GROQ_REASONING_EFFORT: 'low',
    });

    await new GroqStructuredLlmAdapter(qwenConfig).generateObject({
      model: 'qwen/qwen3.8-27b',
      modelRole: 'CONTEXT_SUFFICIENCY',
      systemPrompt: 'Return JSON.',
      userPrompt: 'Hello',
      jsonSchema: schema,
      maxTokens: 128,
    });

    const request = JSON.parse(fetchMock.mock.calls[0][1]?.body as string);
    expect(request.reasoning_effort).toBe('low');
  });

  it.each([
    [401, 'provider failure', 'AUTH_OR_CONFIGURATION_FAILURE', false],
    [403, 'provider failure', 'AUTH_OR_CONFIGURATION_FAILURE', false],
    [500, 'provider failure', 'TRANSIENT_PROVIDER_FAILURE', true],
    [502, 'provider failure', 'TRANSIENT_PROVIDER_FAILURE', true],
    [503, 'provider failure', 'TRANSIENT_PROVIDER_FAILURE', true],
  ])(
    'classifies status %s conservatively',
    async (status, message, category, transient) => {
      jest.spyOn(global, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ error: { message } }), {
          status,
        }),
      );
      await expect(
        new GroqStructuredLlmAdapter(config()).generateObject({
          model: 'openai/gpt-oss-20b',
          systemPrompt: 'Return JSON.',
          userPrompt: 'Hello',
          jsonSchema: schema,
        }),
      ).rejects.toMatchObject<Partial<GroqStructuredCompletionProviderError>>({
        code: 'STRUCTURED_COMPLETION_PROVIDER_ERROR',
        providerCategory: category,
        transient,
      });
    },
  );

  it.each([
    'rate limit reached',
    'tokens per minute limit exceeded',
    'requests per minute limit exceeded',
  ])('classifies %s as rate limited, not account limited', async (message) => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ error: { message } }), { status: 429 }),
      );

    await expect(
      new GroqStructuredLlmAdapter(config()).generateObject({
        model: 'openai/gpt-oss-20b',
        systemPrompt: 'Return JSON.',
        userPrompt: 'Hello',
        jsonSchema: schema,
      }),
    ).rejects.toMatchObject<Partial<GroqStructuredCompletionProviderError>>({
      providerCategory: 'RATE_LIMITED',
      transient: false,
    });
  });

  it('classifies explicit billing/account quota exhaustion as account limited', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { message: 'billing/account quota exhausted' },
        }),
        { status: 429 },
      ),
    );

    await expect(
      new GroqStructuredLlmAdapter(config()).generateObject({
        model: 'openai/gpt-oss-20b',
        systemPrompt: 'Return JSON.',
        userPrompt: 'Hello',
        jsonSchema: schema,
      }),
    ).rejects.toMatchObject<Partial<GroqStructuredCompletionProviderError>>({
      providerCategory: 'ACCOUNT_LIMITED',
      transient: false,
    });
  });

  it('preserves string provider codes and sanitized retry/rate-limit metadata', async () => {
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: 'rate_limit_exceeded', message: 'rate limit reached' },
        }),
        {
          status: 429,
          headers: {
            'retry-after': '2',
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-limit-tokens': '10000',
            'x-ratelimit-remaining-requests': '0',
            'x-ratelimit-remaining-tokens': '0',
            'x-ratelimit-reset-requests': '2s',
            'x-ratelimit-reset-tokens': '2s',
          },
        },
      ),
    );
    const diagnostics: unknown[] = [];

    await expect(
      new GroqStructuredLlmAdapter(config()).generateObject({
        model: 'openai/gpt-oss-20b',
        systemPrompt: 'Return JSON.',
        userPrompt: 'Hello',
        jsonSchema: schema,
        onDiagnostics: (value) => diagnostics.push(value),
      }),
    ).rejects.toMatchObject<Partial<GroqStructuredCompletionProviderError>>({
      providerCode: 'rate_limit_exceeded',
      providerCategory: 'RATE_LIMITED',
      retryAfterMs: 2_000,
      transient: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(diagnostics[0]).toEqual(
      expect.objectContaining({
        providerCode: 'rate_limit_exceeded',
        providerCategory: 'RATE_LIMITED',
        retryAfterMs: 2_000,
        transient: true,
        rateLimit: {
          retryAfter: '2',
          limitRequests: '100',
          limitTokens: '10000',
          remainingRequests: '0',
          remainingTokens: '0',
          resetRequests: '2s',
          resetTokens: '2s',
        },
      }),
    );
  });
});
