import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { CreateNoContextAnswerUseCase } from './create-no-context-answer.use-case';

describe('CreateNoContextAnswerUseCase', () => {
  it('asks the user to identify an ambiguous shared Reel', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.execute({
      route: { reelQuestionType: 'AMBIGUOUS_REEL_REFERENCE' },
      contextSufficiency: {
        userFacingReason: 'I do not have enough verified evidence.',
      },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/which shared Reel or clip/i);
    expect(answer).toContain('?');
  });

  it('states that a task action was not carried out when generation fails', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.executeAfterAnswerGenerationFailure({
      userMessage: 'Send an email to my colleague confirming the appointment.',
      route: { intent: 'TASK_ACTION_REQUEST' },
      contextSufficiency: { sufficient: true },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/can’t send emails from this chat/i);
    expect(answer).toMatch(/no email has been sent/i);
    expect(answer).toMatch(/prepare a draft/i);
  });

  it('does not reuse a sufficiency success reason as the answer when drafting fails', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.executeAfterAnswerGenerationFailure({
      route: { intent: 'REEL_VIDEO_QUESTION' },
      contextSufficiency: {
        sufficient: true,
        userFacingReason:
          'The visual evidence directly describes what is visible in the frame.',
      },
    } as RagChatWorkflowState);

    expect(answer).toBe(
      'I found relevant shared Reel evidence, but could not verify a reliable answer to your question.',
    );
    expect(answer).not.toContain('directly describes');
  });

  it('uses typed missing evidence instead of a generic sufficiency reason', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.execute({
      route: { intent: 'REEL_VIDEO_QUESTION' },
      contextSufficiency: {
        sufficient: false,
        userFacingReason:
          'No relevant shared reel evidence is available in this conversation.',
        missingEvidence: ['AUDIO'],
      },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/audio evidence/i);
    expect(answer).toMatch(/requested audio detail/i);
    expect(answer).not.toMatch(/no relevant shared reel evidence/i);
  });

  it('identifies missing user memory instead of giving a generic refusal', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.execute({
      route: { intent: 'USER_MEMORY_QUESTION' },
      contextSufficiency: {
        sufficient: false,
        missingEvidence: ['USER_MEMORY'],
      },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/your own saved memory/i);
    expect(answer).toMatch(/requested detail/i);
  });

  it('explains that an unshared Reel cannot be accessed', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.execute({
      userMessage: 'Summarize the private Reel that was not shared with me.',
      hasSharedReelContext: false,
      route: { intent: 'REEL_VIDEO_QUESTION' },
      contextSufficiency: {
        sufficient: false,
        missingEvidence: ['TRANSCRIPT', 'METADATA'],
      },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/hasn’t been shared in this conversation/i);
    expect(answer).toMatch(/share it here/i);
  });

  it('does not label missing Reel metadata as an access denial when shared context exists', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.execute({
      userMessage: 'Summarize the shared Reel.',
      hasSharedReelContext: true,
      route: { intent: 'REEL_VIDEO_QUESTION' },
      contextSufficiency: {
        sufficient: false,
        missingEvidence: ['TRANSCRIPT', 'METADATA'],
      },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/transcript or metadata needed/i);
    expect(answer).not.toMatch(/hasn’t been shared/i);
  });

  it('describes a failed combined answer without claiming its evidence is missing', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.executeAfterAnswerGenerationFailure({
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        requiredEvidence: ['TRANSCRIPT', 'VISUAL'],
      },
      contextSufficiency: { sufficient: true },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/transcript and visual evidence/i);
    expect(answer).toMatch(/could not verify/i);
    expect(answer).not.toMatch(/not enough.*evidence/i);
  });

  it('keeps a failed multi-Reel answer attributed to the requested clips', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answer = useCase.executeAfterAnswerGenerationFailure({
      route: {
        intent: 'REEL_VIDEO_QUESTION',
        requiredEvidence: ['TRANSCRIPT'],
      },
      retrievalPlan: { requiresReelCoverage: true },
      contextSufficiency: { sufficient: true },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/requested Reels/i);
    expect(answer).toMatch(/keeps each clip’s statements separate/i);
  });
});
