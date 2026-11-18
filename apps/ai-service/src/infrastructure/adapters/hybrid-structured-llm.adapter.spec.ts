import { ConfigService } from '@nestjs/config';
import { GroqKeyPoolExhaustedError } from '../services/groq-key-pool.service';
import { GroqStructuredLlmAdapter } from './groq-structured-llm.adapter';
import { HybridStructuredLlmAdapter } from './hybrid-structured-llm.adapter';
import { MuseStructuredLlmAdapter } from './muse-structured-llm.adapter';
import {
  OllamaStructuredCompletionProviderError,
  OllamaStructuredLlmAdapter,
} from './ollama-structured-llm.adapter';

const schema = { type: 'object' as const, properties: {} };
const request = (modelRole: string, model = 'm') => ({
  model,
  modelRole,
  systemPrompt: 's',
  userPrompt: 'u',
  jsonSchema: schema,
});

function setup(values: Record<string, string>) {
  const groq = { generateObject: jest.fn().mockResolvedValue('groq') };
  const ollama = { generateObject: jest.fn().mockResolvedValue('ollama') };
  const muse = { generateObject: jest.fn().mockResolvedValue('muse') };
  const adapter = new HybridStructuredLlmAdapter(
    groq as unknown as GroqStructuredLlmAdapter,
    ollama as unknown as OllamaStructuredLlmAdapter,
    { get: (key: string) => values[key] } as unknown as ConfigService,
    muse as unknown as MuseStructuredLlmAdapter,
  );
  return { adapter, groq, ollama, muse };
}

describe('HybridStructuredLlmAdapter', () => {
  const enabled = { AI_GROQ_HYBRID_ENABLED: 'true' };

  it.each(['ROUTER', 'RETRIEVAL_PLANNER', 'PLANNER', 'ANSWER', 'DRAFT_ANSWER'])(
    'sends %s to Groq when hybrid is enabled',
    async (role) => {
      const { adapter, groq, ollama } = setup(enabled);
      await expect(adapter.generateObject(request(role))).resolves.toBe('groq');
      expect(ollama.generateObject).not.toHaveBeenCalled();
      expect(groq.generateObject).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'VERIFIER',
    'CITATION_ATTRIBUTION',
    'CONTEXT_SUFFICIENCY',
    'ANSWER_REVISION',
    'METADATA_EXTRACTION',
    undefined,
  ])('keeps %s on local Ollama', async (role) => {
    const { adapter, groq, ollama } = setup(enabled);
    await expect(adapter.generateObject(request(role as string))).resolves.toBe(
      'ollama',
    );
    expect(groq.generateObject).not.toHaveBeenCalled();
    expect(ollama.generateObject).toHaveBeenCalledTimes(1);
  });

  it('stays entirely on Ollama unless hybrid is explicitly enabled', async () => {
    const { adapter, groq } = setup({});
    await expect(adapter.generateObject(request('ROUTER'))).resolves.toBe(
      'ollama',
    );
    expect(groq.generateObject).not.toHaveBeenCalled();
  });

  it('falls back to the local model when every Groq key is exhausted', async () => {
    const { adapter, groq, ollama } = setup({
      ...enabled,
      AI_OLLAMA_FALLBACK_MODEL: 'gemma4:e2b-it-qat',
    });
    groq.generateObject.mockRejectedValue(
      new GroqKeyPoolExhaustedError(3, 3, 0),
    );
    await expect(
      adapter.generateObject(request('ANSWER', 'llama-3.3-70b-versatile')),
    ).resolves.toBe('ollama');
    expect(ollama.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemma4:e2b-it-qat',
        modelRole: 'ANSWER',
      }),
    );
  });

  it('falls back on provider rate limits, defaulting to the verifier model', async () => {
    const { adapter, groq, ollama } = setup({
      ...enabled,
      AI_VERIFIER_MODEL: 'gemma4:12b',
    });
    groq.generateObject.mockRejectedValue(
      new OllamaStructuredCompletionProviderError(
        'm',
        429,
        undefined,
        1000,
        false,
        'RATE_LIMITED',
      ),
    );
    await adapter.generateObject(request('ROUTER'));
    expect(ollama.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gemma4:12b' }),
    );
  });

  it('does not mask non-capacity failures or fall back without a local model', async () => {
    const { adapter, groq, ollama } = setup(enabled);
    const schemaError = new Error('schema');
    groq.generateObject.mockRejectedValueOnce(schemaError);
    await expect(adapter.generateObject(request('ROUTER'))).rejects.toBe(
      schemaError,
    );
    const exhausted = new GroqKeyPoolExhaustedError(1, 1, 0);
    groq.generateObject.mockRejectedValueOnce(exhausted);
    await expect(adapter.generateObject(request('ROUTER'))).rejects.toBe(
      exhausted,
    );
    expect(ollama.generateObject).not.toHaveBeenCalled();
  });

  describe('Muse indexing roles', () => {
    const museOn = { AI_MUSE_ENABLED: 'true' };

    it.each(['METADATA_EXTRACTION', 'INDEX_QUALITY', 'SUBTITLE_TRANSLATION'])(
      'sends %s to Muse when enabled',
      async (role) => {
        const { adapter, muse, ollama } = setup(museOn);
        await expect(adapter.generateObject(request(role))).resolves.toBe(
          'muse',
        );
        expect(muse.generateObject).toHaveBeenCalledTimes(1);
        expect(ollama.generateObject).not.toHaveBeenCalled();
      },
    );

    it('never sends live RAG roles to Muse', async () => {
      const { adapter, muse } = setup({ ...museOn, ...enabled });
      await adapter.generateObject(request('ROUTER'));
      await adapter.generateObject(request('VERIFIER'));
      expect(muse.generateObject).not.toHaveBeenCalled();
    });

    it('honours AI_MUSE_ROLES', async () => {
      const { adapter, muse, ollama } = setup({
        ...museOn,
        AI_MUSE_ROLES: 'INDEX_QUALITY',
      });
      await adapter.generateObject(request('METADATA_EXTRACTION'));
      expect(muse.generateObject).not.toHaveBeenCalled();
      expect(ollama.generateObject).toHaveBeenCalledTimes(1);
    });

    it('stays off unless AI_MUSE_ENABLED is true', async () => {
      const { adapter, muse } = setup({});
      await adapter.generateObject(request('METADATA_EXTRACTION'));
      expect(muse.generateObject).not.toHaveBeenCalled();
    });

    it('falls back to Ollama with the original request when Muse fails', async () => {
      const { adapter, muse, ollama } = setup(museOn);
      muse.generateObject.mockRejectedValue(new Error('session expired'));
      const input = request('INDEX_QUALITY', 'gemma4:e2b');
      await expect(adapter.generateObject(input)).resolves.toBe('ollama');
      expect(ollama.generateObject).toHaveBeenCalledWith(input);
    });
  });
});
