import type {
  AiCompletionRole,
  AiModelRole,
  IAiApplicationConfig,
} from '@ai/domain/interfaces/ai-application-config.interface';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const MODEL_ENV_BY_ROLE: Record<AiModelRole, string> = {
  ROUTER: 'AI_ROUTER_MODEL',
  RETRIEVAL_PLANNER: 'AI_RETRIEVAL_PLANNER_MODEL',
  RETRIEVAL_TOOL: 'AI_RETRIEVAL_TOOL_MODEL',
  CONTEXT_SUFFICIENCY: 'AI_CONTEXT_SUFFICIENCY_MODEL',
  ANSWER: 'AI_ANSWER_MODEL',
  ANSWER_REVISION: 'AI_ANSWER_REVISION_MODEL',
  VERIFIER: 'AI_VERIFIER_MODEL',
  VERIFIER_ESCALATION: 'AI_VERIFIER_ESCALATION_MODEL',
  CITATION_ATTRIBUTION: 'AI_CITATION_ATTRIBUTION_MODEL',
  INDEX_QUALITY: 'AI_INDEX_QUALITY_MODEL',
  METADATA_EXTRACTION: 'AI_METADATA_EXTRACTION_MODEL',
  SECTION_SUMMARY: 'AI_SECTION_SUMMARY_MODEL',
  VISION: 'AI_VISION_MODEL',
  TRANSCRIPTION: 'AI_TRANSCRIPTION_MODEL',
  EMBEDDING: 'AI_EMBEDDING_MODEL',
  RERANKER: 'AI_RERANKER_MODEL',
  CONVERSATION_SUMMARY: 'AI_CONVERSATION_SUMMARY_MODEL',
  MEMORY_EXTRACTION: 'AI_MEMORY_EXTRACTION_MODEL',
};

const TIMEOUT_ENV_BY_ROLE: Partial<Record<AiModelRole, string>> = {
  ROUTER: 'AI_ROUTER_TIMEOUT_MS',
  RETRIEVAL_PLANNER: 'AI_RETRIEVAL_PLANNER_TIMEOUT_MS',
  RETRIEVAL_TOOL: 'AI_RETRIEVAL_TOOL_TIMEOUT_MS',
  CONTEXT_SUFFICIENCY: 'AI_CONTEXT_SUFFICIENCY_TIMEOUT_MS',
  ANSWER: 'AI_ANSWER_TIMEOUT_MS',
  ANSWER_REVISION: 'AI_ANSWER_REVISION_TIMEOUT_MS',
  VERIFIER: 'AI_VERIFIER_TIMEOUT_MS',
  VERIFIER_ESCALATION: 'AI_VERIFIER_ESCALATION_TIMEOUT_MS',
  CITATION_ATTRIBUTION: 'AI_CITATION_TIMEOUT_MS',
  VISION: 'AI_VISION_TIMEOUT_MS',
  TRANSCRIPTION: 'AI_TRANSCRIPTION_TIMEOUT_MS',
  EMBEDDING: 'AI_EMBEDDING_TIMEOUT_MS',
  RERANKER: 'AI_RAG_NEURAL_RERANK_TIMEOUT_MS',
};

const MAX_COMPLETION_TOKENS_BY_ROLE: Record<
  AiCompletionRole,
  { key: string; fallback: number }
> = {
  ROUTER: { key: 'AI_ROUTER_MAX_TOKENS', fallback: 2_048 },
  RETRIEVAL_PLANNER: {
    key: 'AI_RETRIEVAL_PLANNER_MAX_TOKENS',
    fallback: 512,
  },
  RETRIEVAL_TOOL: { key: 'AI_RETRIEVAL_TOOL_MAX_TOKENS', fallback: 500 },
  CONTEXT_SUFFICIENCY: {
    key: 'AI_CONTEXT_SUFFICIENCY_MAX_TOKENS',
    fallback: 512,
  },
  ANSWER: { key: 'AI_ANSWER_MAX_TOKENS', fallback: 1_536 },
  ANSWER_REVISION: {
    key: 'AI_ANSWER_REVISION_MAX_TOKENS',
    fallback: 768,
  },
  VERIFIER: { key: 'AI_VERIFIER_MAX_TOKENS', fallback: 1_024 },
  VERIFIER_ESCALATION: {
    key: 'AI_VERIFIER_ESCALATION_MAX_TOKENS',
    fallback: 1_024,
  },
  CITATION_ATTRIBUTION: {
    key: 'AI_CITATION_MAX_TOKENS',
    fallback: 768,
  },
  INDEX_QUALITY: { key: 'AI_INDEX_QUALITY_MAX_TOKENS', fallback: 768 },
  METADATA_EXTRACTION: {
    key: 'AI_METADATA_EXTRACTION_MAX_TOKENS',
    fallback: 512,
  },
  SECTION_SUMMARY: { key: 'AI_SECTION_SUMMARY_MAX_TOKENS', fallback: 512 },
  CONVERSATION_SUMMARY: {
    key: 'GROQ_MEMORY_MAX_TOKENS',
    fallback: 650,
  },
  MEMORY_EXTRACTION: {
    key: 'GROQ_MEMORY_EXTRACTION_MAX_TOKENS',
    fallback: 350,
  },
};

@Injectable()
export class AiApplicationConfigAdapter
  implements IAiApplicationConfig, OnModuleInit
{
  constructor(private readonly config: ConfigService) {}

  get<T = string>(key: string): T | undefined {
    return this.config.get<T>(key);
  }

  onModuleInit(): void {
    if (this.config.get<string>('NODE_ENV') !== 'production') return;

    for (const role of Object.keys(MODEL_ENV_BY_ROLE) as AiModelRole[]) {
      this.model(role);
    }
    this.number('AI_EMBEDDING_DIMENSIONS', 0, 1, 4_096);
    for (const role of Object.keys(
      MAX_COMPLETION_TOKENS_BY_ROLE,
    ) as AiCompletionRole[]) {
      this.maxCompletionTokens(role);
    }
    this.required('AI_EMBEDDING_VERSION');
  }

  model(role: AiModelRole): string {
    return this.required(MODEL_ENV_BY_ROLE[role]);
  }

  timeoutMs(role: AiModelRole): number {
    const key = TIMEOUT_ENV_BY_ROLE[role];
    return key ? Math.round(this.number(key, 8_000, 500, 120_000)) : 8_000;
  }

  maxCompletionTokens(role: AiCompletionRole): number {
    const { key, fallback } = MAX_COMPLETION_TOKENS_BY_ROLE[role];
    return Math.round(this.number(key, fallback, 128, 4_096));
  }

  boolean(key: string, fallback: boolean): boolean {
    const value = this.config.get<string>(key)?.trim().toLowerCase();
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
  }

  number(key: string, fallback: number, min: number, max: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    if (!Number.isFinite(value) || value < min || value > max) {
      throw new Error(
        `Invalid ${key}; expected a finite number between ${min} and ${max}`,
      );
    }
    return value;
  }

  private required(key: string): string {
    const value = this.config.get<string>(key)?.trim();
    if (!value) throw new Error(`Missing required AI configuration: ${key}`);
    return value;
  }
}
