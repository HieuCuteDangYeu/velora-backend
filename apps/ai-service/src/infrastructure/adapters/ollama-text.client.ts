import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
  tool_name?: string;
}

export interface OllamaChatResponse {
  message?: {
    content?: string;
    tool_calls?: Array<{
      id?: string;
      function?: {
        name?: string;
        arguments?: Record<string, unknown> | string;
      };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaHttpError extends Error {
  readonly code = 'OLLAMA_HTTP_ERROR';
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(
      `Ollama request failed with status ${status}: ${detail.slice(0, 300)}`,
    );
  }
}

@Injectable()
export class OllamaTextClient {
  constructor(private readonly config: ConfigService) {}

  async chat(input: {
    model: string;
    messages: OllamaChatMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    format?: Record<string, unknown>;
    tools?: Array<Record<string, unknown>>;
    onToken?: (token: string) => void;
  }): Promise<OllamaChatResponse> {
    const configured = Number(
      this.config.get<string>('OLLAMA_TEXT_TIMEOUT_MS') ?? 60000,
    );
    const requested = Number(input.timeoutMs ?? configured);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(120000, Math.max(500, requested))
      : 60000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const baseUrl =
        this.config.get<string>('OLLAMA_TEXT_BASE_URL')?.trim() ||
        this.config.get<string>('OLLAMA_BASE_URL')?.trim();
      if (!baseUrl)
        throw new Error(
          'Missing required AI configuration: OLLAMA_TEXT_BASE_URL',
        );
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: input.model,
          messages: input.messages,
          stream: Boolean(input.onToken),
          think: false,
          ...(input.format ? { format: input.format } : {}),
          ...(input.tools ? { tools: input.tools } : {}),
          options: {
            temperature: input.temperature ?? 0.1,
            num_predict: input.maxTokens ?? 512,
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok)
        throw new OllamaHttpError(response.status, await response.text());
      if (!input.onToken) {
        const payload = (await response.json()) as OllamaChatResponse;
        if (!payload || typeof payload !== 'object' || !payload.message)
          throw Object.assign(new Error('Ollama returned no message'), {
            code: 'OLLAMA_INVALID_RESPONSE',
          });
        return payload;
      }
      if (!response.body) throw new Error('Ollama stream returned no body');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let content = '';
      let last: OllamaChatResponse = {};
      const consume = (line: string) => {
        if (!line.trim()) return;
        const part = JSON.parse(line) as OllamaChatResponse & {
          error?: string;
        };
        if (part.error) throw new Error(`Ollama stream failed: ${part.error}`);
        const token = part.message?.content ?? '';
        if (token) {
          content += token;
          input.onToken!(token);
        }
        if (part.done) last = part;
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(consume);
      }
      consume(buffer + decoder.decode());
      if (!last.done || !content.trim())
        throw Object.assign(new Error('Ollama stream incomplete or empty'), {
          code: 'OLLAMA_INVALID_RESPONSE',
        });
      return { ...last, message: { ...last.message, content } };
    } catch (error: unknown) {
      if (controller.signal.aborted)
        throw Object.assign(
          new Error(`Ollama request timed out after ${timeoutMs}ms`),
          { code: 'OLLAMA_TIMEOUT' },
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async generateText(input: {
    prompt: string;
    model?: string;
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  }): Promise<string> {
    return this.generateChatText({
      ...input,
      model:
        input.model ||
        this.config.getOrThrow<string>('AI_MEMORY_EXTRACTION_MODEL'),
      messages: [{ role: 'user', content: input.prompt }],
    });
  }

  async generateChatText(input: {
    model: string;
    messages: OllamaChatMessage[];
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
    onToken?: (token: string) => void;
  }): Promise<string> {
    const response = await this.chat(input);
    const content = response.message?.content?.trim();
    if (!content)
      throw Object.assign(new Error('Ollama text returned empty content'), {
        code: 'OLLAMA_EMPTY_CONTENT',
      });
    return content;
  }
}
