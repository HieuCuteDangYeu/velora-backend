import type {
  IToolCallingLlmService,
  LlmToolCall,
  ToolCallingCompletionInput,
  ToolCallingCompletionResult,
  ToolCallingMessage,
} from '@ai/domain/interfaces/tool-calling-llm.service.interface';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OllamaHttpError,
  OllamaTextClient,
  OllamaChatMessage,
} from './ollama-text.client';

@Injectable()
export class OllamaToolCallingLlmAdapter implements IToolCallingLlmService {
  private readonly logger = new Logger(OllamaToolCallingLlmAdapter.name);
  constructor(
    private readonly client: OllamaTextClient,
    private readonly config: ConfigService,
  ) {}

  async complete(
    input: ToolCallingCompletionInput,
  ): Promise<ToolCallingCompletionResult> {
    const model =
      input.model?.trim() ||
      this.config.getOrThrow<string>('AI_RETRIEVAL_TOOL_MODEL');
    const configured = Number(
      this.config.get<string>('OLLAMA_TOOL_TIMEOUT_MS') ?? 60000,
    );
    const requested = Number(input.timeoutMs ?? configured);
    const timeoutMs = Number.isFinite(requested)
      ? Math.min(120000, Math.max(500, requested))
      : 60000;
    const tools = input.toolChoice === 'none' ? [] : input.tools;
    const messages = input.messages.map((message) => this.toMessage(message));
    if (input.toolChoice === 'required' && tools.length === 0)
      throw Object.assign(new Error('A required tool was not provided'), {
        code: 'TOOL_PROVIDER_INVALID_REQUEST',
      });
    if (input.toolChoice === 'required')
      messages.push({
        role: 'system',
        content:
          'You must call one of the provided tools to answer this request. Do not answer in plain text.',
      });
    try {
      const result = await this.client.chat({
        model,
        messages,
        timeoutMs,
        maxTokens: input.maxTokens ?? 600,
        temperature: input.temperature ?? 0.1,
        ...(tools.length
          ? {
              tools: tools.map((tool) => ({
                type: 'function',
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
      });
      const toolCalls = (result.message?.tool_calls ?? []).map(
        (call, index) => {
          const name = call.function?.name?.trim();
          if (!name || !tools.some((tool) => tool.name === name))
            throw Object.assign(
              new Error(`Ollama returned unknown tool: ${name || '<empty>'}`),
              { code: 'TOOL_PROVIDER_INVALID_RESPONSE' },
            );
          const rawArgs = call.function?.arguments;
          let parsed: unknown = rawArgs;
          if (typeof rawArgs === 'string') {
            try {
              parsed = JSON.parse(rawArgs);
            } catch {
              throw Object.assign(
                new Error('Ollama returned invalid tool arguments'),
                { code: 'TOOL_PROVIDER_INVALID_RESPONSE' },
              );
            }
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            throw Object.assign(
              new Error('Ollama returned invalid tool arguments'),
              { code: 'TOOL_PROVIDER_INVALID_RESPONSE' },
            );
          return {
            id: call.id?.trim() || `tool-call-${index}`,
            name,
            arguments: parsed as Record<string, unknown>,
          };
        },
      );
      if (input.toolChoice === 'required' && toolCalls.length === 0)
        throw Object.assign(new Error('Ollama did not call a required tool'), {
          code: 'TOOL_PROVIDER_TOOL_REQUIRED',
        });
      return {
        content: result.message?.content?.trim() || undefined,
        toolCalls,
        finishReason: result.done_reason,
      };
    } catch (error: unknown) {
      if (error instanceof OllamaHttpError)
        throw Object.assign(new Error(error.message), {
          code: 'TOOL_PROVIDER_HTTP_ERROR',
          httpStatus: error.status,
        });
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'OLLAMA_TIMEOUT'
      )
        throw Object.assign(new Error(error.message), {
          code: 'TOOL_PROVIDER_TIMEOUT',
        });
      this.logger.debug(
        `Ollama tool call failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  private toMessage(message: ToolCallingMessage): OllamaChatMessage {
    if (message.role === 'assistant')
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(message.toolCalls?.length
          ? {
              tool_calls: message.toolCalls.map((call: LlmToolCall) => ({
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    if (message.role === 'tool')
      return {
        role: 'tool',
        tool_name: message.name,
        content: message.content,
      };
    return { role: message.role, content: message.content };
  }
}
