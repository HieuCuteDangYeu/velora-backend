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

    if (state.route?.intent === 'NORMAL_CHAT') {
      // A chat turn has no retrieved context, so "found relevant context" would be false.
      return 'Sorry, I couldn’t put together an answer just now. Please try asking again.';
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

    if (
      state.route?.intent === 'REEL_VIDEO_QUESTION' &&
      state.hasSharedReelContext === false
    ) {
      // Nothing is shared here, so whichever modality was missing, the real reason is the same.
      return 'I can’t access that Reel because it hasn’t been shared in this conversation. Share it here and I can help with it.';
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
      return 'I can only search your own saved memory, so I can’t look up another person’s details, and I have nothing saved that answers this. If it is about someone else, you can ask them directly; if it is yours, tell me here and I can work from it.';
    }

    if (missingEvidence.includes('CONVERSATION_MEMORY')) {
      return 'I cannot find the requested detail in the conversation history available here. If you share it again, I can continue from there.';
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
      return 'I can’t identify that sound: the indexed audio for this Reel captures what is said, not background sounds or effects, so I would only be guessing. I can summarize what is said around that moment or describe what is visible in the nearest frame instead.';
    }

    if (missingEvidence.includes('VISUAL')) {
      return 'I don’t have indexed visual evidence for that detail, so I won’t guess. I can help with the other parts of this Reel that are available, such as what is said around that moment.';
    }

    if (missingEvidence.includes('TRANSCRIPT')) {
      return 'The available shared Reel context does not contain enough transcript evidence to answer the requested detail. I can help with the other parts of this Reel that are available.';
    }

    if (missingEvidence.includes('METADATA')) {
      return 'The available shared Reel metadata does not contain the requested detail.';
    }

    return 'I do not have enough evidence to answer that reliably.';
  }
}
