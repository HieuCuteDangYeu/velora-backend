import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroqKeyPool } from '@ai/infrastructure/services/groq-key-pool.service';

export interface GroqTextMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

@Injectable()
export class GroqTextClient {
  private readonly logger = new Logger(GroqTextClient.name);

  private readonly keyPool: GroqKeyPool;

  constructor(
    private readonly config: ConfigService,
    keyPool?: GroqKeyPool,
  ) {
    this.keyPool = keyPool ?? new GroqKeyPool(config);
    if (!keyPool) {
      try {
        this.keyPool.onModuleInit();
      } catch {
        // Fallback for minimal test environments
      }
    }
  }

  async generateText(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<string> {
    return await this.generateChatText({
      model:
        input.model ||
        this.config.getOrThrow<string>('AI_MEMORY_EXTRACTION_MODEL'),
      maxTokens: input.maxTokens ?? 512,
      temperature: input.temperature ?? 0.1,
      timeoutMs: input.timeoutMs,
      messages: [{ role: 'user', content: input.prompt }],
    });
  }

  async generateChatText(input: {
    model: string;
    messages: GroqTextMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    onToken?: (token: string) => void;
  }): Promise<string> {
    const timeoutMs = this.timeout(input.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const streaming = Boolean(input.onToken);
    const maxAttempts = Math.min(3, Math.max(1, this.keyPool.size));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(`Groq text request timed out after ${timeoutMs}ms`);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      timer.unref();

      let keyIndex: number | undefined;
      try {
        const { key: apiKey, index } = await this.keyPool.acquireAsync(
          Math.max(remainingMs, 45_000),
          input.model,
        );
        keyIndex = index;
        const response = await fetch(`${this.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(streaming ? { Accept: 'text/event-stream' } : {}),
          },
          body: JSON.stringify({
            model: input.model,
            messages: input.messages,
            max_completion_tokens: input.maxTokens ?? 450,
            temperature: input.temperature ?? 0.2,
            reasoning_effort: this.reasoningEffort(input.model),
            stream: streaming,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const raw = await response.text();
          if (response.status === 429) {
            this.keyPool.reportRateLimited(
              keyIndex,
              response.headers,
              raw,
              input.model,
            );
            if (attempt + 1 < maxAttempts) {
              keyIndex = undefined;
              continue;
            }
          } else if (response.status >= 500) {
            this.keyPool.reportTransientFailure(keyIndex, input.model);
          }
          keyIndex = undefined;
          throw new Error(
            `Groq text request failed with status ${response.status}: ${raw.slice(0, 500)}`,
          );
        }
        this.keyPool.reportSuccess(keyIndex, response.headers, input.model);
        keyIndex = undefined;
        if (streaming) return await this.readStream(response, input.onToken!);
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const content = payload.choices?.[0]?.message?.content?.trim() || '';
        if (!content)
          throw new Error('Groq text request returned empty content');
        return content;
      } catch (error: unknown) {
        if (keyIndex !== undefined) {
          this.keyPool.reportTransientFailure(keyIndex, input.model);
        }
        if (controller.signal.aborted)
          throw new Error(`Groq text request timed out after ${timeoutMs}ms`);
        this.logger.debug(
          `Groq text request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('Groq text request exceeded max retry attempts');
  }

  private async readStream(
    response: Response,
    onToken: (token: string) => void,
  ): Promise<string> {
    if (!response.body) throw new Error('Groq text stream returned no body');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        const payload = JSON.parse(data) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const token = payload.choices?.[0]?.delta?.content || '';
        if (token) {
          full += token;
          onToken(token);
        }
      }
    }
    if (!full.trim())
      throw new Error('Groq text stream returned empty content');
    return full.trim();
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }

  private reasoningEffort(model: string): string | undefined {
    if (!model.startsWith('openai/gpt-oss-')) return undefined;
    const value = this.config
      .get<string>('GROQ_REASONING_EFFORT')
      ?.trim()
      .toLowerCase();
    return value === 'low' || value === 'medium' || value === 'high'
      ? value
      : undefined;
  }

  private timeout(requestTimeoutMs?: number): number {
    const configured = Number(
      this.config.get<string>('GROQ_TEXT_TIMEOUT_MS') ?? 45_000,
    );
    const fallback = Number.isFinite(configured) ? configured : 45_000;
    const requested = Number(requestTimeoutMs ?? fallback);
    return Number.isFinite(requested)
      ? Math.min(120_000, Math.max(500, Math.round(requested)))
      : fallback;
  }
}
