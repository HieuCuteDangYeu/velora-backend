import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type { IReelSemanticIndexService } from '@ai/domain/interfaces/reel-semantic-index.service.interface';
import type { ISharedReelEvidenceProbe } from '@ai/domain/interfaces/shared-reel-evidence-probe.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';

// Calibrated 2026-11-24 on 60 English detail questions, each searched inside its own video and inside an
// unrelated one: the closest chunk of the own video is within 0.42 for 75% of questions, 0.48 for 93% and
// 0.50 for 97%; an unrelated video is within 0.42 for 2%, 0.48 for 2% and 0.50 for 3% (its median is 0.62).
const DEFAULT_MAX_DISTANCE = 0.48;
const MAX_REELS = 8;

@Injectable()
export class SharedReelEvidenceProbeAdapter implements ISharedReelEvidenceProbe {
  private readonly logger = new Logger(SharedReelEvidenceProbeAdapter.name);

  constructor(
    @Inject('IEmbeddingService')
    private readonly embeddingService: IEmbeddingService,
    @Inject('IReelSemanticIndexService')
    private readonly semanticIndex: IReelSemanticIndexService,
    @Inject('IAiApplicationConfig')
    private readonly config: IAiApplicationConfig,
  ) {}

  async hasStrongEvidence(input: {
    message: string;
    accessibleReelIds: string[];
  }): Promise<boolean> {
    const reelIds = [...new Set(input.accessibleReelIds)].slice(0, MAX_REELS);
    if (!input.message.trim() || reelIds.length === 0) return false;
    try {
      const embedding = await this.embeddingService.generateVector({
        text: input.message,
        taskType: 'RETRIEVAL_QUERY',
      });
      const hits = await this.semanticIndex.searchChunks({
        queryText: input.message,
        queryEmbedding: embedding.values,
        queryEmbeddingModel: embedding.model,
        queryEmbeddingVersion: embedding.version,
        filters: { reelIds },
        limit: 3,
        candidateLimit: 24,
      });
      const maxDistance = this.maxDistance();
      return hits.some(
        (hit) =>
          typeof hit.vectorDistance === 'number' &&
          hit.vectorDistance <= maxDistance,
      );
    } catch (error: unknown) {
      // The probe only widens routing; when it cannot answer, the router's own verdict stands.
      this.logger.warn(
        `Shared reel evidence probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private maxDistance(): number {
    const value = Number(
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_MAX_DISTANCE') ??
        DEFAULT_MAX_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_MAX_DISTANCE;
  }
}
