import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
  StructuredJsonType,
  StructuredProviderFailureCategory,
  StructuredRateLimitDiagnostics,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface GroqCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | Record<string, unknown> | null };
  }>;
  error?: { code?: number | string; message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface CallState {
  providerStatus: number | 'NETWORK_ERROR' | 'TIMEOUT';
  finishReason?: string;
  usage?: GroqCompletionResponse['usage'];
  errorCode?: string;
  providerCode?: number | string;
  providerCategory?: StructuredProviderFailureCategory;
  retryAfterMs?: number;
  rateLimit?: StructuredRateLimitDiagnostics;
  transient?: boolean;
  schemaPath?: string;
  schemaConstraint?: string;
  schemaVersion?: string;
  expectedType?: StructuredJsonType;
  actualJsonType?: StructuredJsonType;
  responseContentType?: StructuredJsonType;
  contentPresent?: boolean;
}

class StructuredSchemaViolation extends Error {
  constructor(
    readonly path: string,
    readonly constraint: string,
    readonly expectedType?: StructuredJsonType,
    readonly actualJsonType?: StructuredJsonType,
  ) {
    super('Structured schema violation');
  }
}

export class GroqStructuredCompletionTruncatedError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_TRUNCATED';

  constructor(
    readonly model: string,
    readonly requestedMaxTokens: number,
    readonly finishReason: string,
  ) {
    super(
      `Structured completion was truncated (model=${model}, maxTokens=${requestedMaxTokens}, finishReason=${finishReason})`,
    );
    this.name = 'GroqStructuredCompletionTruncatedError';
  }
}

export class GroqStructuredCompletionInvalidJsonError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_INVALID_JSON';

  constructor() {
    super('Structured completion returned invalid JSON');
    this.name = 'GroqStructuredCompletionInvalidJsonError';
  }
}

export class GroqStructuredCompletionSchemaError extends Error {
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
    this.name = 'GroqStructuredCompletionSchemaError';
  }
}

export class GroqStructuredCompletionEmptyContentError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_EMPTY_CONTENT';

  constructor() {
    super('Structured completion returned empty content');
    this.name = 'GroqStructuredCompletionEmptyContentError';
  }
}

export class GroqStructuredCompletionProviderError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_PROVIDER_ERROR';

  constructor(
    readonly model: string,
    readonly status?: number,
    readonly providerCode?: number | string,
    readonly retryAfterMs?: number,
    readonly transient = false,
    readonly providerCategory: StructuredProviderFailureCategory = 'UNKNOWN_PROVIDER_FAILURE',
  ) {
    super(
      status
        ? `Groq structured completion failed (model=${model}, status=${status})`
        : `Groq structured completion failed (model=${model})`,
    );
    this.name = 'GroqStructuredCompletionProviderError';
  }
}

export class GroqStructuredCompletionTimeoutError extends Error {
  readonly code = 'STRUCTURED_COMPLETION_TIMEOUT';

  constructor(
    readonly model: string,
    readonly timeoutMs: number,
  ) {
    super(
      `Structured completion timed out (model=${model}, timeoutMs=${timeoutMs})`,
    );
    this.name = 'GroqStructuredCompletionTimeoutError';
  }
}

@Injectable()
export class GroqStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(GroqStructuredLlmAdapter.name);

  constructor(private readonly config: ConfigService) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    const model = input.model?.trim();
    if (!model) throw new Error('Structured LLM requests require a model role');

    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const maxTokens = input.maxTokens ?? 500;
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = input.modelRole === 'ROUTER' ? 1 : 2;

    for (let retry = 0; retry < maxAttempts; retry += 1) {
      const attempt = (input.attempt ?? 1) + retry;
      const state: CallState = { providerStatus: 'NETWORK_ERROR' };
      const startedAt = Date.now();
      let diagnosticsEmitted = false;

      try {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0)
          throw new GroqStructuredCompletionTimeoutError(model, timeoutMs);
        return await this.request<T>(
          input,
          model,
          Math.max(1, Math.min(timeoutMs, remainingMs)),
          maxTokens,
          state,
        );
      } catch (error: unknown) {
        this.captureErrorState(state, error);
        this.emitDiagnostics(
          input,
          model,
          timeoutMs,
          maxTokens,
          attempt,
          startedAt,
          state,
        );
        diagnosticsEmitted = true;

        if (
          !this.shouldRetry(error, input.modelRole) ||
          retry + 1 >= maxAttempts
        )
          throw error;

        const delayMs = this.retryDelayMs(error);
        if (Date.now() + delayMs >= deadline) throw error;
        if (delayMs > 0)
          await new Promise((resolve) => setTimeout(resolve, delayMs));
      } finally {
        if (!diagnosticsEmitted)
          this.emitDiagnostics(
            input,
            model,
            timeoutMs,
            maxTokens,
            attempt,
            startedAt,
            state,
          );
      }
    }

    throw new Error('Structured completion exhausted its bounded attempts');
  }

  private captureErrorState(state: CallState, error: unknown): void {
    state.errorCode =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'STRUCTURED_COMPLETION_UNKNOWN_ERROR';
    if (error instanceof GroqStructuredCompletionTimeoutError) {
      state.providerStatus = 'TIMEOUT';
      state.transient = true;
      state.providerCategory = 'TRANSIENT_PROVIDER_FAILURE';
    }
    if (error instanceof GroqStructuredCompletionProviderError) {
      state.providerCode = error.providerCode;
      state.retryAfterMs = error.retryAfterMs;
      state.transient = error.transient;
      state.providerCategory = error.providerCategory;
    }
    if (error instanceof GroqStructuredCompletionSchemaError) {
      state.schemaPath = error.path;
      state.schemaConstraint = error.constraint;
      state.schemaVersion = error.schemaVersion;
      state.expectedType = error.expectedType;
      state.actualJsonType = error.actualJsonType;
    }
  }

  private emitDiagnostics(
    input: GenerateStructuredObjectInput,
    model: string,
    timeoutMs: number,
    maxTokens: number,
    attempt: number,
    startedAt: number,
    state: CallState,
  ): void {
    const diagnostics = {
      modelRole: input.modelRole,
      model,
      providerStatus: state.providerStatus,
      latencyMs: Date.now() - startedAt,
      configuredTimeoutMs: timeoutMs,
      configuredMaxCompletionTokens: maxTokens,
      finishReason: state.finishReason,
      endpointContract: 'CHAT_JSON_SCHEMA',
      responseContentType: state.responseContentType,
      contentPresent: state.contentPresent,
      toolCallsPresent: false,
      attempt,
      usage: state.usage
        ? {
            inputTokens: state.usage.prompt_tokens,
            outputTokens: state.usage.completion_tokens,
            totalTokens: state.usage.total_tokens,
            reasoningTokens: this.reasoningTokens(state.usage),
          }
        : undefined,
      errorCode: state.errorCode,
      providerCode: state.providerCode,
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
    this.logger.debug(`[GroqStructuredCall] ${JSON.stringify(diagnostics)}`);
    try {
      input.onDiagnostics?.(diagnostics);
    } catch {
      this.logger.warn('Groq structured diagnostics callback failed');
    }
  }

  private shouldRetry(error: unknown, modelRole?: string): boolean {
    if (modelRole === 'ROUTER') return false;
    return (
      error instanceof GroqStructuredCompletionProviderError &&
      error.transient === true &&
      (error.providerCategory === 'RATE_LIMITED' ||
        error.providerCategory === 'TRANSIENT_PROVIDER_FAILURE')
    );
  }

  private retryDelayMs(error: unknown): number {
    return error instanceof GroqStructuredCompletionProviderError
      ? (error.retryAfterMs ?? 0)
      : 0;
  }

  private async request<T>(
    input: GenerateStructuredObjectInput,
    model: string,
    timeoutMs: number,
    maxTokens: number,
    state: CallState,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl()}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.required('GROQ_API_KEY')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: input.systemPrompt },
            { role: 'user', content: input.userPrompt },
          ],
          max_completion_tokens: maxTokens,
          temperature: input.temperature ?? 0.1,
          ...(this.reasoningEffort(model)
            ? { reasoning_effort: this.reasoningEffort(model) }
            : {}),
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: this.schemaName(input.schemaVersion),
              strict: this.structuredStrict(input.modelRole),
              schema: input.jsonSchema,
            },
          },
        }),
        signal: controller.signal,
      });
    } catch {
      if (controller.signal.aborted)
        throw new GroqStructuredCompletionTimeoutError(model, timeoutMs);
      throw new GroqStructuredCompletionProviderError(
        model,
        undefined,
        undefined,
        undefined,
        true,
        'TRANSIENT_PROVIDER_FAILURE',
      );
    } finally {
      clearTimeout(timer);
    }

    state.providerStatus = response.status;
    state.rateLimit = this.readRateLimitHeaders(response.headers);
    state.retryAfterMs = this.parseRetryAfter(
      response.headers.get('retry-after'),
    );

    let payload: GroqCompletionResponse = {};
    const raw = await response.text();
    try {
      payload = JSON.parse(raw) as GroqCompletionResponse;
    } catch {
      const category = this.classifyFailure(response.status, undefined, raw);
      throw new GroqStructuredCompletionProviderError(
        model,
        response.status,
        undefined,
        state.retryAfterMs,
        this.isTransientStatus(response.status, category, state.rateLimit),
        category,
      );
    }

    if (!response.ok) {
      const code = this.providerCode(payload);
      const category = this.classifyFailure(
        response.status,
        code,
        this.providerMessage(payload),
      );
      throw new GroqStructuredCompletionProviderError(
        model,
        response.status,
        code,
        state.retryAfterMs,
        this.isTransientStatus(response.status, category, state.rateLimit),
        category,
      );
    }

    const choice = payload.choices?.[0];
    state.finishReason = choice?.finish_reason ?? undefined;
    state.usage = payload.usage;
    const content = choice?.message?.content;
    state.responseContentType = this.jsonType(content);
    state.contentPresent =
      content !== undefined && content !== null && content !== '';
    if (choice?.finish_reason === 'length')
      throw new GroqStructuredCompletionTruncatedError(
        model,
        maxTokens,
        choice.finish_reason,
      );
    if (!content) throw new GroqStructuredCompletionEmptyContentError();

    let parsed: unknown = content;
    if (typeof content === 'string') {
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new GroqStructuredCompletionInvalidJsonError();
      }
    }
    try {
      this.validateSchema(
        parsed,
        input.jsonSchema as unknown as Record<string, unknown>,
        '$',
      );
    } catch (error: unknown) {
      if (error instanceof StructuredSchemaViolation) {
        throw new GroqStructuredCompletionSchemaError(
          error.path,
          error.constraint,
          input.schemaVersion,
          error.expectedType,
          error.actualJsonType,
        );
      }
      throw new GroqStructuredCompletionSchemaError(
        '$',
        'unknown',
        input.schemaVersion,
      );
    }
    return parsed as T;
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }

  private schemaName(value?: string): string {
    const name = (value || 'structured_response').replace(
      /[^A-Za-z0-9_-]/g,
      '_',
    );
    return name.slice(0, 64) || 'structured_response';
  }

  private reasoningEffort(model: string): string | undefined {
    if (!model.startsWith('openai/gpt-oss-') && model !== 'qwen/qwen3.8-27b') {
      return undefined;
    }
    const value = this.config
      .get<string>('GROQ_REASONING_EFFORT')
      ?.trim()
      .toLowerCase();
    return value === 'low' || value === 'medium' || value === 'high'
      ? value
      : undefined;
  }

  private classifyFailure(
    status: number,
    providerCode?: number | string,
    message?: string,
  ): StructuredProviderFailureCategory {
    const text = [
      message || '',
      typeof providerCode === 'string' ? providerCode : '',
    ]
      .join(' ')
      .toLowerCase();
    if (status === 401 || status === 403)
      return 'AUTH_OR_CONFIGURATION_FAILURE';
    if (status === 429 && this.hasAccountExhaustionEvidence(text))
      return 'ACCOUNT_LIMITED';
    if (status === 429) return 'RATE_LIMITED';
    if (status >= 500) return 'TRANSIENT_PROVIDER_FAILURE';
    if (
      providerCode !== undefined &&
      /(quota|usage|account|billing)/.test(text)
    )
      return 'ACCOUNT_LIMITED';
    return 'UNKNOWN_PROVIDER_FAILURE';
  }

  private hasAccountExhaustionEvidence(text: string): boolean {
    return [
      /\b(?:billing|account|spend)\b[\s\S]{0,80}\b(?:quota|allocation|limit|exhaust(?:ed|ion)?|deplet(?:ed|ion)?|used\s+up)\b[\s\S]{0,80}\b(?:exhausted|depleted|reached|exceeded|used\s+up)\b/,
      /\b(?:hard[-\s]?quota|daily[-\s]?allocation)\b[\s\S]{0,80}\b(?:exhausted|depleted|reached|exceeded|used\s+up)\b/,
      /\b(?:quota|allocation)\b[\s\S]{0,40}\b(?:exhausted|depleted|used\s+up)\b/,
    ].some((pattern) => pattern.test(text));
  }

  private isTransientStatus(
    status: number,
    category?: StructuredProviderFailureCategory,
    rateLimit?: StructuredRateLimitDiagnostics,
  ): boolean {
    if (status >= 500) return true;
    if (status !== 429 || category !== 'RATE_LIMITED') return false;
    return Boolean(rateLimit && Object.keys(rateLimit).length > 0);
  }

  private providerCode(
    payload: GroqCompletionResponse,
  ): number | string | undefined {
    const value = payload.error?.code;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    return undefined;
  }

  private providerMessage(payload: GroqCompletionResponse): string | undefined {
    return payload.error?.message;
  }

  private parseRetryAfter(value: string | null): number | undefined {
    if (!value) return undefined;
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0)
      return Math.min(Math.round(seconds * 1_000), 86_400_000);
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp)
      ? Math.min(Math.max(timestamp - Date.now(), 0), 86_400_000)
      : undefined;
  }

  private readRateLimitHeaders(
    headers: Headers,
  ): StructuredRateLimitDiagnostics | undefined {
    const read = (name: string): string | undefined => {
      const value = headers.get(name)?.trim();
      return value ? value.slice(0, 128) : undefined;
    };
    const rateLimit: StructuredRateLimitDiagnostics = {
      retryAfter: read('retry-after'),
      limitRequests: read('x-ratelimit-limit-requests'),
      limitTokens: read('x-ratelimit-limit-tokens'),
      remainingRequests: read('x-ratelimit-remaining-requests'),
      remainingTokens: read('x-ratelimit-remaining-tokens'),
      resetRequests: read('x-ratelimit-reset-requests'),
      resetTokens: read('x-ratelimit-reset-tokens'),
    };
    const present = Object.fromEntries(
      Object.entries(rateLimit).filter(([, value]) => value !== undefined),
    ) as StructuredRateLimitDiagnostics;
    return Object.keys(present).length > 0 ? present : undefined;
  }

  private jsonType(value: unknown): StructuredJsonType {
    if (value === undefined) return 'absent';
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'string') return 'string';
    if (typeof value === 'number') return 'number';
    if (typeof value === 'boolean') return 'boolean';
    return 'object';
  }

  private reasoningTokens(
    usage: GroqCompletionResponse['usage'],
  ): number | undefined {
    const value = usage?.completion_tokens_details?.reasoning_tokens;
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
      ? value
      : undefined;
  }

  private validateSchema(
    value: unknown,
    schema: Record<string, unknown>,
    path: string,
  ): void {
    const type = schema['type'];
    if (type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new StructuredSchemaViolation(
          path,
          'type',
          'object',
          this.jsonType(value),
        );
      const record = value as Record<string, unknown>;
      const properties = (schema['properties'] ?? {}) as Record<
        string,
        Record<string, unknown>
      >;
      const required = Array.isArray(schema['required'])
        ? (schema['required'] as string[])
        : [];
      const missing = required.find((key) => !(key in record));
      if (missing)
        throw new StructuredSchemaViolation(`${path}.${missing}`, 'required');
      if (
        schema['additionalProperties'] === false &&
        Object.keys(record).some((key) => !(key in properties))
      )
        throw new StructuredSchemaViolation(path, 'additionalProperties');
      for (const [key, propertySchema] of Object.entries(properties))
        if (key in record)
          this.validateSchema(record[key], propertySchema, `${path}.${key}`);
      return;
    }
    if (type === 'array') {
      if (!Array.isArray(value))
        throw new StructuredSchemaViolation(
          path,
          'type',
          'array',
          this.jsonType(value),
        );
      const items = schema['items'];
      if (items && typeof items === 'object')
        value.forEach((item, index) =>
          this.validateSchema(
            item,
            items as Record<string, unknown>,
            `${path}[${index}]`,
          ),
        );
      return;
    }
    if (type === 'string' && typeof value !== 'string')
      throw new StructuredSchemaViolation(
        path,
        'type',
        'string',
        this.jsonType(value),
      );
    if (type === 'boolean' && typeof value !== 'boolean')
      throw new StructuredSchemaViolation(
        path,
        'type',
        'boolean',
        this.jsonType(value),
      );
    if (
      type === 'number' &&
      (typeof value !== 'number' || !Number.isFinite(value))
    )
      throw new StructuredSchemaViolation(
        path,
        'type',
        'number',
        this.jsonType(value),
      );
    const allowed = schema['enum'];
    if (Array.isArray(allowed) && !allowed.includes(value))
      throw new StructuredSchemaViolation(path, 'enum');
  }

  private boolean(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key)?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  private structuredStrict(modelRole?: string): boolean {
    if (modelRole === 'CITATION_ATTRIBUTION') {
      const citationOverride = this.config
        .get<string>('GROQ_STRUCTURED_STRICT_CITATION_ATTRIBUTION')
        ?.trim()
        .toLowerCase();
      if (citationOverride === 'true') return true;
      if (citationOverride === 'false') return false;
    }
    return this.boolean('GROQ_STRUCTURED_STRICT', false);
  }

  private required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new Error(`Missing required AI configuration: ${key}`);
    return value;
  }

  private resolveTimeout(requestTimeoutMs?: number): number {
    const configured = Number(
      this.config.get<string>('GROQ_STRUCTURED_TIMEOUT_MS') ?? '30000',
    );
    const fallback = Number.isFinite(configured) ? configured : 30_000;
    const requested = Number(requestTimeoutMs ?? fallback);
    return Number.isFinite(requested)
      ? Math.min(120_000, Math.max(500, Math.round(requested)))
      : 30_000;
  }
}
