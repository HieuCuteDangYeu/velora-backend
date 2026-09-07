import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type {
  GenerateEmbeddingRequest,
  GenerateEmbeddingResult,
} from '@common/ai/interfaces/generate-embedding.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TeiEmbeddingAdapter implements IEmbeddingService {
  constructor(private readonly config: ConfigService) {}

  async generateVector(
    input: GenerateEmbeddingRequest,
  ): Promise<GenerateEmbeddingResult> {
    const text = input.text.trim();
    if (!text) throw new Error('Embedding input text cannot be empty');
    const dimensions = this.dimensions();
    const response = await this.fetchEmbedding(text);
    const values = this.extractVector(response);
    if (
      values.length !== dimensions ||
      values.some((value) => !Number.isFinite(value))
    )
      throw new Error(`TEI embedding must return ${dimensions} finite values`);
    const normalized = this.normalize(values);
    return {
      values: normalized,
      model:
        this.config.get<string>('TEI_EMBEDDING_MODEL')?.trim() || 'BAAI/bge-m3',
      dimensions,
      provider: 'self-hosted-tei',
      version:
        this.config.get<string>('AI_EMBEDDING_VERSION')?.trim() ||
        'bge-m3-tei-v1',
    };
  }

  countTokens(_model: string, text: string): Promise<number> {
    const normalized = text.normalize('NFKC').trim();
    if (!normalized) throw new Error('Token counting requires non-empty text');
    return Promise.resolve(
      (normalized.match(/[\p{L}\p{N}]+|[^\s]/gu) ?? []).length,
    );
  }

  private async fetchEmbedding(text: string): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.positiveInt('AI_EMBEDDING_TIMEOUT_MS', 120_000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      const response = await fetch(`${this.baseUrl()}/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inputs: [text],
          normalize: true,
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok)
        throw new Error(
          `TEI embedding failed with status ${response.status}: ${raw.slice(0, 500)}`,
        );
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        throw new Error('TEI embedding returned invalid JSON');
      }
    } finally {
      clearTimeout(timer);
    }
  }

  private extractVector(payload: unknown): number[] {
    const value =
      Array.isArray(payload) && Array.isArray(payload[0])
        ? payload[0]
        : payload;
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'number'))
      throw new Error('TEI embedding returned an invalid vector');
    return value as number[];
  }

  private normalize(values: number[]): number[] {
    const norm = Math.sqrt(
      values.reduce((sum, value) => sum + value * value, 0),
    );
    if (!Number.isFinite(norm) || norm <= 0)
      throw new Error('TEI embedding vector has invalid magnitude');
    return values.map((value) => value / norm);
  }

  private baseUrl(): string {
    const value = this.config.get<string>('TEI_EMBEDDING_BASE_URL')?.trim();
    if (!value)
      throw new Error(
        'Missing required AI configuration: TEI_EMBEDDING_BASE_URL',
      );
    return value.replace(/\/+$/, '');
  }

  private dimensions(): number {
    const value = Number(
      this.config.get<string>('AI_EMBEDDING_DIMENSIONS') ?? 1024,
    );
    if (!Number.isInteger(value) || value !== 1024)
      throw new Error('AI_EMBEDDING_DIMENSIONS must remain 1024 for BGE-M3');
    return value;
  }

  private positiveInt(key: string, fallback: number): number {
    const value = Number(this.config.get<string>(key) ?? fallback);
    return Number.isInteger(value) && value > 0
      ? Math.min(value, 600_000)
      : fallback;
  }
}
