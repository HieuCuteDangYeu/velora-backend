import type { TranscriptMatch } from '@ai/domain/interfaces/content-service.interface';
import type {
  RagChatRouteDecision,
  RagRequiredEvidence,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IRetrievalEngine } from '@ai/domain/interfaces/retrieval-engine.interface';
import { transcriptSegmentRequestKind } from '@ai/domain/services/rag-prompt-bounds';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class RerankRetrievedEvidenceUseCase {
  constructor(
    @Inject('IRetrievalEngine')
    private readonly retrievalEngine: IRetrievalEngine,
  ) {}

  async execute(input: {
    userMessage: string;
    route: RagChatRouteDecision;
    plan: RagRetrievalPlan;
    retrievedChunks: TranscriptMatch[];
    requiredEvidence?: RagRequiredEvidence[];
    diagnostics?: RagRetrievalExecutionDiagnostics;
  }): Promise<TranscriptMatch[]> {
    if (input.diagnostics) {
      input.diagnostics.retrievedCount = input.retrievedChunks.length;
    }
    try {
      const reranked = await this.retrievalEngine.rerank({
        plan: input.plan,
        retrievedChunks: input.retrievedChunks,
        requiredEvidence: input.requiredEvidence,
        diagnostics: input.diagnostics,
      });
      const requestKind = transcriptSegmentRequestKind(
        input.userMessage,
        input.route,
        input.plan,
      );
      const startTime =
        input.plan.transcriptTimestampSec ?? input.plan.sourceTimestampSec;
      const endTime =
        input.plan.transcriptTimestampEndSec ??
        input.plan.sourceTimestampEndSec;
      const result =
        requestKind === 'MULTI_REEL_COMPARISON'
          ? firstTranscriptSegmentPerReel(reranked)
          : requestKind === 'SUMMARY' &&
              typeof startTime === 'number' &&
              typeof endTime === 'number'
            ? transcriptChunksInWindow(reranked, startTime, endTime)
            : reranked;
      if (input.diagnostics) input.diagnostics.rerankedCount = result.length;
      return result;
    } catch (error: unknown) {
      if (input.diagnostics && !input.diagnostics.failedStage) {
        input.diagnostics.failedStage = 'RERANK';
        input.diagnostics.errorName =
          error instanceof Error ? error.name : 'UnknownError';
        if (error && typeof error === 'object') {
          const record = error as Record<string, unknown>;
          if (typeof record.code === 'string')
            input.diagnostics.errorCode = record.code;
          if (typeof record.providerCategory === 'string')
            input.diagnostics.providerCategory =
              record.providerCategory as NonNullable<
                RagRetrievalExecutionDiagnostics['providerCategory']
              >;
        }
      }
      throw error;
    }
  }
}

function firstTranscriptSegmentPerReel(
  candidates: TranscriptMatch[],
): TranscriptMatch[] {
  const earliestByReel = new Map<string, TranscriptMatch>();
  for (const candidate of candidates) {
    if ((candidate.evidenceType ?? 'TRANSCRIPT') !== 'TRANSCRIPT') continue;
    const current = earliestByReel.get(candidate.reelId);
    if (
      !current ||
      (candidate.startTime ?? Infinity) < (current.startTime ?? Infinity)
    ) {
      earliestByReel.set(candidate.reelId, candidate);
    }
  }
  return candidates.filter(
    (candidate) =>
      (candidate.evidenceType ?? 'TRANSCRIPT') !== 'TRANSCRIPT' ||
      earliestByReel.get(candidate.reelId) === candidate,
  );
}

function transcriptChunksInWindow(
  candidates: TranscriptMatch[],
  startTime: number,
  endTime: number,
): TranscriptMatch[] {
  const byReel = new Map<string, TranscriptMatch[]>();
  for (const candidate of candidates) {
    if ((candidate.evidenceType ?? 'TRANSCRIPT') !== 'TRANSCRIPT') continue;
    const chunks = byReel.get(candidate.reelId) ?? [];
    chunks.push(candidate);
    byReel.set(candidate.reelId, chunks);
  }
  const selected = new Set<TranscriptMatch>();
  for (const chunks of byReel.values()) {
    const exact = chunks.filter(
      (chunk) => chunk.startTime === startTime && chunk.endTime === endTime,
    );
    const relevant = exact.length
      ? exact
      : chunks.filter(
          (chunk) =>
            typeof chunk.startTime !== 'number' ||
            typeof chunk.endTime !== 'number' ||
            (chunk.startTime <= endTime && chunk.endTime >= startTime),
        );
    relevant.forEach((chunk) => selected.add(chunk));
  }
  return candidates.filter(
    (candidate) =>
      (candidate.evidenceType ?? 'TRANSCRIPT') !== 'TRANSCRIPT' ||
      selected.has(candidate),
  );
}
