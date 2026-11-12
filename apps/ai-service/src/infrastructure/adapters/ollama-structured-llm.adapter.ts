import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
  StructuredJsonType,
  StructuredProviderFailureCategory,
  StructuredRateLimitDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OllamaHttpError, OllamaTextClient } from './ollama-text.client';
import {
  StructuredSchemaViolation,
  structuredJsonType,
  validateStructuredSchema,
} from './structured-json-schema';

interface CallState {
  providerStatus: number | 'NETWORK_ERROR' | 'TIMEOUT';
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  errorCode?: string;
  providerCategory?: StructuredProviderFailureCategory;
  transient?: boolean;
  schemaPath?: string;
  schemaConstraint?: string;
  schemaVersion?: string;
  expectedType?: StructuredJsonType;
  actualJsonType?: StructuredJsonType;
  responseContentType?: StructuredJsonType;
  contentPresent?: boolean;
}

export class OllamaStructuredCompletionTruncatedError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_TRUNCATED';

  constructor(
    readonly model: string,
    readonly requestedMaxTokens: number,
    readonly finishReason: string,
  ) {
    super(
      `Structured completion was truncated (model=${model}, maxTokens=${requestedMaxTokens}, finishReason=${finishReason})`,
    );
    this.name = 'OllamaStructuredCompletionTruncatedError';
  }
}

export class OllamaStructuredCompletionInvalidJsonError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_INVALID_JSON';

  constructor() {
    super('Structured completion returned invalid JSON');
    this.name = 'OllamaStructuredCompletionInvalidJsonError';
  }
}

export class OllamaStructuredCompletionSchemaError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_SCHEMA_INVALID';

  constructor(
    readonly path: string,
    readonly constraint: string,
    readonly schemaVersion?: string,
    readonly expectedType?: StructuredJsonType,
    readonly actualJsonType?: StructuredJsonType,
  ) {
    super(
      `Structured completion failed local schema validation (path=${path}, constraint=${constraint})`,
    );
    this.name = 'OllamaStructuredCompletionSchemaError';
  }
}

export class OllamaStructuredCompletionEmptyContentError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_EMPTY_CONTENT';

  constructor() {
    super('Structured completion returned empty content');
    this.name = 'OllamaStructuredCompletionEmptyContentError';
  }
}

export class OllamaStructuredCompletionProviderError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_PROVIDER_ERROR';

  constructor(
    readonly model: string,
    readonly status?: number,
    readonly providerCode?: number | string,
    readonly retryAfterMs?: number,
    readonly transient = false,
    readonly providerCategory: StructuredProviderFailureCategory = 'UNKNOWN_PROVIDER_FAILURE',
    readonly rateLimit?: StructuredRateLimitDiagnostics,
    readonly keyExhausted = false,
  ) {
    super(
      status
        ? `Ollama structured completion failed (model=${model}, status=${status})`
        : `Ollama structured completion failed (model=${model})`,
    );
    this.name = 'OllamaStructuredCompletionProviderError';
  }
}

export class OllamaStructuredCompletionTimeoutError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_TIMEOUT';

  constructor(
    readonly model: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Structured completion timed out (model=${model}, timeoutMs=${timeoutMs})`,
    );
    this.name = 'OllamaStructuredCompletionTimeoutError';
  }
}

// The model host is reached through a reverse tunnel that restarts within a few
// seconds when it drops. An immediate retry hits the closed listener, so wait first.
const NETWORK_ERROR_RETRY_DELAY_MS = 2_500;

@Injectable()
export class OllamaStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(OllamaStructuredLlmAdapter.name);

  constructor(
    private readonly client: OllamaTextClient,
    private readonly config: ConfigService,
  ) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    const model = input.model?.trim();
    if (!model) throw new Error('Structured LLM requests require a model role');
    const configured = Number(
      this.config.get<string>('OLLAMA_STRUCTURED_TIMEOUT_MS') ?? 60000,
    );
    const requested = Number(input.timeoutMs ?? configured);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(120000, Math.max(500, requested))
      : 60000;
    const maxTokens = input.maxTokens ?? 500;
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = input.modelRole === 'ROUTER' ? 1 : 2;
    for (let retry = 0; retry < maxAttempts; retry++) {
      const attempt = (input.attempt ?? 1) + retry;
      const state: CallState = { providerStatus: 'NETWORK_ERROR' };
      let retryDelayMs = 0;
      const startedAt = Date.now();
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
        const response = await this.client.chat({
          model,
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: input.userPrompt },
          ],
          maxTokens,
          temperature: input.temperature ?? 0.1,
          timeoutMs: remaining,
          format: input.jsonSchema as unknown as Record<string, unknown>,
        });
        state.providerStatus = 200;
        state.finishReason = response.done_reason;
        state.inputTokens = response.prompt_eval_count;
        state.outputTokens = response.eval_count;
        const content = response.message?.content;
        state.responseContentType = structuredJsonType(content);
        state.contentPresent =
          typeof content === 'string' && Boolean(content.trim());
        if (response.done_reason === 'length')
          throw new OllamaStructuredCompletionTruncatedError(
            model,
            maxTokens,
            'length',
          );
        if (!state.contentPresent)
          throw new OllamaStructuredCompletionEmptyContentError();
        let parsed: unknown;
        try {
          parsed = JSON.parse(content!);
        } catch {
          throw new OllamaStructuredCompletionInvalidJsonError();
        }
        try {
          validateStructuredSchema(
            parsed,
            input.jsonSchema as unknown as Record<string, unknown>,
            '$',
          );
        } catch (error: unknown) {
          if (error instanceof StructuredSchemaViolation)
            throw new OllamaStructuredCompletionSchemaError(
              error.path,
              error.constraint,
              input.schemaVersion,
              error.expectedType,
              error.actualJsonType,
            );
          throw new OllamaStructuredCompletionSchemaError(
            '$',
            'unknown',
            input.schemaVersion,
          );
        }
        return parsed as T;
      } catch (error: unknown) {
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
        retryDelayMs = mapped.retryAfterMs ?? 0;
      } finally {
        const usage =
          state.inputTokens !== undefined || state.outputTokens !== undefined
            ? {
                inputTokens: state.inputTokens,
                outputTokens: state.outputTokens,
                totalTokens:
                  (state.inputTokens ?? 0) + (state.outputTokens ?? 0),
              }
            : undefined;
        const diagnostics = {
          modelRole: input.modelRole,
          model,
          providerStatus: state.providerStatus,
          latencyMs: Date.now() - startedAt,
          configuredTimeoutMs: timeoutMs,
          configuredMaxCompletionTokens: maxTokens,
          finishReason: state.finishReason,
          endpointContract: 'OLLAMA_CHAT_JSON_SCHEMA',
          responseContentType: state.responseContentType,
          contentPresent: state.contentPresent,
          toolCallsPresent: false,
          attempt,
          usage,
          errorCode: state.errorCode,
          providerCategory: state.providerCategory,
          transient: state.transient,
          schemaPath: state.schemaPath,
          schemaConstraint: state.schemaConstraint,
          schemaVersion: state.schemaVersion ?? input.schemaVersion,
          expectedType: state.expectedType,
          actualJsonType: state.actualJsonType,
        };
        this.logger.debug(
          `[OllamaStructuredCall] ${JSON.stringify(diagnostics)}`,
        );
        try {
          input.onDiagnostics?.(diagnostics);
        } catch {
          this.logger.warn('Ollama structured diagnostics callback failed');
        }
      }
      // After the diagnostics, so the recorded latency excludes the wait.
      const waitMs = Math.min(retryDelayMs, deadline - Date.now() - 1);
      if (waitMs > 0)
        await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
    throw new Error('Ollama structured completion exhausted its attempts');
  }

  private mapError(
    error: unknown,
    model: string,
    timeoutMs: number,
  ): Error & { code?: string } {
    if (error instanceof OllamaHttpError) {
      const category: StructuredProviderFailureCategory =
        error.status === 429
          ? 'RATE_LIMITED'
          : error.status >= 500
            ? 'TRANSIENT_PROVIDER_FAILURE'
            : error.status === 401 ||
                error.status === 403 ||
                error.status === 404
              ? 'AUTH_OR_CONFIGURATION_FAILURE'
              : 'UNKNOWN_PROVIDER_FAILURE';
      return new OllamaStructuredCompletionProviderError(
        model,
        error.status,
        undefined,
        undefined,
        error.status >= 500,
        category,
      );
    }
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'OLLAMA_TIMEOUT'
    )
      return new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
    if (
      error instanceof Error &&
      'code' in error &&
      error.code === 'OLLAMA_INVALID_RESPONSE'
    )
      return new OllamaStructuredCompletionProviderError(
        model,
        undefined,
        undefined,
        undefined,
        false,
        'UNKNOWN_PROVIDER_FAILURE',
      );
    if (
      error instanceof Error &&
      'code' in error &&
      typeof error.code === 'string' &&
      error.code.startsWith('STRUCTURED_')
    )
      return error as Error & { code: string };
    return new OllamaStructuredCompletionProviderError(
      model,
      undefined,
      undefined,
      NETWORK_ERROR_RETRY_DELAY_MS,
      true,
      'TRANSIENT_PROVIDER_FAILURE',
    );
  }
}
