import { ConfigService } from '@nestjs/config';
import { OllamaStructuredLlmAdapter } from './ollama-structured-llm.adapter';
import { OllamaHttpError, OllamaTextClient } from './ollama-text.client';

describe('OllamaStructuredLlmAdapter', () => {
  const config = new ConfigService({ OLLAMA_STRUCTURED_TIMEOUT_MS: '60000' });
  const client = { chat: jest.fn() } as unknown as OllamaTextClient;
  const adapter = new OllamaStructuredLlmAdapter(client, config);
  const schema = {
    type: 'object' as const,
    required: ['choice'],
    additionalProperties: false,
    properties: { choice: { type: 'string', enum: ['one', 'two'] } },
  };
  const input = {
    model: 'gemma4',
    modelRole: 'ROUTER',
    systemPrompt: 'JSON',
    userPrompt: 'Pick',
    jsonSchema: schema,
    schemaVersion: 'v1',
  };
  beforeEach(() => jest.clearAllMocks());

  it('forwards dynamic schemas and returns validated results with token diagnostics', async () => {
    const onDiagnostics = jest.fn();
    jest.mocked(client.chat).mockResolvedValue({
      message: { content: '{"choice":"two"}' },
      done_reason: 'stop',
      prompt_eval_count: 10,
      eval_count: 4,
    });
    await expect(
      adapter.generateObject({ ...input, onDiagnostics }),
    ).resolves.toEqual({ choice: 'two' });
    expect(client.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemma4',
        format: schema,
        messages: [
          { role: 'system', content: 'JSON' },
          { role: 'user', content: 'Pick' },
        ],
      }),
    );
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({
        providerStatus: 200,
        endpointContract: 'OLLAMA_CHAT_JSON_SCHEMA',
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        attempt: 1,
      }),
    );
  });

  it('rejects an unsupported enum and preserves the schema error path', async () => {
    const onDiagnostics = jest.fn();
    jest.mocked(client.chat).mockResolvedValue({
      message: { content: '{"choice":"three"}' },
      done_reason: 'stop',
    });
    await expect(
      adapter.generateObject({ ...input, onDiagnostics }),
    ).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
      path: '$.choice',
      constraint: 'enum',
    });
    expect(onDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ schemaPath: '$.choice', schemaVersion: 'v1' }),
    );
  });

  it.each([
    ['array limits', '{"values":["one","two"]}', 'maxItems', '$.values'],
    [
      'nested string limits',
      '{"values":["too-long"]}',
      'maxLength',
      '$.values[0]',
    ],
    ['number limits', '{"confidence":1.5}', 'maximum', '$.confidence'],
  ])(
    'rejects %s that violate the provided schema',
    async (_name, content, constraint, path) => {
      jest
        .mocked(client.chat)
        .mockResolvedValue({ message: { content }, done_reason: 'stop' });
      const boundedSchema = {
        type: 'object' as const,
        properties: {
          values: {
            type: 'array' as const,
            maxItems: 1,
            items: { type: 'string' as const, maxLength: 3 },
          },
          confidence: { type: 'number' as const, minimum: 0, maximum: 1 },
        },
      };
      await expect(
        adapter.generateObject({ ...input, jsonSchema: boundedSchema }),
      ).rejects.toMatchObject({
        code: 'STRUCTURED_COMPLETION_SCHEMA_INVALID',
        constraint,
        path,
      });
    },
  );

  it('rejects truncated completions before parsing', async () => {
    jest.mocked(client.chat).mockResolvedValue({
      message: { content: '{"choice":"one"}' },
      done_reason: 'length',
    });
    await expect(adapter.generateObject(input)).rejects.toMatchObject({
      code: 'STRUCTURED_COMPLETION_TRUNCATED',
    });
  });

  it('retries a server failure and preserves error category diagnostics', async () => {
    const onDiagnostics = jest.fn();
    jest
      .mocked(client.chat)
      .mockRejectedValueOnce(new OllamaHttpError(503, 'unavailable'))
      .mockResolvedValueOnce({
        message: { content: '{"choice":"one"}' },
        done: true,
      });
    await expect(
      adapter.generateObject({
        ...input,
        modelRole: 'VERIFIER',
        onDiagnostics,
      }),
    ).resolves.toEqual({ choice: 'one' });
    expect(client.chat).toHaveBeenCalledTimes(2);
    expect(onDiagnostics).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        providerStatus: 503,
        providerCategory: 'TRANSIENT_PROVIDER_FAILURE',
        transient: true,
      }),
    );
  });
});
