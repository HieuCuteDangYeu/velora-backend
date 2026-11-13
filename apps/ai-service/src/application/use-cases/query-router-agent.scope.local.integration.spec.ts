import { OllamaStructuredLlmAdapter } from '@ai/infrastructure/adapters/ollama-structured-llm.adapter';
import { OllamaTextClient } from '@ai/infrastructure/adapters/ollama-text.client';
import { ConfigService } from '@nestjs/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QueryRouterAgentUseCase } from './query-router-agent.use-case';

/**
 * Opt-in: runs the real router on the real local model and measures the scope policy.
 *
 *   OLLAMA_LOCAL_INTEGRATION=1 [OLLAMA_LOCAL_MODEL=gemma4:e2b-it-qat] \
 *     npx jest query-router-agent.scope.local.integration
 *
 * Two numbers matter:
 *  - false refusals: an in-scope message routed OFF_TOPIC (the user is turned away wrongly). The
 *    labelled in-scope rows and every router fixture of the generalisation benchmark count.
 *  - catch rate: an off-topic message routed OFF_TOPIC.
 * A router failure is reported separately; it falls back to ordinary chat in production.
 */
const localIt = process.env.OLLAMA_LOCAL_INTEGRATION === '1' ? it : it.skip;
const model = process.env.OLLAMA_LOCAL_MODEL || 'gemma4:e2b-it-qat';
const maxFalseRefusalRate = Number(process.env.SCOPE_MAX_FALSE_REFUSAL ?? 0.03);
const minCatchRate = Number(process.env.SCOPE_MIN_CATCH ?? 0.85);

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

/**
 * Router benchmark rows labelled NORMAL_CHAT under the old open-chat policy (coding, general
 * explanations, writing and translation help). The strict scope policy turns them away, so this
 * run counts them as off-topic. The shared dataset keeps its labels: other specs depend on them.
 */
const OFF_TOPIC_UNDER_STRICT_SCOPE = new Set([
  'normal-01',
  'normal-02',
  'normal-03',
  'normal-04',
  'normal-05',
  'normal-06',
  'normal-07',
  'normal-08',
  'normal-09',
  'normal-10',
  'multi-04',
]);

interface ScopeRow {
  id: string;
  prompt: string;
  expectedScope: 'OFF_TOPIC' | 'IN_SCOPE';
  sharedReel: boolean;
}
interface Fixture {
  id: string;
  message: string;
  hasSharedReelContext: boolean;
  sharedReelCount: number;
  recentHistory: string;
  referentContext: never;
}

const readJsonl = <T>(path: string): T[] =>
  readFileSync(join(process.cwd(), path), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);

describe('router scope policy (opt-in, real model)', () => {
  jest.setTimeout(90 * 60_000);

  localIt(
    'turns unrelated messages away without refusing in-scope ones',
    async () => {
      const router = new QueryRouterAgentUseCase(
        new OllamaStructuredLlmAdapter(new OllamaTextClient(config), config),
        appConfig,
      );
      const scopeRows = readJsonl<ScopeRow>(
        'eval/rag/datasets/rag-router-scope-v1.jsonl',
      );
      const fixtures = readJsonl<{ id: string; fixture?: Fixture }>(
        'eval/rag/datasets/rag-generalization-v1.jsonl',
      ).flatMap((row) => (row.fixture ? [row.fixture] : []));
      expect(scopeRows.length).toBeGreaterThanOrEqual(80);
      expect(fixtures.length).toBeGreaterThanOrEqual(90);

      const routeOf = async (input: Parameters<typeof router.execute>[0]) => {
        try {
          return (await router.execute(input)).intent;
        } catch {
          return 'ROUTER_FAILURE';
        }
      };

      const stats = {
        off: 0,
        caught: 0,
        inScope: 0,
        falseRefusals: 0,
        failures: 0,
        benchmarkOff: 0,
        benchmarkCaught: 0,
      };
      const wrong: string[] = [];

      for (const row of scopeRows) {
        const intent = await routeOf({
          message: row.prompt,
          recentHistory: '',
          hasSharedReelContext: row.sharedReel,
          sharedReelCount: row.sharedReel ? 1 : 0,
          referentContext: {
            conversationHasSharedReelContext: row.sharedReel,
            accessibleSharedReelCount: row.sharedReel ? 1 : 0,
            recentShareEvent: row.sharedReel,
            recentEventTypes: row.sharedReel ? ['REEL_SHARE'] : [],
          },
        });
        if (intent === 'ROUTER_FAILURE') stats.failures += 1;
        if (row.expectedScope === 'OFF_TOPIC') {
          stats.off += 1;
          if (intent === 'OFF_TOPIC') stats.caught += 1;
          else wrong.push(`MISSED ${row.id} -> ${intent}: ${row.prompt}`);
        } else {
          stats.inScope += 1;
          if (intent === 'OFF_TOPIC') {
            stats.falseRefusals += 1;
            wrong.push(`REFUSED ${row.id}: ${row.prompt}`);
          }
        }
      }

      for (const fixture of fixtures) {
        const intent = await routeOf({
          message: fixture.message,
          recentHistory: fixture.recentHistory,
          hasSharedReelContext: fixture.hasSharedReelContext,
          sharedReelCount: fixture.sharedReelCount,
          referentContext: fixture.referentContext,
        });
        if (intent === 'ROUTER_FAILURE') stats.failures += 1;
        if (OFF_TOPIC_UNDER_STRICT_SCOPE.has(fixture.id)) {
          stats.off += 1;
          stats.benchmarkOff += 1;
          if (intent === 'OFF_TOPIC') {
            stats.caught += 1;
            stats.benchmarkCaught += 1;
          } else {
            wrong.push(
              `MISSED fixture ${fixture.id} -> ${intent}: ${fixture.message}`,
            );
          }
          continue;
        }
        stats.inScope += 1;
        if (intent === 'OFF_TOPIC') {
          stats.falseRefusals += 1;
          wrong.push(`REFUSED fixture ${fixture.id}: ${fixture.message}`);
        }
      }

      console.log(
        JSON.stringify({
          model,
          ...stats,
          catchRate: stats.caught / stats.off,
          benchmarkCatchRate: stats.benchmarkCaught / stats.benchmarkOff,
          falseRefusalRate: stats.falseRefusals / stats.inScope,
        }),
      );
      console.log(wrong.join('\n'));

      expect(stats.falseRefusals / stats.inScope).toBeLessThanOrEqual(
        maxFalseRefusalRate,
      );
      expect(stats.caught / stats.off).toBeGreaterThanOrEqual(minCatchRate);
    },
  );
});
