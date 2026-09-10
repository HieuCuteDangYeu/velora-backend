import type { ReelContextSearchResult } from '@common/content/interfaces/reel-context-search-result.interface';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ScoredRerankCandidate } from './hybrid-retrieval-scorer';

interface CandidateWithTokens extends ScoredRerankCandidate {
  tokens: Set<string>;
}

const MAX_COMPLEMENTARY_OVERLAP_RATIO = 0.25;

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
    let complementaryWindowAdded = false;

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

      // Adjacent transcript windows often split one fact across an overlap.
      // Preserve one such complementary window before MMR trades it for a
      // different reel, while retaining the requested result limit.
      if (
        selected.length === 1 &&
        selected.length < limit &&
        !complementaryWindowAdded
      ) {
        const companionIndex = this.findComplementaryWindow(remaining, chosen);
        if (companionIndex >= 0) {
          const [companion] = remaining.splice(companionIndex, 1);
          selected.push(companion);
          complementaryWindowAdded = true;
        }
      }
    }

    return selected.map(({ candidate, relevanceScore }) => ({
      ...candidate,
      rerankScore: relevanceScore,
    }));
  }

  private findComplementaryWindow(
    remaining: CandidateWithTokens[],
    primary: CandidateWithTokens,
  ): number {
    let bestIndex = -1;
    let bestRelevance = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < remaining.length; index += 1) {
      const item = remaining[index];
      if (
        !this.isComplementaryTemporalEvidence(item.candidate, primary.candidate)
      ) {
        continue;
      }
      if (item.relevanceScore > bestRelevance) {
        bestIndex = index;
        bestRelevance = item.relevanceScore;
      }
    }

    return bestIndex;
  }

  private isComplementaryTemporalEvidence(
    left: ReelContextSearchResult,
    right: ReelContextSearchResult,
  ): boolean {
    if (left.reelId !== right.reelId) return false;
    if (
      (left.evidenceType ?? 'TRANSCRIPT') !==
      (right.evidenceType ?? 'TRANSCRIPT')
    ) {
      return false;
    }
    if (!this.hasValidWindow(left) || !this.hasValidWindow(right)) {
      return false;
    }

    const leftDuration = left.endTime - left.startTime;
    const rightDuration = right.endTime - right.startTime;
    const unionStart = Math.min(left.startTime, right.startTime);
    const unionEnd = Math.max(left.endTime, right.endTime);
    const unionDuration = unionEnd - unionStart;
    const intersection = Math.max(
      0,
      Math.min(left.endTime, right.endTime) -
        Math.max(left.startTime, right.startTime),
    );
    const overlapRatio = unionDuration > 0 ? intersection / unionDuration : 1;

    return (
      unionDuration > Math.max(leftDuration, rightDuration) &&
      overlapRatio <= MAX_COMPLEMENTARY_OVERLAP_RATIO &&
      (left.startTime < right.startTime || left.endTime > right.endTime)
    );
  }

  private hasValidWindow(
    candidate: ReelContextSearchResult,
  ): candidate is ReelContextSearchResult & {
    startTime: number;
    endTime: number;
  } {
    return (
      typeof candidate.startTime === 'number' &&
      Number.isFinite(candidate.startTime) &&
      typeof candidate.endTime === 'number' &&
      Number.isFinite(candidate.endTime) &&
      candidate.endTime > candidate.startTime
    );
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
