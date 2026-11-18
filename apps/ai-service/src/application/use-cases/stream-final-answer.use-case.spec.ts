import type { RagChatWorkflowState } from '@ai/domain/interfaces/rag-chat-workflow.interface';
import {
  RAG_OUTPUT_REFUSAL_MESSAGE,
  ScreenRagResultUseCase,
} from './screen-rag-result.use-case';
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

  describe('output enforcement', () => {
    const REEL = '507f1f77bcf86cd799439011';
    const secret = 'gsk_abcdefghijklmnopqrstuvwxyz123456';
    const state = (answer?: string) =>
      ({
        userId: 'user-1',
        conversationId: 'conversation-1',
        userMessage: 'What is in the reel?',
        accessibleReelIds: [REEL],
        ...(answer ? { answer } : {}),
      }) as unknown as RagChatWorkflowState;
    const screen = (mode: string) =>
      new ScreenRagResultUseCase({
        get: (key: string) =>
          key === 'AI_GUARDRAIL_OUTPUT_MODE' ? mode : undefined,
      } as never);
    const published = (publisher: { publishToken: jest.Mock }) =>
      (publisher.publishToken.mock.calls as Array<[{ token: string }]>)
        .map(([call]) => call.token)
        .join('');

    it('replaces a prepared answer that leaks before publishing any of it', async () => {
      const publisher = { publishToken: jest.fn() };
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream: jest.fn() },
        publisher,
        { build: jest.fn() },
        screen('enforce'),
      );

      const result = await useCase.execute(
        state(`The key is ${secret} as said in the reel.`),
      );

      expect(result).toBe(RAG_OUTPUT_REFUSAL_MESSAGE);
      expect(published(publisher)).toBe(RAG_OUTPUT_REFUSAL_MESSAGE);
      expect(published(publisher)).not.toContain('gsk_');
    });

    it('publishes a prepared answer unchanged when enforcing and nothing leaks', async () => {
      const publisher = { publishToken: jest.fn() };
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream: jest.fn() },
        publisher,
        { build: jest.fn() },
        screen('enforce'),
      );

      await expect(useCase.execute(state('A clean answer.'))).resolves.toBe(
        'A clean answer.',
      );
      expect(published(publisher)).toBe('A clean answer.');
    });

    it('does not screen in shadow mode and streams live', async () => {
      const publisher = { publishToken: jest.fn() };
      const generateResponseStream = jest.fn(
        async (
          _message: string,
          _prompt: string,
          _user: string,
          onToken: (token: string) => void,
        ) => {
          onToken(secret);
          return secret;
        },
      );
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream },
        publisher,
        { build: jest.fn().mockReturnValue('prompt') },
        screen('shadow'),
      );

      await expect(useCase.execute(state())).resolves.toBe(secret);
      expect(publisher.publishToken).toHaveBeenCalledTimes(1);
    });

    const streamOf = (text: string, size = 7) =>
      jest.fn(
        async (
          _message: string,
          _prompt: string,
          _user: string,
          onToken: (token: string) => void,
        ) => {
          for (let i = 0; i < text.length; i += size) {
            onToken(text.slice(i, i + size));
          }
          return text;
        },
      );

    it('holds a live answer back, then publishes all of it when it is clean', async () => {
      const text = 'A perfectly ordinary answer about cooking. '.repeat(12);
      const publisher = { publishToken: jest.fn() };
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream: streamOf(text) },
        publisher,
        { build: jest.fn().mockReturnValue('prompt') },
        screen('enforce'),
      );

      await expect(useCase.execute(state())).resolves.toBe(text);
      expect(published(publisher)).toBe(text);
    });

    it('never publishes a secret that appears mid-stream', async () => {
      const text = `${'Here is some context. '.repeat(10)}The key is ${secret} ok. ${'More text. '.repeat(20)}`;
      const publisher = { publishToken: jest.fn() };
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream: streamOf(text) },
        publisher,
        { build: jest.fn().mockReturnValue('prompt') },
        screen('enforce'),
      );

      await expect(useCase.execute(state())).resolves.toBe(
        RAG_OUTPUT_REFUSAL_MESSAGE,
      );
      expect(published(publisher)).not.toContain('gsk_');
      expect(published(publisher).length).toBeLessThan(text.indexOf(secret));
    });

    it('fails open when screening throws', async () => {
      const useCase = new StreamFinalAnswerUseCase(
        { generateResponseStream: jest.fn() },
        { publishToken: jest.fn() },
        { build: jest.fn() },
        {
          enforcesOutput: () => true,
          blockingAnswerCodes: () => {
            throw new Error('boom');
          },
        } as never,
      );

      await expect(useCase.execute(state('A clean answer.'))).resolves.toBe(
        'A clean answer.',
      );
    });
  });
});
