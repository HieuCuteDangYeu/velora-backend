import type { TranscriptMatch } from '@ai/domain/interfaces/content-service.interface';
import type {
  RagChatRouteDecision,
  RagRequiredEvidence,
  RagRetrievalExecutionDiagnostics,
  RagRetrievalPlan,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';

export interface IRetrievalEngine {
  plan(input: {
    message: string;
    route: RagChatRouteDecision;
  }): Promise<RagRetrievalPlan>;

  retrieve(input: {
    userId: string;
    conversationId: string;
    route: RagChatRouteDecision;
    plan: RagRetrievalPlan;
    accessibleReelIds?: string[];
    diagnostics?: RagRetrievalExecutionDiagnostics;
  }): Promise<TranscriptMatch[]>;

  rerank(input: {
    plan: RagRetrievalPlan;
    retrievedChunks: TranscriptMatch[];
    requiredEvidence?: RagRequiredEvidence[];
    diagnostics?: RagRetrievalExecutionDiagnostics;
  }): Promise<TranscriptMatch[]>;
}
