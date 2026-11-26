import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { IReelSemanticIndexService } from '@ai/domain/interfaces/reel-semantic-index.service.interface';
import type { ISharedReelEvidenceProbe } from '@ai/domain/interfaces/shared-reel-evidence-probe.interface';
import type { SemanticIndexSearchResult } from '@common/processing/interfaces/semantic-index.interface';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

// Calibrated 2026-11-24 on 60 English detail questions, each searched inside its own video and inside an
// unrelated one: the closest chunk of the own video is within 0.42 for 75% of questions, 0.48 for 93% and
// 0.50 for 97%; an unrelated video is within 0.42 for 2%, 0.48 for 2% and 0.50 for 3% (its median is 0.62).
// Re-measured 2026-11-25 on 55 non-English detail questions (vi, es, ar, ko, fr): own video within 0.48 for
// 89%, 0.50 for 95%, 0.55 for 100% (median 0.40); an unrelated video within 0.55 for 0%. A French question
// whose best chunk sat at 0.496 was turned away as off-topic at 0.48, so the limit became 0.50. Re-measured
// 2026-11-26 on 72 French and Korean questions over 6 videos: all 48 answered detail questions sit at or below
// 0.496, and the 6 questions wrongly turned away as off-topic sit at 0.52-0.57 (5 of them were answered once the
// limit was 0.55). 0.55 is also the limit of the not-covered guard (CheckContextSufficiencyUseCase), which must not
// disagree with the probe. Known exposure at any limit above 0.48: a general question that a video happens to
// discuss ("capital of Australia" against a Quebec history lecture, distance 0.482) is answered from the video.
const DEFAULT_MAX_DISTANCE = 0.55;
const MAX_REELS = 8;
// Opt-in second signal for the ambiguous band (see rerankerFindsRelevant): beyond this closest distance the
// reranker must also find an excerpt relevant before a question the router called off-topic is rerouted.
const DEFAULT_SOFT_DISTANCE = 0.45;
const DEFAULT_MIN_RERANK = 0.05;
// The calibration reranked the 6 closest excerpts; reranking only 3 refused a covered question again.
const MAX_RERANKED_HITS = 6;

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
    @Optional()
    @Inject('IRerankerService')
    private readonly reranker?: IRerankerService,
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
        limit: this.rerankEnabled() ? MAX_RERANKED_HITS : 3,
        candidateLimit: 24,
      });
      const maxDistance = this.maxDistance();
      const near = hits.filter(
        (hit) =>
          typeof hit.vectorDistance === 'number' &&
          hit.vectorDistance <= maxDistance,
      );
      if (near.length === 0) return false;
      const closest = Math.min(...near.map((hit) => hit.vectorDistance ?? 1));
      if (closest <= this.softDistance()) return true;
      return await this.rerankerFindsRelevant(input.message, hits);
    } catch (error: unknown) {
      // The probe only widens routing; when it cannot answer, the router's own verdict stands.
      this.logger.warn(
        `Shared reel evidence probe failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  /**
   * A question the router called off-topic is rerouted to the shared video when its closest excerpt is near. Near
   * is ambiguous between 0.45 and 0.55: covered questions in a transcript that retrieves poorly sit there, and so
   * do general questions a video happens to discuss ("capital of Australia" against a Quebec history lecture,
   * distance 0.482). The cross-encoder tells them apart: covered ones scored 0.135-0.97 (the six measured
   * 2026-11-26), general ones 0.003 median and 0.026 at most among those in range. Fails open to the distance
   * alone when the reranker is absent, errors, or returns no score. On by default; AI_ROUTER_EVIDENCE_PROBE_RERANK=false
   * turns it off. Verified live: 0 of 48 general questions rerouted on 8 videos (the Quebec lecture was 1 of 6 without
   * it) and all five rescued covered questions still answered.
   * It must see every returned hit, not only those within the distance limit: for the Quebec songwriters question
   * the excerpt that answers it (rerank 0.34) sits at vector distance 0.575, the two hits inside 0.55 score 0.005
   * and 0.027, and reranking only the near hits refused a covered question that the calibration (best score over all
   * six hits) had rescued.
   */
  private async rerankerFindsRelevant(
    message: string,
    hits: SemanticIndexSearchResult[],
  ): Promise<boolean> {
    if (!this.reranker || !this.rerankEnabled()) {
      return true;
    }
    const floor = Number(
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_MIN_RERANK') ??
        DEFAULT_MIN_RERANK,
    );
    if (!Number.isFinite(floor) || floor <= 0) return true;
    try {
      const candidates = hits.slice(0, MAX_RERANKED_HITS).map((hit) => {
        const text = hit.evidenceText ?? hit.text ?? '';
        return {
          chunkId: hit.id,
          reelId: hit.reelId,
          tags: [],
          chunkText: text,
          evidenceText: text,
          evidenceType: 'TRANSCRIPT' as const,
          distance:
            typeof hit.vectorDistance === 'number' ? hit.vectorDistance : null,
        };
      });
      const ranked = await this.reranker.rerank({
        queryText: message,
        candidates,
        limit: candidates.length,
      });
      const scores = ranked
        .map((candidate) => candidate.rerankScore)
        .filter((score): score is number => typeof score === 'number');
      if (scores.length === 0) return true;
      return Math.max(...scores) >= floor;
    } catch (error: unknown) {
      this.logger.warn(
        `Shared reel evidence probe reranker failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return true;
    }
  }

  private rerankEnabled(): boolean {
    return (
      this.reranker !== undefined &&
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_RERANK') !== 'false'
    );
  }

  private softDistance(): number {
    const value = Number(
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_SOFT_DISTANCE') ??
        DEFAULT_SOFT_DISTANCE,
    );
    return Number.isFinite(value) && value > 0 && value <= 2
      ? value
      : DEFAULT_SOFT_DISTANCE;
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
