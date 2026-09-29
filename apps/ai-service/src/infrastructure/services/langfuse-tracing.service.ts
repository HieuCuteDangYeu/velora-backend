import {
  propagateAttributes,
  startActiveObservation,
  startObservation,
  type LangfuseSpan,
} from '@langfuse/tracing';
import { Injectable } from '@nestjs/common';
import { langfuseEnabled, redactLangfuseValue } from './langfuse-telemetry';

export interface RagTraceRootMetadata {
  productionExecutionId: string;
  userId: string;
  conversationId: string;
  release?: string;
  environment?: string;
}

type SafeSummary = Record<string, unknown>;

const SAFE_KEYS = new Set([
  'model',
  'modelRole',
  'providerStatus',
  'providerCategory',
  'providerCode',
  'decisionSource',
  'errorCode',
  'latencyMs',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'reasoningTokens',
  'retrievedCount',
  'rerankedCount',
  'queryCount',
  'semanticCandidateCount',
  'hydratedCandidateCount',
  'returnedChunkCount',
  'coverage',
  'factualClaimCount',
  'supportedClaimCount',
  'passed',
  'confidence',
  'requiresRevision',
  'answerGenerationMode',
  'answerFallbackReason',
  'finalFailureSource',
]);

@Injectable()
export class LangfuseTracingService {
  private readonly enabled = langfuseEnabled();

  async withRoot<T>(
    metadata: RagTraceRootMetadata,
    operation: (root?: LangfuseSpan) => Promise<T>,
  ): Promise<T> {
    if (!this.enabled) return operation();

    return startActiveObservation('rag.workflow', async (root) =>
      propagateAttributes(
        {
          traceName: 'velora-rag',
          sessionId: metadata.productionExecutionId,
          version: metadata.release,
          tags: ['velora', 'rag'],
          metadata: {
            productionExecutionId: metadata.productionExecutionId,
            environment: metadata.environment || 'unknown',
            release: metadata.release || 'unknown',
            service: 'ai-service',
          },
        },
        async () => {
          root.update({
            input: {
              conversationId: metadata.conversationId,
              userId: metadata.userId,
              productionExecutionId: metadata.productionExecutionId,
            },
          });
          return operation(root);
        },
      ),
    );
  }

  setRootOutput(root: LangfuseSpan | undefined, output: SafeSummary): void {
    root?.update({ output: redactLangfuseValue(output) });
  }

  async observe<T>(
    name: string,
    operation: () => Promise<T>,
    input: SafeSummary = {},
  ): Promise<T> {
    if (!this.enabled) return operation();

    const startedAt = Date.now();
    return startActiveObservation(`rag.${name}`, async (observation) => {
      observation.update({ input: redactLangfuseValue(input) });
      try {
        const result = await operation();
        observation.update({
          output: this.summary(result, Date.now() - startedAt),
        });
        return result;
      } catch (error: unknown) {
        observation.update({
          level: 'ERROR',
          statusMessage: this.errorCode(error),
          output: { status: 'FAILED', latencyMs: Date.now() - startedAt },
        });
        throw error;
      }
    });
  }

  observeSync<T>(name: string, operation: () => T, input: SafeSummary = {}): T {
    if (!this.enabled) return operation();

    const observation = startObservation(`rag.${name}`, {
      input: redactLangfuseValue(input),
    });
    const startedAt = Date.now();
    try {
      const result = operation();
      observation.update({
        output: this.summary(result, Date.now() - startedAt),
      });
      observation.end();
      return result;
    } catch (error: unknown) {
      observation.update({
        level: 'ERROR',
        statusMessage: this.errorCode(error),
        output: { status: 'FAILED', latencyMs: Date.now() - startedAt },
      });
      observation.end();
      throw error;
    }
  }

  summary(value: unknown, latencyMs?: number): SafeSummary {
    const summary: SafeSummary = {};
    this.collect(value, summary, 0);
    if (latencyMs !== undefined) summary.latencyMs = latencyMs;
    return redactLangfuseValue(summary) as SafeSummary;
  }

  private collect(value: unknown, summary: SafeSummary, depth: number): void {
    if (depth > 4 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value
        .slice(0, 8)
        .forEach((item) => this.collect(item, summary, depth + 1));
      return;
    }

    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (SAFE_KEYS.has(key) && this.isSafeScalar(child)) {
        summary[key] ??= child;
      }
      if (child && typeof child === 'object') {
        this.collect(child, summary, depth + 1);
      }
    }
  }

  private isSafeScalar(
    value: unknown,
  ): value is string | number | boolean | null {
    return (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= 120)
    );
  }

  private errorCode(error: unknown): string {
    if (!error || typeof error !== 'object') return 'UNKNOWN_ERROR';
    const record = error as Record<string, unknown>;
    const code = record.code;
    return typeof code === 'string' && code.length <= 120
      ? code
      : error instanceof Error
        ? error.name
        : 'UNKNOWN_ERROR';
  }
}
