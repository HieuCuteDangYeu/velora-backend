import type {
  IToolCallingLlmService,
  LlmToolCall,
  ToolCallingCompletionInput,
  ToolCallingCompletionResult,
  ToolCallingMessage,
} from '@ai/domain/interfaces/tool-calling-llm.service.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroqKeyPool } from '@ai/infrastructure/services/groq-key-pool.service';

interface GroqToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string | Record<string, unknown> };
}

interface GroqToolCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: { content?: string | null; tool_calls?: GroqToolCall[] };
  }>;
  error?: { code?: number | string; message?: string };
}

@Injectable()
export class GroqToolCallingLlmAdapter implements IToolCallingLlmService {
  private readonly logger = new Logger(GroqToolCallingLlmAdapter.name);

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

  async complete(
    input: ToolCallingCompletionInput,
  ): Promise<ToolCallingCompletionResult> {
    const model =
      input.model?.trim() ||
      this.config.getOrThrow<string>('AI_RETRIEVAL_TOOL_MODEL');
    const timeoutMs = this.resolveTimeout(input.timeoutMs);
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = Math.min(3, Math.max(1, this.keyPool.size));

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Groq tool-calling request timed out after ${timeoutMs}ms`,
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      timer.unref();

      const { key: apiKey, index: keyIndex } =
        await this.keyPool.acquireAsync(remainingMs);

      try {
        const response = await fetch(`${this.baseUrl()}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model,
            messages: input.messages.map((message) => this.toMessage(message)),
            tools: input.tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: input.toolChoice ?? 'auto',
            parallel_tool_calls: false,
            max_completion_tokens: input.maxTokens ?? 600,
            temperature: input.temperature ?? 0.1,
          }),
          signal: controller.signal,
        });

        const raw = await response.text();
        let payload: GroqToolCompletionResponse = {};
        try {
          payload = JSON.parse(raw) as GroqToolCompletionResponse;
        } catch {
          throw new Error('Groq tool-calling response was invalid JSON');
        }
        if (!response.ok) {
          if (response.status === 429) {
            this.keyPool.reportRateLimited(keyIndex, response.headers, raw);
            if (attempt + 1 < maxAttempts) {
              continue;
            }
          } else if (response.status >= 500) {
            this.keyPool.reportTransientFailure(keyIndex);
          }
          const message =
            payload.error?.message ||
            raw.trim() ||
            `Groq tool-calling request failed with status ${response.status}`;
          this.logger.warn(message);
          throw new Error(message);
        }

        const choice = payload.choices?.[0];
        const message = choice?.message;
        if (!message)
          throw new Error('Groq tool-calling response contained no message');
        this.keyPool.reportSuccess(keyIndex, response.headers);
        return {
          content: message.content?.trim() || undefined,
          toolCalls: (message.tool_calls ?? [])
            .map((call, index) => this.parseToolCall(call, index))
            .filter((call): call is LlmToolCall => Boolean(call)),
          finishReason: choice?.finish_reason ?? undefined,
        };
      } catch (error: unknown) {
        this.keyPool.reportTransientFailure(keyIndex);
        if (controller.signal.aborted)
          throw new Error(
            `Groq tool-calling request timed out after ${timeoutMs}ms`,
          );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    throw new Error('Groq tool-calling exceeded max retry attempts');
  }

  private toMessage(message: ToolCallingMessage): Record<string, unknown> {
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: {
                  name: call.name,
                  arguments: JSON.stringify(call.arguments),
                },
              })),
            }
          : {}),
      };
    }
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        name: message.name,
        content: message.content,
      };
    }
    return { role: message.role, content: message.content };
  }

  private parseToolCall(call: GroqToolCall, index: number): LlmToolCall | null {
    const name = call.function?.name?.trim();
    if (!name) return null;
    return {
      id: call.id?.trim() || `tool-call-${index}`,
      name,
      arguments: this.parseArguments(call.function?.arguments),
    };
  }

  private parseArguments(
    value: string | Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!value) return {};
    if (typeof value === 'object') return value;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      this.logger.warn('Ignoring invalid Groq tool-call arguments');
      return {};
    }
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('GROQ_BASE_URL')?.trim() ||
      'https://api.groq.com/openai/v1'
    ).replace(/\/+$/, '');
  }

  private resolveTimeout(requestTimeoutMs?: number): number {
    const configured = Number(
      this.config.get<string>('GROQ_TOOL_TIMEOUT_MS') ?? '10000',
    );
    const fallback = Number.isFinite(configured) ? configured : 10_000;
    const requested = Number(requestTimeoutMs ?? fallback);
    return Number.isFinite(requested)
      ? Math.min(120_000, Math.max(500, Math.round(requested)))
      : 10_000;
  }
}
