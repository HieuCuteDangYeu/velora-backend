import type {
  RagChatWorkflowState,
  RagRequiredEvidence,
} from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CreateNoContextAnswerUseCase {
  execute(state: RagChatWorkflowState): string {
    return this.buildAnswer(state);
  }

  private buildAnswer(state: RagChatWorkflowState): string {
    const userFacingReason = state.contextSufficiency?.userFacingReason?.trim();

    if (userFacingReason) {
      return userFacingReason;
    }

    const missingEvidence = state.contextSufficiency?.missingEvidence ?? [];
    const missingReelIds = state.contextSufficiency?.missingReelIds ?? [];

    if (missingReelIds.length > 0) {
      return 'I found evidence from only part of the requested Reel comparison, so I cannot compare them reliably.';
    }

    if (missingEvidence.length > 0) {
      return this.renderMissingEvidenceAnswer(missingEvidence);
    }

    if (state.route?.intent === 'REEL_VIDEO_QUESTION') {
      return 'I do not have enough relevant shared reel context to answer that reliably.';
    }

    return 'I do not have enough context to answer that reliably.';
  }

  private renderMissingEvidenceAnswer(
    missingEvidence: RagRequiredEvidence[],
  ): string {
    if (missingEvidence.includes('VISUAL')) {
      return 'I do not have enough visual evidence from the shared reel to answer that reliably.';
    }

    if (missingEvidence.includes('TRANSCRIPT')) {
      return 'I do not have enough relevant shared reel transcript context to answer that reliably.';
    }

    if (missingEvidence.includes('METADATA')) {
      return 'I do not have enough shared reel metadata to answer that reliably.';
    }

    if (missingEvidence.includes('AUDIO')) {
      return 'I do not have enough audio evidence from the shared reel to answer that reliably.';
    }

    return 'I do not have enough evidence to answer that reliably.';
  }
}
