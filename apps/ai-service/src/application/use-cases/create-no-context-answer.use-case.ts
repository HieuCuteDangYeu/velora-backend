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

  executeAfterAnswerGenerationFailure(state: RagChatWorkflowState): string {
    if (state.route?.intent === 'TASK_ACTION_REQUEST') {
      return this.taskActionLimitation(state.userMessage);
    }

    if (state.contextSufficiency?.sufficient === true) {
      if (state.route?.intent === 'REEL_VIDEO_QUESTION') {
        if (state.retrievalPlan?.requiresReelCoverage === true) {
          return 'I found relevant evidence for the requested Reels, but could not verify a complete comparison that keeps each clip’s statements separate.';
        }
        const requiredEvidence = new Set(state.route.requiredEvidence);
        if (
          requiredEvidence.has('TRANSCRIPT') &&
          requiredEvidence.has('VISUAL')
        ) {
          return 'I found both transcript and visual evidence, but could not verify a reliable answer connecting what was said with what was shown.';
        }
        return 'I found relevant shared Reel evidence, but could not verify a reliable answer to your question.';
      }
      return 'I found relevant context, but could not verify a reliable answer to your question.';
    }
    return this.buildAnswer(state);
  }

  private buildAnswer(state: RagChatWorkflowState): string {
    if (state.route?.intent === 'TASK_ACTION_REQUEST') {
      return this.taskActionLimitation(state.userMessage);
    }

    if (state.route?.reelQuestionType === 'AMBIGUOUS_REEL_REFERENCE') {
      return 'Which shared Reel or clip do you mean? Please identify the one you want me to use.';
    }

    const userFacingReason = state.contextSufficiency?.userFacingReason?.trim();
    const missingEvidence = state.contextSufficiency?.missingEvidence ?? [];
    const missingReelIds = state.contextSufficiency?.missingReelIds ?? [];

    if (
      missingReelIds.length > 0 &&
      state.retrievalPlan?.requiresReelCoverage === true
    ) {
      return 'I do not have complete evidence for every requested Reel, so I cannot compare them reliably.';
    }

    if (missingEvidence.length > 0)
      return this.renderMissingEvidenceAnswer(state, missingEvidence);

    if (userFacingReason) return userFacingReason;

    if (state.route?.intent === 'REEL_VIDEO_QUESTION') {
      return 'I do not have enough relevant shared reel context to answer that reliably.';
    }

    return 'I do not have enough context to answer that reliably.';
  }

  private taskActionLimitation(userMessage: string): string {
    if (/\b(?:e-?mail)\b/i.test(userMessage)) {
      return 'I can’t send emails from this chat, so no email has been sent. I can prepare a draft here for you to review and send.';
    }

    return 'I can’t carry out external actions from this chat, so nothing has been done. I can help prepare it or explain the steps.';
  }

  private renderMissingEvidenceAnswer(
    state: RagChatWorkflowState,
    missingEvidence: RagRequiredEvidence[],
  ): string {
    if (missingEvidence.includes('USER_MEMORY')) {
      return 'I can only search your own saved memory, and I do not have the requested detail available here.';
    }

    if (missingEvidence.includes('CONVERSATION_MEMORY')) {
      return 'I cannot find the requested detail in the conversation history available here.';
    }

    if (
      missingEvidence.includes('TRANSCRIPT') &&
      missingEvidence.includes('METADATA')
    ) {
      if (state.hasSharedReelContext === false) {
        return 'I can’t access that Reel because it hasn’t been shared in this conversation. Share it here and I can help with it.';
      }
      return 'I do not have shared Reel context with the transcript or metadata needed to answer that.';
    }

    if (missingEvidence.includes('AUDIO')) {
      return 'The available shared Reel context does not contain enough audio evidence to identify the requested audio detail.';
    }

    if (missingEvidence.includes('VISUAL')) {
      return 'The available shared Reel context does not contain enough visual evidence to identify the requested visual detail.';
    }

    if (missingEvidence.includes('TRANSCRIPT')) {
      return 'The available shared Reel context does not contain enough transcript evidence to answer the requested detail.';
    }

    if (missingEvidence.includes('METADATA')) {
      return 'The available shared Reel metadata does not contain the requested detail.';
    }

    return 'I do not have enough evidence to answer that reliably.';
  }
}
