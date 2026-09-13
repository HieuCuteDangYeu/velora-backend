import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import { StreamFinalAnswerUseCase } from './stream-final-answer.use-case';

describe('StreamFinalAnswerUseCase', () => {
  it('streams an already-finalized synthesized answer unchanged', async () => {
    const answer =
      'The speaker began learning TypeScript roughly three years ago when the team moved away from plain JavaScript.';
    const publisher = { publishToken: jest.fn() };
    const llmService = {
      generateResponseStream: jest.fn().mockResolvedValue('unexpected'),
    };
    const promptBuilder = { build: jest.fn() };
    const useCase = new StreamFinalAnswerUseCase(
      llmService,
      publisher,
      promptBuilder,
    );

    const result = await useCase.execute({
      userId: 'user-1',
      conversationId: 'conversation-1',
      userMessage: 'Why did the speaker learn TypeScript?',
      answer,
    } as unknown as RagChatWorkflowState);

    expect(result).toBe(answer);
    expect(llmService.generateResponseStream).not.toHaveBeenCalled();
    expect(promptBuilder.build).not.toHaveBeenCalled();
    const publishedCalls = publisher.publishToken.mock.calls as Array<
      [{ token: string }]
    >;
    expect(publishedCalls.map(([input]) => input.token).join('')).toBe(answer);
  });
});
