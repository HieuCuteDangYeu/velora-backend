import type { UserMemory } from '@ai/domain/entities/user-memory.entity';
import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type {
  IUserMemoryRepository,
  UserMemoryUpsertInput,
} from '@ai/domain/interfaces/user-memory.repository.interface';
import type { ExtractedUserMemoryCandidate } from '@common/ai/interfaces/extract-user-memory.interface';
import type { UserMemoryType } from '@common/ai/interfaces/user-memory.interface';
import { ScreenRagMemoryUseCase } from '@ai/application/use-cases/screen-rag-memory.use-case';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

@Injectable()
export class UpsertUserMemoriesUseCase {
  private readonly logger = new Logger(UpsertUserMemoriesUseCase.name);

  private readonly minConfidence = 0.65;
  private readonly minContentLength = 16;
  private readonly minEvidenceLength = 4;

  private readonly allowedTypes = new Set<UserMemoryType>([
    'PREFERENCE',
    'PROFILE',
    'TECHNICAL_CONTEXT',
    'COMMUNICATION_STYLE',
    'OTHER',
  ]);

  constructor(
    @Inject('IAiApplicationConfig')
    private readonly configService: IAiApplicationConfig,

    @Inject('IUserMemoryRepository')
    private readonly userMemoryRepository: IUserMemoryRepository,

    @Inject('IEmbeddingService')
    private readonly embeddingService: IEmbeddingService,

    @Optional()
    private readonly screenRagMemoryUseCase?: ScreenRagMemoryUseCase,
  ) {}

  async execute(input: {
    userId: string;
    conversationId: string;
    userMessage: string;
    memories: ExtractedUserMemoryCandidate[];
  }) {
    // A message the guardrail would turn away must not seed memory either.
    if (this.screenRagMemoryUseCase?.blocks([input.userMessage], 'memory')) {
      return [];
    }

    const userMessageComparable = this.toComparable(input.userMessage);

    const uniqueMemories = new Map<
      string,
      {
        userId: string;
        type: UserMemoryType;
        content: string;
        normalizedContent: string;
        confidence: number;
        sourceConversationId: string;
      }
    >();

    for (const rawMemory of input.memories) {
      const memory = {
        ...rawMemory,
        content: this.sanitizeContent(rawMemory.content),
        evidence: this.sanitizeContent(rawMemory.evidence),
      };

      if (!this.isValidMemoryCandidate(memory, userMessageComparable)) {
        continue;
      }

      if (
        this.screenRagMemoryUseCase?.blocks(
          [memory.content, memory.evidence],
          'memory',
        )
      ) {
        continue;
      }

      const normalizedContent = this.normalize(memory.content);

      uniqueMemories.set(`${memory.type}:${normalizedContent}`, {
        userId: input.userId,
        type: memory.type,
        content: memory.content,
        normalizedContent,
        confidence: memory.confidence,
        sourceConversationId: input.conversationId,
      });
    }

    const validMemories = [...uniqueMemories.values()];

    if (validMemories.length === 0) {
      return [];
    }

    const results: UserMemory[] = [];

    for (const memory of validMemories) {
      const memoryWithEmbedding = await this.attachEmbedding(memory);
      const consolidated = await this.consolidateIfSimilar(memoryWithEmbedding);

      if (consolidated) {
        results.push(consolidated);
        continue;
      }

      results.push(
        ...(await this.userMemoryRepository.upsertMany([memoryWithEmbedding])),
      );
    }

    return results;
  }

  private async consolidateIfSimilar(memory: UserMemoryUpsertInput) {
    if (!memory.embedding?.length) {
      return null;
    }

    const semanticThreshold = this.getNumber(
      'AI_USER_MEMORY_DEDUPE_SEMANTIC_SCORE',
      0.94,
      0.75,
      1,
    );
    const lexicalThreshold = this.getNumber(
      'AI_USER_MEMORY_DEDUPE_LEXICAL_SCORE',
      0.55,
      0,
      1,
    );
    const candidates = await this.userMemoryRepository.findRelevantByUserId({
      userId: memory.userId,
      queryVector: memory.embedding,
      queryEmbeddingModel: memory.embeddingModel,
      queryEmbeddingVersion: memory.embeddingVersion,
      limit: 5,
      minScore: semanticThreshold,
      minConfidence: 0,
    });

    const similar = candidates.find(
      (candidate) =>
        candidate.id &&
        candidate.type === memory.type &&
        (this.lexicalSimilarity(
          candidate.normalizedContent,
          memory.normalizedContent,
        ) >= lexicalThreshold ||
          candidate.normalizedContent.includes(memory.normalizedContent) ||
          memory.normalizedContent.includes(candidate.normalizedContent)),
    );

    if (!similar?.id) {
      return null;
    }

    this.logger.debug(
      `[UserMemory] consolidating semantically similar memory id=${similar.id} type=${memory.type} score=${similar.semanticScore?.toFixed(3) ?? 'n/a'}`,
    );

    return await this.userMemoryRepository.replaceSimilar(similar.id, memory);
  }

  private async attachEmbedding(
    memory: Omit<
      UserMemoryUpsertInput,
      | 'embedding'
      | 'embeddingModel'
      | 'embeddingDimensions'
      | 'embeddingVersion'
    >,
  ): Promise<UserMemoryUpsertInput> {
    if (!this.getBoolean('AI_USER_MEMORY_EMBEDDINGS_ENABLED', true)) {
      return memory;
    }

    try {
      const embedding = await this.embeddingService.generateVector({
        text: this.buildMemoryEmbeddingText(memory),
        taskType: 'RETRIEVAL_DOCUMENT',
        title: 'User memory',
      });

      const expectedDimensions =
        await this.userMemoryRepository.getEmbeddingDimensions();

      if (embedding.dimensions !== expectedDimensions) {
        this.logger.warn(
          `[UserMemory] skipped embedding because dimensions=${embedding.dimensions}, expected=${expectedDimensions}`,
        );

        return memory;
      }

      return {
        ...memory,
        embedding: embedding.values,
        embeddingModel: embedding.model,
        embeddingDimensions: embedding.dimensions,
        embeddingVersion: this.getEmbeddingVersion(),
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.warn(
        `[UserMemory] embedding failed for type=${memory.type}: ${message}`,
      );

      return memory;
    }
  }

  private buildMemoryEmbeddingText(input: {
    type: UserMemoryType;
    content: string;
  }): string {
    return [
      `Memory type: ${input.type}`,
      `Memory content: ${input.content.trim()}`,
    ].join('\n');
  }

  private isValidMemoryCandidate(
    memory: ExtractedUserMemoryCandidate,
    userMessageComparable: string,
  ): boolean {
    if (!this.allowedTypes.has(memory.type)) {
      this.logger.debug(
        `[UserMemory] rejected invalid type=${String(memory.type)}`,
      );
      return false;
    }

    if (memory.scope !== 'LONG_TERM') {
      return false;
    }

    if (memory.confidence < this.minConfidence) {
      return false;
    }

    if (memory.content.length < this.minContentLength) {
      return false;
    }

    if (memory.evidence.length < this.minEvidenceLength) {
      return false;
    }

    if (!userMessageComparable.includes(this.toComparable(memory.evidence))) {
      this.logger.debug(
        `[UserMemory] rejected memory without user evidence="${memory.content}"`,
      );
      return false;
    }

    return true;
  }

  private lexicalSimilarity(left: string, right: string): number {
    const leftTokens = this.tokens(left);
    const rightTokens = this.tokens(right);
    if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

    let intersection = 0;
    for (const token of leftTokens) {
      if (rightTokens.has(token)) intersection += 1;
    }

    const union = leftTokens.size + rightTokens.size - intersection;
    return union > 0 ? intersection / union : 0;
  }

  private tokens(value: string): Set<string> {
    return new Set(
      this.toComparable(value)
        .split(' ')
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    );
  }

  private sanitizeContent(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private normalize(value: string): string {
    return value.toLowerCase().replace(/\s+/g, ' ').trim();
  }

  private toComparable(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private getEmbeddingVersion(): string {
    const value = this.configService
      .get<string>('AI_EMBEDDING_VERSION')
      ?.trim();
    if (!value) throw new Error('Missing required AI_EMBEDDING_VERSION');
    return value;
  }

  private getBoolean(key: string, fallback: boolean): boolean {
    const value = this.configService.get<string>(key);

    if (value === undefined) {
      return fallback;
    }

    return value.toLowerCase() === 'true';
  }

  private getNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(value)
      ? Math.min(max, Math.max(min, value))
      : fallback;
  }
}
