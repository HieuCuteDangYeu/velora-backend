import { ConfigService } from '@nestjs/config';
import { OllamaLlmAdapter } from './ollama-llm.adapter';
import { OllamaTextClient } from './ollama-text.client';

describe('OllamaLlmAdapter', () => {
  const client = { generateChatText: jest.fn() } as unknown as OllamaTextClient;
  const adapter = new OllamaLlmAdapter(
    new ConfigService({ AI_ANSWER_MODEL: 'gemma4' }),
    client,
  );
  beforeEach(() => jest.clearAllMocks());

  it('returns the fallback when the provider fails before streaming', async () => {
    jest
      .mocked(client.generateChatText)
      .mockRejectedValue(new Error('provider unavailable'));
    const onToken = jest.fn();
    const result = await adapter.generateResponseStream(
      'hello',
      'rules',
      'u1',
      onToken,
    );
    expect(result).toContain('could not generate');
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith(result);
  });

  it('propagates a provider failure after partial streaming without appending fallback', async () => {
    jest.mocked(client.generateChatText).mockImplementation(({ onToken }) => {
      onToken?.('partial');
      return Promise.reject(new Error('stream interrupted'));
    });
    const onToken = jest.fn();
    await expect(
      adapter.generateResponseStream('hello', 'rules', 'u1', onToken),
    ).rejects.toThrow('stream interrupted');
    expect(onToken).toHaveBeenCalledTimes(1);
    expect(onToken).toHaveBeenCalledWith('partial');
  });
});
