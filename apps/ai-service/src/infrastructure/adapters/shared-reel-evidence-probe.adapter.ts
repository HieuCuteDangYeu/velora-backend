import type { IAiApplicationConfig } from '@ai/domain/interfaces/ai-application-config.interface';
import type { IEvidenceAnswerCheck } from '@ai/domain/interfaces/evidence-answer-check.interface';
import type { IEmbeddingService } from '@ai/domain/interfaces/embedding.service.interface';
import type { IRerankerService } from '@ai/domain/interfaces/reranker.service.interface';
import type { IReelSemanticIndexService } from '@ai/domain/interfaces/reel-semantic-index.service.interface';
import type { ISharedReelEvidenceProbe } from '@ai/domain/interfaces/shared-reel-evidence-probe.interface';
import type { SemanticIndexSearchResult } from '@common/processing/interfaces/semantic-index.interface';
import { CloudflareStructuredLlmAdapter } from '@ai/infrastructure/adapters/cloudflare-structured-llm.adapter';
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
// disagree with the probe. Distance alone cannot keep out a general question that a video happens to discuss
// ("capital of Australia" against a Quebec history lecture, distance 0.482); the remote scope check does
// (remoteSaysAboutVideo).
const DEFAULT_MAX_DISTANCE = 0.55;
const MAX_REELS = 8;
// Opt-in second signal for the ambiguous band (see rerankerFindsRelevant): beyond this closest distance the
// reranker must also find an excerpt relevant before a question the router called off-topic is rerouted.
const DEFAULT_SOFT_DISTANCE = 0.45;
const DEFAULT_MIN_RERANK = 0.05;
// The calibration reranked the 6 closest excerpts; reranking only 3 refused a covered question again.
const MAX_RERANKED_HITS = 6;
const SCOPE_CHECK_TIMEOUT_MS = 10_000;
const SCOPE_CHECK_EXCERPT_CHARS = 400;
const SCOPE_CHECK_PROMPT =
  'You decide whether a chat question is about a specific video. You get the question and excerpts of that video\'s transcript (the closest matches to the question). Answer VIDEO when the question asks about something the video shows or discusses, even if it does not name the video ("this recipe", "the speaker", or a detail like an ingredient or an event), including when the excerpts only partly answer it. Answer GENERAL when it is a general-knowledge or unrelated question that would be asked the same way without this video, even if the video happens to touch the same topic.';

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
    @Optional()
    private readonly scopeModel?: CloudflareStructuredLlmAdapter,
    @Optional()
    @Inject('IEvidenceAnswerCheck')
    private readonly answerCheck?: IEvidenceAnswerCheck,
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
        limit:
          this.rerankEnabled() || this.scopeCheckEnabled()
            ? MAX_RERANKED_HITS
            : 3,
        candidateLimit: 24,
      });
      const maxDistance = this.maxDistance();
      const near = hits.filter(
        (hit) =>
          typeof hit.vectorDistance === 'number' &&
          hit.vectorDistance <= maxDistance,
      );
      if (near.length === 0) {
        // Just past the limit, only the scope check may reroute; the not-covered guard then asks whether the
        // excerpts answer the question (IEvidenceAnswerCheck), so an uncovered question is still refused there.
        const band = this.answerCheck?.rescueMaxDistance();
        const inBand = hits.some(
          (hit) =>
            typeof hit.vectorDistance === 'number' &&
            band !== undefined &&
            hit.vectorDistance <= band,
        );
        if (!inBand) return false;
        return (await this.remoteSaysAboutVideo(input.message, hits)) === true;
      }
      const aboutVideo = await this.remoteSaysAboutVideo(input.message, hits);
      if (aboutVideo !== undefined) return aboutVideo;
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
   * alone when the reranker is absent, errors, or returns no score. Opt-in (AI_ROUTER_EVIDENCE_PROBE_RERANK=true).
   * Live it kept 0 of 48 general questions from being rerouted on 8 videos (the Quebec lecture was 1 of 6 without
   * it), but it also refused covered questions: on the regular 32-row sample (2026-11-26) 2 of 15 detail questions
   * that had been answered in every earlier run got the scope refusal. Their closest excerpt holds the answer
   * ("half a teaspoon of sugar", distance 0.474; "televisión", 0.475) yet the cross-encoder scores it 0.032 and
   * 0.025, inside the range of general questions (up to 0.026), so no floor separates the two. Off by default.
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

  /**
   * Whether the question is about the shared video, asked of the large remote model with the closest excerpts. Distance
   * cannot tell a covered question the router missed from a general question the video happens to discuss, and the
   * cross-encoder could not either (covered 0.025-0.032 against general up to 0.026). Measured offline 2026-11-27 on
   * 62 covered detail questions and 48 general ones (6 questions x 8 videos): 61 of 61 covered questions within the
   * 0.55 limit answered VIDEO (the one GENERAL was at 0.556, outside it), 48 of 48 general questions GENERAL, including
   * the 3 within the limit. On while the remote model is enabled; AI_ROUTER_EVIDENCE_PROBE_SCOPE_CHECK=false turns it
   * off. Undefined (distance alone decides) when it is off, fails, times out or answers something else.
   */
  private async remoteSaysAboutVideo(
    message: string,
    hits: SemanticIndexSearchResult[],
  ): Promise<boolean | undefined> {
    if (!this.scopeModel || !this.scopeCheckEnabled()) return undefined;
    const excerpts = hits
      .slice(0, MAX_RERANKED_HITS)
      .map((hit) => (hit.evidenceText ?? hit.text ?? '').trim())
      .filter(Boolean);
    if (excerpts.length === 0) return undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      const verdict = await Promise.race([
        this.scopeModel.generateObject<{ about?: string }>({
          systemPrompt: SCOPE_CHECK_PROMPT,
          userPrompt: `Question: ${message}\n\nVideo excerpts:\n${excerpts
            .map(
              (text, index) =>
                `[${index + 1}] ${text.slice(0, SCOPE_CHECK_EXCERPT_CHARS)}`,
            )
            .join('\n')}`,
          jsonSchema: {
            type: 'object',
            properties: {
              about: { type: 'string', enum: ['VIDEO', 'GENERAL'] },
            },
            required: ['about'],
            additionalProperties: false,
          },
          temperature: 0,
          maxTokens: 20,
          modelRole: 'SCOPE_CHECK',
          schemaVersion: 'probe_scope_check_v1',
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('timed out')),
            SCOPE_CHECK_TIMEOUT_MS,
          );
        }),
      ]);
      const about = verdict?.about?.toUpperCase();
      this.logger.debug(`[EvidenceProbe] scope check: ${about ?? 'none'}`);
      if (about === 'VIDEO') return true;
      if (about === 'GENERAL') return false;
      return undefined;
    } catch (error: unknown) {
      this.logger.warn(
        `Shared reel evidence probe scope check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private scopeCheckEnabled(): boolean {
    return (
      this.scopeModel !== undefined &&
      this.config
        .get<string>('AI_CLOUDFLARE_LLM_ENABLED')
        ?.trim()
        .toLowerCase() === 'true' &&
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_SCOPE_CHECK') !==
        'false'
    );
  }

  private rerankEnabled(): boolean {
    return (
      this.reranker !== undefined &&
      this.config.get<string>('AI_ROUTER_EVIDENCE_PROBE_RERANK') === 'true'
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
