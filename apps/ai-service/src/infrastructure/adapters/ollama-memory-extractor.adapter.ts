import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IMemoryExtractorService } from '@ai/domain/interfaces/memory-extractor.service.interface';
import type {
  ExtractUserMemoriesRequest,
  ExtractUserMemoriesResult,
} from '@common/ai/interfaces/extract-user-memory.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { buildUserMemoryExtractionPrompt } from './llm/user-memory-extraction.prompt';
import { parseUserMemoryExtractionResult } from './llm/user-memory-extraction.parser';
import { OllamaTextClient } from './ollama-text.client';

@Injectable()
export class OllamaMemoryExtractorAdapter implements IMemoryExtractorService {
  private readonly logger = new Logger(OllamaMemoryExtractorAdapter.name);

  constructor(
    private readonly config: ConfigService,
    private readonly textClient: OllamaTextClient,
    @Inject('IAiApplicationConfig')
    private readonly applicationConfig: IAiApplicationConfig,
  ) {}

  async extract(
    input: ExtractUserMemoriesRequest,
  ): Promise<ExtractUserMemoriesResult> {
    try {
      const text = await this.textClient.generateText({
        prompt: buildUserMemoryExtractionPrompt(input),
        model: this.config.getOrThrow<string>('AI_MEMORY_EXTRACTION_MODEL'),
        maxTokens:
          this.applicationConfig.maxCompletionTokens('MEMORY_EXTRACTION'),
        temperature: this.number('OLLAMA_MEMORY_TEMPERATURE', 0.1),
      });
      return parseUserMemoryExtractionResult(text);
    } catch (error: unknown) {
      this.logger.warn(
        `Ollama memory extraction failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { memories: [] };
    }
  }

  private number(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
  }
}
