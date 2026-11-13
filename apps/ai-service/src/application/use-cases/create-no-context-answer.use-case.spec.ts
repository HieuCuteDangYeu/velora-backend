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

  it('asks which Reel is meant when several are shared and none was identified', () => {
    const answer = new CreateNoContextAnswerUseCase().execute({
      route: { intent: 'REEL_VIDEO_QUESTION' },
      hasSharedReelContext: true,
      accessibleReelIds: ['reel-a', 'reel-b', 'reel-c'],
      contextSufficiency: { missingEvidence: ['TRANSCRIPT', 'METADATA'] },
    } as unknown as RagChatWorkflowState);

    expect(answer).toMatch(/which of the Reels shared here you mean/i);
    expect(answer).toMatch(/reply to the Reel/i);
  });

  it('keeps the missing-context message when the user already named the Reel by replying', () => {
    const answer = new CreateNoContextAnswerUseCase().execute({
      route: { intent: 'REEL_VIDEO_QUESTION' },
      hasSharedReelContext: true,
      accessibleReelIds: ['reel-a'],
      replyToReelId: 'reel-a',
      contextSufficiency: { missingEvidence: ['TRANSCRIPT', 'METADATA'] },
    } as unknown as RagChatWorkflowState);

    expect(answer).toBe(
      'I do not have shared Reel context with the transcript or metadata needed to answer that.',
    );
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

    expect(answer).toMatch(/indexed audio/i);
    expect(answer).toMatch(/identify that sound/i);
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
    expect(answer).toMatch(/nothing saved that answers this/i);
  });

  it.each([
    ['USER_MEMORY', /your own saved memory/i, /ask them directly/i],
    ['CONVERSATION_MEMORY', /conversation history/i, /share it again/i],
    ['AUDIO', /indexed audio/i, /summarize what is said/i],
    ['VISUAL', /indexed visual evidence/i, /other parts of this Reel/i],
    ['TRANSCRIPT', /transcript evidence/i, /other parts of this Reel/i],
  ])(
    'keeps the %s limitation and offers a safe next step',
    (missing, limitation, nextStep) => {
      const answer = new CreateNoContextAnswerUseCase().execute({
        route: { intent: 'REEL_VIDEO_QUESTION' },
        hasSharedReelContext: true,
        contextSufficiency: { sufficient: false, missingEvidence: [missing] },
      } as unknown as RagChatWorkflowState);

      expect(answer).toMatch(limitation);
      expect(answer).toMatch(nextStep);
    },
  );

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

  describe('after the draft step fails', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    // For chat the sufficiency check says "retrieval not required", so it is marked sufficient.
    const sufficient = {
      sufficient: true,
      reason: 'Retrieval is not required for this intent.',
    };

    it('does not claim to have found context for an ordinary chat turn', () => {
      const answer = useCase.executeAfterAnswerGenerationFailure({
        route: { intent: 'NORMAL_CHAT' },
        contextSufficiency: sufficient,
      } as unknown as RagChatWorkflowState);

      expect(answer).toBe(
        'Sorry, I couldn’t put together an answer just now. Please try asking again.',
      );
      expect(answer).not.toMatch(/relevant context/i);
    });

    it('keeps the existing wording for reel questions', () => {
      expect(
        useCase.executeAfterAnswerGenerationFailure({
          route: {
            intent: 'REEL_VIDEO_QUESTION',
            requiredEvidence: ['TRANSCRIPT'],
          },
          contextSufficiency: sufficient,
        } as unknown as RagChatWorkflowState),
      ).toBe(
        'I found relevant shared Reel evidence, but could not verify a reliable answer to your question.',
      );
    });
  });

  describe('a reel question when no reel is shared in the conversation', () => {
    const useCase = new CreateNoContextAnswerUseCase();
    const answerFor = (
      missingEvidence: string[],
      hasSharedReelContext: boolean,
    ) =>
      useCase.execute({
        userMessage: 'What did the creator say in the last video I watched?',
        hasSharedReelContext,
        route: { intent: 'REEL_VIDEO_QUESTION' },
        contextSufficiency: { sufficient: false, missingEvidence },
      } as unknown as RagChatWorkflowState);

    it.each([
      [['TRANSCRIPT']],
      [['VISUAL']],
      [['AUDIO']],
      [['METADATA']],
      [['TRANSCRIPT', 'METADATA']],
      [['TRANSCRIPT', 'VISUAL']],
    ])('always asks to share the reel first (missing %j)', (missing) => {
      const answer = answerFor(missing, false);
      expect(answer).toMatch(/hasn’t been shared in this conversation/i);
      expect(answer).toMatch(/share it here/i);
      // These used to claim "the available shared Reel context" when none existed.
      expect(answer).not.toMatch(/available shared reel/i);
    });

    it('keeps the evidence-specific wording once a reel is shared', () => {
      expect(answerFor(['TRANSCRIPT'], true)).toMatch(
        /available shared Reel context does not contain enough transcript evidence/i,
      );
      expect(answerFor(['VISUAL'], true)).toMatch(/visual evidence/i);
    });
  });

  it('redirects an off-topic message to what the assistant can help with', () => {
    const answer = new CreateNoContextAnswerUseCase().execute({
      userMessage: 'What is the capital of France?',
      route: { intent: 'OFF_TOPIC', reelQuestionType: 'NONE' },
    } as RagChatWorkflowState);

    expect(answer).toMatch(/only help with Velora/i);
    expect(answer).toMatch(/Reels/);
    // It must not answer, apologise for missing evidence, or echo the question.
    expect(answer).not.toMatch(/Paris|France|evidence|context/i);
  });
});
