import type {
  GenerateStructuredObjectInput,
  IStructuredLlmService,
} from '@ai/domain/interfaces/structured-llm.service.interface';
import { GroqKeyPoolExhaustedError } from '@ai/infrastructure/services/groq-key-pool.service';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GroqStructuredLlmAdapter } from './groq-structured-llm.adapter';
import { MuseStructuredLlmAdapter } from './muse-structured-llm.adapter';
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

// Offline indexing roles that may run on the local muse2api gateway when
// AI_MUSE_ENABLED=true. AI_MUSE_ROLES (comma-separated) narrows or replaces this.
const DEFAULT_MUSE_ROLES = [
  'METADATA_EXTRACTION',
  'INDEX_QUALITY',
  'SUBTITLE_TRANSLATION',
];

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
    private readonly muse: MuseStructuredLlmAdapter,
  ) {}

  async generateObject<T>(input: GenerateStructuredObjectInput): Promise<T> {
    if (this.useMuse(input.modelRole)) {
      try {
        return await this.muse.generateObject<T>(input);
      } catch (error: unknown) {
        // The gateway rides a browser session that can expire; indexing must
        // keep working on the local model.
        this.logger.warn(
          `Muse failed for ${input.modelRole}; falling back to Ollama: ${error instanceof Error ? error.message : String(error)}`,
        );
        return this.ollama.generateObject<T>(input);
      }
    }
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

  private useMuse(role?: string): boolean {
    if (
      this.config.get<string>('AI_MUSE_ENABLED')?.trim().toLowerCase() !==
      'true'
    )
      return false;
    const configured = this.config.get<string>('AI_MUSE_ROLES')?.trim();
    const roles = configured
      ? configured.split(',').map((item) => item.trim())
      : DEFAULT_MUSE_ROLES;
    return roles.includes(role ?? '');
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
