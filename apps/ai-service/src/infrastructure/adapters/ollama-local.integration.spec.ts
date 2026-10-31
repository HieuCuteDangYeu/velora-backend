import { ConfigService } from '@nestjs/config';
import { OllamaTextClient } from './ollama-text.client';
import { OllamaStructuredLlmAdapter } from './ollama-structured-llm.adapter';
import { OllamaToolCallingLlmAdapter } from './ollama-tool-calling-llm.adapter';
import { OllamaLlmAdapter } from './ollama-llm.adapter';

const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';
const config = new ConfigService({
  OLLAMA_TEXT_BASE_URL:
    process.env.OLLAMA_TEXT_BASE_URL || 'http://127.0.0.1:11434',
  AI_ANSWER_MODEL: model,
  AI_ANSWER_TIMEOUT_MS: '90000',
});
const client = new OllamaTextClient(config);

describe('local Gemma/Ollama adapter smoke checks (opt-in)', () => {
  jest.setTimeout(120_000);

  localIt(
    'generates schema-valid JSON through the structured adapter',
    async () => {
      const result = await new OllamaStructuredLlmAdapter(
        client,
        config,
      ).generateObject<{ choice: string }>({
        model,
        modelRole: 'ROUTER',
        systemPrompt: 'Return only valid JSON matching the schema.',
        userPrompt: 'Choose the value one.',
        jsonSchema: {
          type: 'object',
          properties: { choice: { type: 'string', enum: ['one', 'two'] } },
          required: ['choice'],
          additionalProperties: false,
        },
        timeoutMs: 90_000,
      });
      expect(result.choice).toBe('one');
    },
  );

  localIt(
    'handles a native tool call followed by its tool result',
    async () => {
      const adapter = new OllamaToolCallingLlmAdapter(client, config);
      const tool = {
        name: 'get_reel_title',
        description: 'Return the title of a reel by ID',
        parameters: {
          type: 'object' as const,
          properties: { reel_id: { type: 'string' } },
          required: ['reel_id'],
        },
      };
      const first = await adapter.complete({
        model,
        toolChoice: 'required',
        tools: [tool],
        timeoutMs: 90_000,
        messages: [
          { role: 'user', content: 'Call get_reel_title with reel_id 42.' },
        ],
      });
      expect(first.toolCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'get_reel_title' }),
        ]),
      );
      const answer = await adapter.complete({
        model,
        toolChoice: 'none',
        tools: [tool],
        timeoutMs: 90_000,
        messages: [
          { role: 'user', content: 'What is the title of reel 42?' },
          { role: 'assistant', toolCalls: first.toolCalls },
          {
            role: 'tool',
            toolCallId: first.toolCalls[0].id,
            name: 'get_reel_title',
            content: 'Rainy morning',
          },
        ],
      });
      expect(answer.content?.toLowerCase()).toContain('rainy morning');
    },
  );

  localIt(
    'streams an answer through the production response adapter',
    async () => {
      const tokens: string[] = [];
      const answer = await new OllamaLlmAdapter(
        config,
        client,
      ).generateResponseStream(
        'Say exactly: Hello Velora',
        'Reply briefly in English.',
        'smoke-user',
        (token) => tokens.push(token),
      );
      expect(tokens.join('').trim()).toBeTruthy();
      expect(answer.trim()).toBeTruthy();
    },
  );
});
