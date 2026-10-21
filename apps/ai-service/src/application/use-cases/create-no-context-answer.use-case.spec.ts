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
      'I could not form a reliable answer from the available shared Reel evidence.',
    );
    expect(answer).not.toContain('directly describes');
  });
});
