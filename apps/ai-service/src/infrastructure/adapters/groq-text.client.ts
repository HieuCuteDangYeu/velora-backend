import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroqKeyPool } from '@ai/infrastructure/services/groq-key-pool.service';

export interface GroqChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GroqChatResponse {
  content: string;
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
}

export class GroqHttpError extends Error {
  readonly code = 'GROQ_HTTP_ERROR';
  constructor(
    readonly status: number,
    detail: string,
    readonly headers?: Headers,
  ) {
    super(`Groq request failed with status ${status}: ${detail.slice(0, 300)}`);
  }
}

interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface GroqCompletionPayload {
  choices?: Array<{
    message?: { content?: string | null };
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: GroqUsage;
  x_groq?: { usage?: GroqUsage };
}

/** Chat completions against Groq, rotating organization keys via GroqKeyPool. */
@Injectable()
export class GroqTextClient {
  constructor(
    private readonly config: ConfigService,
    private readonly keyPool: GroqKeyPool,
  ) {}

  async chat(input: {
    model: string;
    messages: GroqChatMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    responseFormat?: Record<string, unknown>;
    onToken?: (token: string) => void;
  }): Promise<GroqChatResponse> {
    const timeoutMs = Math.min(
      120_000,
      Math.max(500, Number(input.timeoutMs ?? 60_000) || 60_000),
    );
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = Math.max(1, this.keyPool.size);
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      // Throws GroqKeyPoolExhaustedError, which callers use to fall back.
      const { key, index } = await this.keyPool.acquireAsync(
        Math.min(remainingMs, 5_000),
        input.model,
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      timer.unref();
      try {
        const response = await fetch(`${this.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            temperature: input.temperature ?? 0.1,
            max_completion_tokens: input.maxTokens ?? 512,
            stream: Boolean(input.onToken),
            ...(input.responseFormat
              ? { response_format: input.responseFormat }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const body = await response.text();
          if (response.status === 429) {
            this.keyPool.reportRateLimited(
              index,
              response.headers,
              body,
              input.model,
            );
          } else if (response.status >= 500) {
            this.keyPool.reportTransientFailure(index, input.model);
          }
          const error = new GroqHttpError(
            response.status,
            body,
            response.headers,
          );
          // Only rate limits are worth retrying on another organization's key.
          if (response.status !== 429) throw error;
          lastError = error;
          continue;
        }
        const result = input.onToken
          ? await this.readStream(response, input.onToken)
          : this.fromPayload((await response.json()) as GroqCompletionPayload);
        this.keyPool.reportSuccess(index, response.headers, input.model);
        return result;
      } catch (error: unknown) {
        if (controller.signal.aborted)
          throw Object.assign(
            new Error(`Groq request timed out after ${timeoutMs}ms`),
            { code: 'GROQ_TIMEOUT' },
          );
        if (!(error instanceof GroqHttpError))
          this.keyPool.reportTransientFailure(index, input.model);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw Object.assign(
      new Error(`Groq request timed out after ${timeoutMs}ms`),
      { code: 'GROQ_TIMEOUT' },
    );
  }

  private fromPayload(payload: GroqCompletionPayload): GroqChatResponse {
    const choice = payload.choices?.[0];
    if (!choice)
      throw Object.assign(new Error('Groq returned no choices'), {
        code: 'GROQ_INVALID_RESPONSE',
      });
    return {
      content: choice.message?.content ?? '',
      finishReason: choice.finish_reason ?? undefined,
      promptTokens: payload.usage?.prompt_tokens,
      completionTokens: payload.usage?.completion_tokens,
    };
  }

  private async readStream(
    response: Response,
    onToken: (token: string) => void,
  ): Promise<GroqChatResponse> {
    if (!response.body) throw new Error('Groq stream returned no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let finishReason: string | undefined;
    let usage: GroqUsage | undefined;
    let done = false;
    const consume = (line: string) => {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      const part = JSON.parse(data) as GroqCompletionPayload;
      const choice = part.choices?.[0];
      const token = choice?.delta?.content ?? '';
      if (token) {
        content += token;
        onToken(token);
      }
      if (choice?.finish_reason) finishReason = choice.finish_reason;
      usage = part.x_groq?.usage ?? part.usage ?? usage;
    };
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      lines.forEach(consume);
    }
    consume((buffer + decoder.decode()).trim());
    if (!done && !finishReason)
      throw Object.assign(new Error('Groq stream incomplete'), {
        code: 'GROQ_INVALID_RESPONSE',
      });
    return {
      content,
      finishReason,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
    };
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }
}
