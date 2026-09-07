import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';

interface CandidateWithTokens extends ScoredRerankCandidate {
  tokens: Set<string>;
}

@Injectable()
export class EvidenceDiversitySelector {
  constructor(private readonly configService: ConfigService) {}

  select(
    candidates: ScoredRerankCandidate[],
    requestedLimit: number,
  ): ReelContextSearchResult[] {
    const limit = Math.min(
      Math.max(requestedLimit, 1),
      this.getInteger('AI_RAG_RERANK_MAX_LIMIT', 8, 1, 20),
    );
    const lambda = this.getNumber('AI_RAG_MMR_LAMBDA', 0.74, 0, 1);
    const sameReelPenalty = this.getNumber(
      'AI_RAG_MMR_SAME_REEL_PENALTY',
      0.22,
      0,
      1,
    );
    const temporalOverlapPenalty = this.getNumber(
      'AI_RAG_MMR_TEMPORAL_OVERLAP_PENALTY',
      0.7,
      0,
      1,
    );
    const remaining = candidates.map((item) => ({
      ...item,
      tokens: this.tokenize(this.context(item.candidate)),
    }));
    const selected: CandidateWithTokens[] = [];

    while (remaining.length > 0 && selected.length < limit) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;

      for (let index = 0; index < remaining.length; index += 1) {
        const item = remaining[index];
        const diversityPenalty = this.calculateDiversityPenalty(
          item,
          selected,
          sameReelPenalty,
          temporalOverlapPenalty,
        );
        const mmrScore =
          selected.length === 0
            ? item.relevanceScore
            : lambda * item.relevanceScore - (1 - lambda) * diversityPenalty;

        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = index;
        }
      }

      const [chosen] = remaining.splice(bestIndex, 1);
      selected.push(chosen);
    }

    return selected.map(({ candidate, relevanceScore }) => ({
      ...candidate,
      rerankScore: relevanceScore,
    }));
  }

  private context(candidate: ReelContextSearchResult): string {
    return [
      candidate.title,
      candidate.description,
      candidate.tags.join(' '),
      candidate.evidenceText?.trim() ||
        candidate.retrievalText?.trim() ||
        candidate.chunkText.trim(),
    ]
      .filter(Boolean)
      .join(' ');
  }

  private calculateDiversityPenalty(
    candidate: CandidateWithTokens,
    selected: CandidateWithTokens[],
    sameReelPenalty: number,
    temporalOverlapPenalty: number,
  ): number {
    let maxPenalty = 0;
    for (const selectedItem of selected) {
      const textSimilarity = this.jaccard(
        candidate.tokens,
        selectedItem.tokens,
      );
      const sameReel =
        candidate.candidate.reelId === selectedItem.candidate.reelId;
      const temporalPenalty = sameReel
        ? this.temporalOverlap(candidate.candidate, selectedItem.candidate) *
          temporalOverlapPenalty
        : 0;
      maxPenalty = Math.max(
        maxPenalty,
        textSimilarity,
        sameReel ? sameReelPenalty : 0,
        temporalPenalty,
      );
    }
    return maxPenalty;
  }

  private temporalOverlap(
    left: ReelContextSearchResult,
    right: ReelContextSearchResult,
  ): number {
    if (
      typeof left.startTime !== 'number' ||
      typeof left.endTime !== 'number' ||
      typeof right.startTime !== 'number' ||
      typeof right.endTime !== 'number'
    ) {
      return 0;
    }
    const intersection = Math.max(
      0,
      Math.min(left.endTime, right.endTime) -
        Math.max(left.startTime, right.startTime),
    );
    const union =
      Math.max(left.endTime, right.endTime) -
      Math.min(left.startTime, right.startTime);
    return union > 0 ? intersection / union : 0;
  }

  private jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 || right.size === 0) return 0;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    const union = left.size + right.size - intersection;
    return union <= 0 ? 0 : intersection / union;
  }

  private normalize(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s.#_-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private tokenize(value: string): Set<string> {
    return new Set(
      this.normalize(value)
        .split(' ')
        .map((term) => term.replace(/^#/, '').trim())
        .filter((term) => term.length >= 2),
    );
  }

  private getNumber(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    const value = Number(this.configService.get<string>(key) ?? fallback);
    return Number.isFinite(value)
      ? Math.min(Math.max(value, min), max)
      : fallback;
  }

  private getInteger(
    key: string,
    fallback: number,
    min: number,
    max: number,
  ): number {
    return Math.round(this.getNumber(key, fallback, min, max));
  }
}
