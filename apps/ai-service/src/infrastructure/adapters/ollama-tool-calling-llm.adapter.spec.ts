import { ConfigService } from '@nestjs/config';
import { OllamaHttpError, OllamaTextClient } from './ollama-text.client';
import { OllamaToolCallingLlmAdapter } from './ollama-tool-calling-llm.adapter';

describe('OllamaToolCallingLlmAdapter', () => {
  const client = { chat: jest.fn() } as unknown as OllamaTextClient;
  const adapter = new OllamaToolCallingLlmAdapter(
    client,
    new ConfigService({}),
  );
  const tool = {
    name: 'search_reels',
    description: 'Search reels',
    parameters: {
      type: 'object' as const,
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  };
  const input = {
    model: 'gemma4',
    messages: [{ role: 'user' as const, content: 'find' }],
    tools: [tool],
    toolChoice: 'required' as const,
  };
  beforeEach(() => jest.clearAllMocks());

  it('uses native tools and maps tool IDs and argument objects', async () => {
    jest.mocked(client.chat).mockResolvedValue({
      message: {
        tool_calls: [
          { function: { name: 'search_reels', arguments: { query: 'hi' } } },
        ],
      },
      done_reason: 'stop',
    });
    await expect(adapter.complete(input)).resolves.toMatchObject({
      toolCalls: [
        { id: 'tool-call-0', name: 'search_reels', arguments: { query: 'hi' } },
      ],
    });
    expect(client.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [{ type: 'function', function: tool }],
      }),
    );
  });

  it('converts assistant and tool response history to native messages', async () => {
    jest
      .mocked(client.chat)
      .mockResolvedValue({ message: { content: 'answer' }, done: true });
    await adapter.complete({
      ...input,
      toolChoice: 'auto',
      messages: [
        {
          role: 'assistant',
          toolCalls: [
            { id: 'one', name: 'search_reels', arguments: { query: 'hi' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'one',
          name: 'search_reels',
          content: 'Found',
        },
      ],
    });
    expect(client.chat).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                function: { name: 'search_reels', arguments: { query: 'hi' } },
              },
            ],
          },
          { role: 'tool', tool_name: 'search_reels', content: 'Found' },
        ],
      }),
    );
  });

  it('fails when required tools are missing or the model skips a required call', async () => {
    await expect(
      adapter.complete({ ...input, tools: [] }),
    ).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_INVALID_REQUEST',
    });
    jest
      .mocked(client.chat)
      .mockResolvedValue({ message: { content: 'answer' }, done: true });
    await expect(adapter.complete(input)).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_TOOL_REQUIRED',
    });
  });

  it('rejects unknown tools and malformed arguments', async () => {
    jest
      .mocked(client.chat)
      .mockResolvedValueOnce({
        message: {
          tool_calls: [{ function: { name: 'delete_reels', arguments: {} } }],
        },
      })
      .mockResolvedValueOnce({
        message: {
          tool_calls: [{ function: { name: 'search_reels', arguments: '{' } }],
        },
      });
    await expect(adapter.complete(input)).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_INVALID_RESPONSE',
    });
    await expect(adapter.complete(input)).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_INVALID_RESPONSE',
    });
  });

  it('preserves provider HTTP status', async () => {
    jest
      .mocked(client.chat)
      .mockRejectedValue(new OllamaHttpError(503, 'offline'));
    await expect(adapter.complete(input)).rejects.toMatchObject({
      code: 'TOOL_PROVIDER_HTTP_ERROR',
      httpStatus: 503,
    });
  });
});
