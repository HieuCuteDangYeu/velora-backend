import type {
  DeferredVisualAnalysisAttemptOutcome,
  IDeferredVisualAnalysisRepository,
} from '@indexing/domain/interfaces/deferred-visual-analysis.repository.interface';
import { PrismaService } from '@indexing/infrastructure/prisma/prisma.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class PrismaDeferredVisualAnalysisRepository implements IDeferredVisualAnalysisRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findReelsAwaitingVisualAnalysis(input: {
    limit: number;
    excludeReelIds: readonly string[];
    recentSince: Date;
    maxRecentAttempts: number;
  }): Promise<string[]> {
    const withScenes = await this.prisma.reelVisualScene.groupBy({
      by: ['reelId'],
      where: { isActive: true },
    });
    const skip = new Set([
      ...withScenes.map((row) => row.reelId),
      ...input.excludeReelIds,
    ]);
    const documents = await this.prisma.reelDocument.findMany({
      where: { isActive: true },
      select: { reelId: true },
      orderBy: { createdAt: 'asc' },
    });
    const candidates = [
      ...new Set(
        documents
          .map((document) => document.reelId)
          .filter((reelId) => !skip.has(reelId)),
      ),
    ];
    if (candidates.length === 0) return [];

    const recentAttempts = await this.prisma.indexingAttempt.groupBy({
      by: ['reelId'],
      where: {
        reelId: { in: candidates },
        createdAt: { gt: input.recentSince },
      },
      _count: { _all: true },
    });
    const attemptCount = new Map(
      recentAttempts.map((row) => [row.reelId, row._count._all]),
    );
    return candidates
      .filter(
        (reelId) => (attemptCount.get(reelId) ?? 0) < input.maxRecentAttempts,
      )
      .slice(0, input.limit);
  }

  async getAttemptOutcome(
    indexAttemptId: string,
  ): Promise<DeferredVisualAnalysisAttemptOutcome | null> {
    const attempt = await this.prisma.indexingAttempt.findUnique({
      where: { indexAttemptId },
      select: { status: true, lastError: true },
    });
    if (!attempt) return null;
    return {
      status: String(attempt.status),
      ...(attempt.lastError ? { lastError: attempt.lastError } : {}),
    };
  }
}
