import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
  StructuredProviderFailureCategory,
  StructuredRateLimitDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { GroqKeyPoolExhaustedError } from '@ai/infrastructure/services/groq-key-pool.service';
import { Injectable, Logger } from '@nestjs/common';
import { GroqHttpError, GroqTextClient } from './groq-text.client';
import {
  OllamaStructuredCompletionEmptyContentError,
  OllamaStructuredCompletionInvalidJsonError,
  OllamaStructuredCompletionProviderError,
  OllamaStructuredCompletionSchemaError,
  OllamaStructuredCompletionTimeoutError,
  OllamaStructuredCompletionTruncatedError,
} from './ollama-structured-llm.adapter';
import {
  StructuredSchemaViolation,
  structuredJsonType,
  validateStructuredSchema,
} from './structured-json-schema';

// Groq enforces `json_schema` with constrained decoding only on these model
// families; the Llama 3.x instant/versatile models accept `json_object` only.
const STRICT_SCHEMA_MODELS =
  /^(openai\/gpt-oss|meta-llama\/llama-4|moonshotai\/)/;

/**
 * Structured output over Groq. The error classes and codes are shared with the
 * Ollama adapter (`STRUCTURED_COMPLETION_*`) so use cases treat both providers
 * identically; GroqKeyPoolExhaustedError is deliberately not mapped so the
 * routing adapter can fall back to a local model.
 */
@Injectable()
export class GroqStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(GroqStructuredLlmAdapter.name);

  constructor(private readonly client: GroqTextClient) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    const model = input.model?.trim();
    if (!model) throw new Error('Structured LLM requests require a model');
    const requested = Number(input.timeoutMs ?? 30_000);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(120_000, Math.max(500, requested))
      : 30_000;
    const maxTokens = input.maxTokens ?? 500;
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = input.modelRole === 'ROUTER' ? 1 : 2;
    const schema = input.jsonSchema as unknown as Record<string, unknown>;
    const strict =
      STRICT_SCHEMA_MODELS.test(model) &&
      input.jsonSchema.additionalProperties === false;
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      const attempt = (input.attempt ?? 1) + retry;
      const startedAt = Date.now();
      const state: Partial<StructuredLlmCallDiagnostics> & {
        inputTokens?: number;
        outputTokens?: number;
      } = { providerStatus: 'NETWORK_ERROR' };
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
        const response = await this.client.chat({
          model,
          messages: [
            {
              role: 'system',
              content: strict
                ? input.systemPrompt
                : `${input.systemPrompt}\n\nRespond with a single JSON object matching this JSON schema:\n${JSON.stringify(schema)}`,
            },
            { role: 'user', content: input.userPrompt },
          ],
          maxTokens,
          temperature: input.temperature ?? 0.1,
          timeoutMs: remaining,
          responseFormat: strict
            ? {
                type: 'json_schema',
                json_schema: {
                  name: 'structured_output',
                  strict: true,
                  schema,
                },
              }
            : { type: 'json_object' },
        });
        state.providerStatus = 200;
        state.finishReason = response.finishReason;
        state.inputTokens = response.promptTokens;
        state.outputTokens = response.completionTokens;
        state.responseContentType = structuredJsonType(response.content);
        state.contentPresent = Boolean(response.content.trim());
        if (response.finishReason === 'length')
          throw new OllamaStructuredCompletionTruncatedError(
            model,
            maxTokens,
            'length',
          );
        if (!state.contentPresent)
          throw new OllamaStructuredCompletionEmptyContentError();
        let parsed: unknown;
        try {
          parsed = JSON.parse(response.content);
        } catch {
          throw new OllamaStructuredCompletionInvalidJsonError();
        }
        try {
          validateStructuredSchema(parsed, schema, '$');
        } catch (error: unknown) {
          if (error instanceof StructuredSchemaViolation)
            throw new OllamaStructuredCompletionSchemaError(
              error.path,
              error.constraint,
              input.schemaVersion,
              error.expectedType,
              error.actualJsonType,
            );
          throw error;
        }
        return parsed as T;
      } catch (error: unknown) {
        if (error instanceof GroqKeyPoolExhaustedError) {
          state.errorCode = error.code;
          throw error;
        }
        const mapped = this.mapError(error, model, timeoutMs);
        state.errorCode = mapped.code;
        if (mapped instanceof OllamaStructuredCompletionTimeoutError) {
          state.providerStatus = 'TIMEOUT';
          state.transient = true;
          state.providerCategory = 'TRANSIENT_PROVIDER_FAILURE';
        }
        if (mapped instanceof OllamaStructuredCompletionProviderError) {
          state.providerStatus = mapped.status ?? 'NETWORK_ERROR';
          state.providerCategory = mapped.providerCategory;
          state.transient = mapped.transient;
          state.retryAfterMs = mapped.retryAfterMs;
          state.rateLimit = mapped.rateLimit;
        }
        if (mapped instanceof OllamaStructuredCompletionSchemaError) {
          state.schemaPath = mapped.path;
          state.schemaConstraint = mapped.constraint;
          state.schemaVersion = mapped.schemaVersion;
          state.expectedType = mapped.expectedType;
          state.actualJsonType = mapped.actualJsonType;
        }
        if (
          retry + 1 >= maxAttempts ||
          !(
            mapped instanceof OllamaStructuredCompletionProviderError &&
            mapped.transient
          )
        )
          throw mapped;
      } finally {
        const diagnostics: StructuredLlmCallDiagnostics = {
          modelRole: input.modelRole,
          model,
          providerStatus: state.providerStatus!,
          latencyMs: Date.now() - startedAt,
          configuredTimeoutMs: timeoutMs,
          configuredMaxCompletionTokens: maxTokens,
          finishReason: state.finishReason,
          endpointContract: strict
            ? 'GROQ_CHAT_JSON_SCHEMA'
            : 'GROQ_CHAT_JSON_OBJECT',
          responseContentType: state.responseContentType,
          contentPresent: state.contentPresent,
          toolCallsPresent: false,
          attempt,
          usage:
            state.inputTokens !== undefined || state.outputTokens !== undefined
              ? {
                  inputTokens: state.inputTokens,
                  outputTokens: state.outputTokens,
                  totalTokens:
                    (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
                }
              : undefined,
          errorCode: state.errorCode,
          providerCategory: state.providerCategory,
          retryAfterMs: state.retryAfterMs,
          rateLimit: state.rateLimit,
          transient: state.transient,
          schemaPath: state.schemaPath,
          schemaConstraint: state.schemaConstraint,
          schemaVersion: state.schemaVersion ?? input.schemaVersion,
          expectedType: state.expectedType,
          actualJsonType: state.actualJsonType,
        };
        this.logger.debug(
          `[GroqStructuredCall] ${JSON.stringify(diagnostics)}`,
        );
        try {
          input.onDiagnostics?.(diagnostics);
        } catch {
          this.logger.warn('Groq structured diagnostics callback failed');
        }
      }
    }
    throw new Error('Groq structured completion exhausted its attempts');
  }

  private mapError(
    error: unknown,
    model: string,
    timeoutMs: number,
  ): Error & { code?: string } {
    if (error instanceof GroqHttpError) {
      const category: StructuredProviderFailureCategory =
        error.status === 429
          ? 'RATE_LIMITED'
          : error.status >= 500
            ? 'TRANSIENT_PROVIDER_FAILURE'
            : [400, 401, 403, 404].includes(error.status)
              ? 'AUTH_OR_CONFIGURATION_FAILURE'
              : 'UNKNOWN_PROVIDER_FAILURE';
      const rateLimit = this.rateLimit(error.headers);
      return new OllamaStructuredCompletionProviderError(
        model,
        error.status,
        undefined,
        this.retryAfterMs(error.headers),
        error.status >= 500,
        category,
        rateLimit,
      );
    }
    if (error instanceof Error && 'code' in error) {
      if (error.code === 'GROQ_TIMEOUT')
        return new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
      if (error.code === 'GROQ_INVALID_RESPONSE')
        return new OllamaStructuredCompletionProviderError(
          model,
          undefined,
          undefined,
          undefined,
          false,
          'UNKNOWN_PROVIDER_FAILURE',
        );
      if (
        typeof error.code === 'string' &&
        error.code.startsWith('STRUCTURED_')
      )
        return error as Error & { code: string };
    }
    return new OllamaStructuredCompletionProviderError(
      model,
      undefined,
      undefined,
      undefined,
      true,
      'TRANSIENT_PROVIDER_FAILURE',
    );
  }

  private retryAfterMs(headers?: Headers): number | undefined {
    const seconds = Number(headers?.get('retry-after'));
    return Number.isFinite(seconds) && seconds >= 0
      ? Math.round(seconds * 1000)
      : undefined;
  }

  private rateLimit(
    headers?: Headers,
  ): StructuredRateLimitDiagnostics | undefined {
    if (!headers) return undefined;
    const value = (name: string) => headers.get(name) ?? undefined;
    const rateLimit: StructuredRateLimitDiagnostics = {
      retryAfter: value('retry-after'),
      limitRequests: value('x-ratelimit-limit-requests'),
      limitTokens: value('x-ratelimit-limit-tokens'),
      remainingRequests: value('x-ratelimit-remaining-requests'),
      remainingTokens: value('x-ratelimit-remaining-tokens'),
      resetRequests: value('x-ratelimit-reset-requests'),
      resetTokens: value('x-ratelimit-reset-tokens'),
    };
    return Object.values(rateLimit).some(Boolean) ? rateLimit : undefined;
  }
}
