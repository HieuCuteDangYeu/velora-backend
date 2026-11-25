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

interface CloudflareCompletionPayload {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
}

/**
 * Structured output for the live answer roles on a larger Cloudflare Workers AI model
 * (AI_CLOUDFLARE_LLM_MODEL), through the same OpenAI-compatible endpoint the vision adapter calls.
 * The schema goes in the prompt and the reply is parsed leniently and validated, so a model without a
 * JSON mode still works. Routing is opt-in per role in HybridStructuredLlmAdapter, which falls back to
 * the local model on any failure here.
 */
@Injectable()
export class CloudflareStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(CloudflareStructuredLlmAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    const model = this.config.get<string>('AI_CLOUDFLARE_LLM_MODEL')?.trim();
    if (!model) {
      throw new OllamaStructuredCompletionProviderError(
        'unconfigured',
        undefined,
        undefined,
        undefined,
        false,
        'AUTH_OR_CONFIGURATION_FAILURE',
      );
    }
    const configured = Number(
      this.config.get<string>('AI_CLOUDFLARE_LLM_TIMEOUT_MS') ?? 40_000,
    );
    const timeoutMs = Number.isFinite(configured)
      ? Math.min(120_000, Math.max(5_000, configured))
      : 40_000;
    const schema = input.jsonSchema as unknown as Record<string, unknown>;
    const maxAttempts = 2;
    const deadline = Date.now() + timeoutMs;
    let lastError: Error | undefined;
    // The reason the previous reply was rejected, told to the model on the retry: the identical request
    // at low temperature tends to repeat the same mistake, and a fallback to the local model costs ~20 s.
    let rejection: string | undefined;
    for (let retry = 0; retry < maxAttempts; retry += 1) {
      const startedAt = Date.now();
      const state: Partial<StructuredLlmCallDiagnostics> = {
        providerStatus: 'NETWORK_ERROR',
      };
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
          throw new OllamaStructuredCompletionTimeoutError(model, timeoutMs);
        const payload = await this.complete(
          model,
          input,
          schema,
          remaining,
          rejection,
        );
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
        rejection =
          lastError instanceof OllamaStructuredCompletionInvalidJsonError ||
          lastError instanceof OllamaStructuredCompletionSchemaError
            ? lastError.message
            : undefined;
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
          endpointContract: 'CLOUDFLARE_CHAT_PROMPTED_JSON',
          contentPresent: state.contentPresent,
          toolCallsPresent: false,
          attempt: (input.attempt ?? 1) + retry,
          errorCode: state.errorCode,
          schemaVersion: input.schemaVersion,
        };
        this.logger.debug(
          `[CloudflareStructuredCall] ${JSON.stringify(diagnostics)}`,
        );
        try {
          input.onDiagnostics?.(diagnostics);
        } catch {
          this.logger.warn('Cloudflare structured diagnostics callback failed');
        }
      }
    }
    throw lastError ?? new Error('Cloudflare structured completion failed');
  }

  private async complete(
    model: string,
    input: GenerateStructuredObjectInput,
    schema: Record<string, unknown>,
    timeoutMs: number,
    rejection?: string,
  ): Promise<CloudflareCompletionPayload> {
    const response = await fetch(`${this.baseUrl()}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: `${input.systemPrompt}\n\nRespond with a single JSON object matching this JSON schema, and nothing else:\n${JSON.stringify(schema)}`,
          },
          {
            role: 'user',
            content: rejection
              ? `${input.userPrompt}\n\nYour previous reply was rejected (${rejection}). Reply again with one corrected JSON object that satisfies the schema exactly, with no other text.`
              : input.userPrompt,
          },
        ],
        temperature: input.temperature ?? 0.1,
        max_tokens: input.maxTokens ?? 1_024,
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
    return (await response.json()) as CloudflareCompletionPayload;
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

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.get<string>('CLOUDFLARE_API_TOKEN')?.trim() ?? ''}`,
      'Content-Type': 'application/json',
      'cf-aig-skip-cache': 'true',
    };
    const gatewayId = this.config
      .get<string>('CLOUDFLARE_AI_GATEWAY_ID')
      ?.trim();
    const gatewayOn =
      this.config
        .get<string>('CLOUDFLARE_AI_GATEWAY_ENABLED')
        ?.trim()
        .toLowerCase() !== 'false';
    if (gatewayOn && gatewayId) headers['cf-aig-gateway-id'] = gatewayId;
    return headers;
  }

  private baseUrl(): string {
    const account = this.config.get<string>('CLOUDFLARE_ACCOUNT_ID')?.trim();
    return `https://api.cloudflare.com/client/v4/accounts/${account ?? ''}/ai/v1`;
  }
}
