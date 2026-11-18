import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
  StructuredLlmCallDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OllamaStructuredCompletionEmptyContentError,
  OllamaStructuredCompletionInvalidJsonError,
  OllamaStructuredCompletionProviderError,
  OllamaStructuredCompletionSchemaError,
  OllamaStructuredCompletionTimeoutError,
} from './ollama-structured-llm.adapter';
import {
  StructuredSchemaViolation,
  structuredJsonType,
  validateStructuredSchema,
} from './structured-json-schema';

interface MuseCompletionPayload {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Structured output over the local muse2api gateway (an OpenAI-compatible
 * front for a Muse chat session). The gateway has no JSON mode, so the schema
 * is put in the prompt and the reply is parsed leniently: it can contain a
 * garbled first attempt followed by the complete object. Offline indexing roles
 * only; the routing adapter falls back to Ollama on any failure.
 */
@Injectable()
export class MuseStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(MuseStructuredLlmAdapter.name);

  // The gateway levels off at about two parallel chat turns; more only adds latency.
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly config: ConfigService) {}

  /** Waits for a slot, or gives up after `timeoutMs` so the caller can fall back. */
  private async acquire(model: string, timeoutMs: number): Promise<void> {
    const limit = Math.max(
      1,
      Number(this.config.get<string>('MUSE_MAX_CONCURRENCY') ?? 2) || 2,
    );
    if (this.active < limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(onSlot), 1);
        reject(new OllamaStructuredCompletionTimeoutError(model, timeoutMs));
      }, timeoutMs);
      const onSlot = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(onSlot);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    const model = this.config.get<string>('MUSE_MODEL')?.trim() || 'muse-chat';
    // The caller's timeout is tuned for local models (8s for some indexing
    // roles); a Muse chat turn takes about 10s, so it has its own budget.
    const configured = Number(
      this.config.get<string>('MUSE_TIMEOUT_MS') ?? 90_000,
    );
    const timeoutMs = Number.isFinite(configured)
      ? Math.min(180_000, Math.max(5_000, configured))
      : 90_000;
    const schema = input.jsonSchema as unknown as Record<string, unknown>;
    const maxAttempts = 2;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      const startedAt = Date.now();
      const state: Partial<StructuredLlmCallDiagnostics> = {
        providerStatus: 'NETWORK_ERROR',
      };
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
        await this.acquire(model, remaining);
        let payload: MuseCompletionPayload;
        try {
          payload = await this.complete(
            model,
            input,
            schema,
            Math.max(500, deadline - Date.now()),
          );
        } finally {
          this.release();
        }
        state.providerStatus = 200;
        const choice = payload.choices?.[0];
        const content = choice?.message?.content ?? '';
        state.finishReason = choice?.finish_reason ?? undefined;
        state.contentPresent = Boolean(content.trim());
        if (!state.contentPresent)
          throw new OllamaStructuredCompletionEmptyContentError();
        return this.parse<T>(content, schema, input.schemaVersion);
      } catch (error: unknown) {
        lastError = this.mapError(error, model, timeoutMs);
        state.errorCode = (lastError as Error & { code?: string }).code;
        if (lastError instanceof OllamaStructuredCompletionTimeoutError)
          state.providerStatus = 'TIMEOUT';
        if (
          lastError instanceof OllamaStructuredCompletionProviderError &&
          lastError.status
        )
          state.providerStatus = lastError.status;
        const retryable =
          lastError instanceof OllamaStructuredCompletionInvalidJsonError ||
          lastError instanceof OllamaStructuredCompletionSchemaError ||
          lastError instanceof OllamaStructuredCompletionEmptyContentError ||
          (lastError instanceof OllamaStructuredCompletionProviderError &&
            lastError.transient);
        if (!retryable || retry + 1 >= maxAttempts) throw lastError;
      } finally {
        const diagnostics: StructuredLlmCallDiagnostics = {
          modelRole: input.modelRole,
          model,
          providerStatus: state.providerStatus!,
          latencyMs: Date.now() - startedAt,
          configuredTimeoutMs: timeoutMs,
          configuredMaxCompletionTokens: input.maxTokens ?? 0,
          finishReason: state.finishReason,
          endpointContract: 'MUSE2API_CHAT_PROMPTED_JSON',
          contentPresent: state.contentPresent,
          toolCallsPresent: false,
          attempt: (input.attempt ?? 1) + retry,
          errorCode: state.errorCode,
          schemaVersion: input.schemaVersion,
        };
        this.logger.debug(
          `[MuseStructuredCall] ${JSON.stringify(diagnostics)}`,
        );
        try {
          input.onDiagnostics?.(diagnostics);
        } catch {
          this.logger.warn('Muse structured diagnostics callback failed');
        }
      }
    }
    throw lastError ?? new Error('Muse structured completion failed');
  }

  private async complete(
    model: string,
    input: GenerateStructuredObjectInput,
    schema: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<MuseCompletionPayload> {
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.get<string>('MUSE_API_KEY')?.trim() ?? ''}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `${input.systemPrompt}\n\nRespond with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(schema)}`,
          },
          { role: 'user', content: input.userPrompt },
        ],
        temperature: input.temperature ?? 0.1,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      await response.text().catch(() => undefined);
      const status = response.status;
      throw new OllamaStructuredCompletionProviderError(
        model,
        status,
        undefined,
        undefined,
        status >= 500 || status === 429,
        status === 429
          ? 'RATE_LIMITED'
          : status >= 500
            ? 'TRANSIENT_PROVIDER_FAILURE'
            : [400, 401, 403, 404].includes(status)
              ? 'AUTH_OR_CONFIGURATION_FAILURE'
              : 'UNKNOWN_PROVIDER_FAILURE',
      );
    }
    return (await response.json()) as MuseCompletionPayload;
  }

  /** First JSON object in the reply that parses and satisfies the schema. */
  private parse<T>(
    content: string,
    schema: Record<string, unknown>,
    schemaVersion?: string,
  ): T {
    const text = content.replace(/```(?:json)?/gi, '');
    const end = text.lastIndexOf('}');
    let violation: StructuredSchemaViolation | undefined;
    for (
      let start = text.indexOf('{');
      start >= 0 && start < end;
      start = text.indexOf('{', start + 1)
    ) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text.slice(start, end + 1));
      } catch {
        continue;
      }
      try {
        validateStructuredSchema(parsed, schema, '$');
        return parsed as T;
      } catch (error: unknown) {
        if (!(error instanceof StructuredSchemaViolation)) throw error;
        violation ??= error;
      }
    }
    if (violation)
      throw new OllamaStructuredCompletionSchemaError(
        violation.path,
        violation.constraint,
        schemaVersion,
        violation.expectedType,
        violation.actualJsonType ?? structuredJsonType(undefined),
      );
    throw new OllamaStructuredCompletionInvalidJsonError();
  }

  private mapError(error: unknown, model: string, timeoutMs: number): Error {
    if (error instanceof Error) {
      if (
        typeof (error as Error & { code?: unknown }).code === 'string' &&
        (error as Error & { code: string }).code.startsWith('STRUCTURED_')
      )
        return error;
      if (error.name === 'TimeoutError' || error.name === 'AbortError')
        return new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
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

  private baseUrl(): string {
    return (
      this.config.get<string>('MUSE_BASE_URL')?.trim() ||
      'http://127.0.0.1:18610/v1'
    ).replace(/\/+$/, '');
  }
}
