import { ConfigService } from '@nestjs/config';
import { GroqKeyPoolExhaustedError } from '../services/groq-key-pool.service';
import { CloudflareStructuredLlmAdapter } from './cloudflare-structured-llm.adapter';
import { GroqStructuredLlmAdapter } from './groq-structured-llm.adapter';
import { HybridStructuredLlmAdapter } from './hybrid-structured-llm.adapter';
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
  const cloudflare = {
    generateObject: jest.fn().mockResolvedValue('cloudflare'),
  };
  const adapter = new HybridStructuredLlmAdapter(
    groq as unknown as GroqStructuredLlmAdapter,
    ollama as unknown as OllamaStructuredLlmAdapter,
    { get: (key: string) => values[key] } as unknown as ConfigService,
    cloudflare as unknown as CloudflareStructuredLlmAdapter,
  );
  return { adapter, groq, ollama, cloudflare };
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

  describe('Cloudflare answer roles', () => {
    const on = {
      AI_CLOUDFLARE_LLM_ENABLED: 'true',
      AI_CLOUDFLARE_LLM_ROLES: 'ANSWER, CONTEXT_SUFFICIENCY',
    };

    it.each(['ANSWER', 'CONTEXT_SUFFICIENCY'])(
      'sends %s to Cloudflare when enabled and listed',
      async (role) => {
        const { adapter, cloudflare, ollama } = setup(on);
        await expect(adapter.generateObject(request(role))).resolves.toBe(
          'cloudflare',
        );
        expect(cloudflare.generateObject).toHaveBeenCalledTimes(1);
        expect(ollama.generateObject).not.toHaveBeenCalled();
      },
    );

    it('leaves unlisted roles, and everything when disabled or unset, on the usual path', async () => {
      const a = setup(on);
      await expect(a.adapter.generateObject(request('VERIFIER'))).resolves.toBe(
        'ollama',
      );
      const b = setup({ ...on, AI_CLOUDFLARE_LLM_ENABLED: 'false' });
      await expect(b.adapter.generateObject(request('ANSWER'))).resolves.toBe(
        'ollama',
      );
      const c = setup({});
      await expect(c.adapter.generateObject(request('ANSWER'))).resolves.toBe(
        'ollama',
      );
      expect(a.cloudflare.generateObject).not.toHaveBeenCalled();
      expect(b.cloudflare.generateObject).not.toHaveBeenCalled();
      expect(c.cloudflare.generateObject).not.toHaveBeenCalled();
    });

    it('falls back to Ollama with the original request when Cloudflare fails', async () => {
      const { adapter, cloudflare, ollama } = setup(on);
      cloudflare.generateObject.mockRejectedValue(new Error('quota spent'));
      const req = request('ANSWER');
      await expect(adapter.generateObject(req)).resolves.toBe('ollama');
      expect(ollama.generateObject).toHaveBeenCalledWith(req);
    });
  });
});
