import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { GroqKeyPoolExhaustedError } from '@ai/infrastructure/services/groq-key-pool.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroqStructuredLlmAdapter } from './groq-structured-llm.adapter';
import {
  OllamaStructuredCompletionProviderError,
  OllamaStructuredLlmAdapter,
} from './ollama-structured-llm.adapter';

// Latency-critical, small-prompt roles run on Groq; token-heavy checks stay on
// local Ollama so they consume no Groq quota. Unlisted roles stay local.
const GROQ_ROLES = new Set([
  'ROUTER',
  'RETRIEVAL_PLANNER',
  'PLANNER',
  'ANSWER',
  'DRAFT_ANSWER',
]);

const CAPACITY_CATEGORIES = new Set([
  'RATE_LIMITED',
  'ACCOUNT_LIMITED',
  'OUT_OF_CAPACITY',
]);

/**
 * Routes structured generation by `modelRole`. Groq is opt-in through
 * AI_GROQ_HYBRID_ENABLED because the Groq roles then need Groq model names in
 * their AI_*_MODEL settings. When Groq has no capacity the call is retried on
 * Ollama using AI_OLLAMA_FALLBACK_MODEL (default: AI_VERIFIER_MODEL).
 */
@Injectable()
export class HybridStructuredLlmAdapter implements IStructuredLlmService {
  private readonly logger = new Logger(HybridStructuredLlmAdapter.name);

  constructor(
    private readonly groq: GroqStructuredLlmAdapter,
    private readonly ollama: OllamaStructuredLlmAdapter,
    private readonly config: ConfigService,
  ) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    if (!this.useGroq(input.modelRole))
      return this.ollama.generateObject<T>(input);
    try {
      return await this.groq.generateObject<T>(input);
    } catch (error: unknown) {
      if (!this.outOfCapacity(error)) throw error;
      const model =
        this.config.get<string>('AI_OLLAMA_FALLBACK_MODEL')?.trim() ||
        this.config.get<string>('AI_VERIFIER_MODEL')?.trim();
      if (!model) throw error;
      this.logger.warn(
        `Groq unavailable for ${input.modelRole}; falling back to Ollama model ${model}`,
      );
      return this.ollama.generateObject<T>({ ...input, model });
    }
  }

  private useGroq(role?: string): boolean {
    return (
      this.config
        .get<string>('AI_GROQ_HYBRID_ENABLED')
        ?.trim()
        .toLowerCase() === 'true' && GROQ_ROLES.has(role ?? '')
    );
  }

  private outOfCapacity(error: unknown): boolean {
    return (
      error instanceof GroqKeyPoolExhaustedError ||
      (error instanceof OllamaStructuredCompletionProviderError &&
        CAPACITY_CATEGORIES.has(error.providerCategory))
    );
  }
}
