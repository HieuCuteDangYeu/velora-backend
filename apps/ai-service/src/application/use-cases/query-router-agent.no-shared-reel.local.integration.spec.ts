import { OllamaStructuredLlmAdapter } from '@ai/infrastructure/adapters/ollama-structured-llm.adapter';
import { OllamaTextClient } from '@ai/infrastructure/adapters/ollama-text.client';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

/**
 * Opt-in: runs the real router on the real local model.
 *
 *   OLLAMA_LOCAL_INTEGRATION=1 [OLLAMA_LOCAL_MODEL=gemma4:e2b-it-qat] \
 *     npx jest query-router-agent.no-shared-reel.local.integration
 *
 * A user can ask about "the last video I watched" in a conversation where no reel is shared.
 * The router used to reject its own (correct) REEL_VIDEO_QUESTION route in that case and the
 * user saw "temporarily unavailable": 4 of 10 phrasings on the production model. Every phrasing
 * must now yield a route, with and without a shared reel.
 */
const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';
const config = new ConfigService({
  OLLAMA_TEXT_BASE_URL:
    process.env.OLLAMA_TEXT_BASE_URL || 'http://127.0.0.1:11434',
  OLLAMA_STRUCTURED_TIMEOUT_MS: '120000',
  AI_ROUTER_MODEL: model,
});
const appConfig = {
  get: () => undefined,
  model: () => model,
  timeoutMs: () => 120_000,
  maxCompletionTokens: () => 512,
  boolean: (_key: string, fallback: boolean) => fallback,
  number: (_key: string, fallback: number) => fallback,
} as never;

describe('router with no shared reel (opt-in, real model)', () => {
  jest.setTimeout(30 * 60_000);

  localIt('returns a route for every phrasing in both contexts', async () => {
    const rows = readFileSync(
      join(
        process.cwd(),
        'eval/rag/datasets/rag-router-no-shared-reel-v1.jsonl',
      ),
      'utf8',
    )
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { id: string; prompt: string });
    expect(rows.length).toBeGreaterThanOrEqual(20);

    const router = new QueryRouterAgentUseCase(
      new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
      appConfig,
    );

    const failures: string[] = [];
    for (const shared of [false, true]) {
      for (const { id, prompt } of rows) {
        try {
          await router.execute({
            message: prompt,
            recentHistory: '',
            hasSharedReelContext: shared,
            sharedReelCount: shared ? 1 : 0,
            referentContext: {
              conversationHasSharedReelContext: shared,
              accessibleSharedReelCount: shared ? 1 : 0,
              recentShareEvent: false,
              recentEventTypes: [],
            },
          });
        } catch (error: unknown) {
          const detail = error as {
            name?: string;
            semanticInconsistencyType?: string;
          };
          failures.push(
            `${id} (shared=${shared}): ${detail.name} ${detail.semanticInconsistencyType ?? ''}`.trim(),
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
