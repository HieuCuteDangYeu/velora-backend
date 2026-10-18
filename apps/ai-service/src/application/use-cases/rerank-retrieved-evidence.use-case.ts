import type { TranscriptMatch } from '@ai/domain/interfaces/content-service.interface';
import type {
  RagRequiredEvidence,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import type { IRetrievalEngine } from '@ai/domain/interfaces/retrieval-engine.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class RerankRetrievedEvidenceUseCase {
  constructor(
    @Inject('IRetrievalEngine')
    private readonly retrievalEngine: IRetrievalEngine,
  ) {}

  async execute(input: {
    plan: RagRetrievalPlan;
    retrievedChunks: TranscriptMatch[];
    requiredEvidence?: RagRequiredEvidence[];
    diagnostics?: RagRetrievalExecutionDiagnostics;
  }): Promise<TranscriptMatch[]> {
    if (input.diagnostics) {
      input.diagnostics.retrievedCount = input.retrievedChunks.length;
    }
    try {
      const reranked = await this.retrievalEngine.rerank(input);
      if (input.diagnostics) input.diagnostics.rerankedCount = reranked.length;
      return reranked;
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
