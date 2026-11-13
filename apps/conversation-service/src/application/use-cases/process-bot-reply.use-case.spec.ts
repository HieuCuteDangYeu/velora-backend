import { ProcessBotReplyUseCase } from './process-bot-reply.use-case';
import { Message } from '../../domain/entities/message.entity';

describe('ProcessBotReplyUseCase reply-to-Reel hint', () => {
  const buildUserMessage = (replyToId?: string) =>
    new Message({
      id: 'user-message-1',
      conversationId: 'conversation-1',
      senderId: 'user-1',
      content: 'What is this reel about?',
      type: 'text',
      createdAt: new Date(),
      ...(replyToId ? { replyToId } : {}),
    });

  const build = (findMessageById: jest.Mock) => {
    const askQuestionStream = jest.fn().mockResolvedValue({ answer: 'ok' });
    const chatRepository = {
      findMessageById,
      createMessage: jest.fn((message: Message) => Promise.resolve(message)),
    };
    const useCase = new ProcessBotReplyUseCase(
      chatRepository as never,
      {
        askQuestionStream,
        emitConversationTurnCompleted: jest.fn(),
      },
      { execute: jest.fn().mockResolvedValue({ recentMessages: [] }) } as never,
      { execute: jest.fn().mockReturnValue({ recentMessages: [] }) } as never,
    );

    return { useCase, askQuestionStream, findMessageById };
  };

  it('passes the replied-to Reel so "this reel" is not ambiguous', async () => {
    const { useCase, askQuestionStream, findMessageById } = build(
      jest.fn().mockResolvedValue(
        new Message({
          id: 'reel-message-1',
          conversationId: 'conversation-1',
          senderId: 'user-1',
          content: '',
          type: 'reel',
          createdAt: new Date(),
          media: { fileUrl: '', reelId: ' reel-42 ' },
        }),
      ),
    );

    await useCase.execute(buildUserMessage('reel-message-1'));

    expect(findMessageById).toHaveBeenCalledWith(
      'conversation-1',
      'reel-message-1',
    );
    expect(askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({ replyToReelId: 'reel-42' }),
    );
  });

  it('sends no hint when the message is not a reply', async () => {
    const { useCase, askQuestionStream, findMessageById } = build(jest.fn());

    await useCase.execute(buildUserMessage());

    expect(findMessageById).not.toHaveBeenCalled();
    expect(askQuestionStream.mock.calls[0][0]).not.toHaveProperty(
      'replyToReelId',
    );
  });

  it('sends no hint when the replied-to message is not a Reel or was recalled', async () => {
    for (const target of [
      new Message({
        id: 'text-1',
        conversationId: 'conversation-1',
        senderId: 'user-1',
        content: 'hello',
        type: 'text',
        createdAt: new Date(),
      }),
      new Message({
        id: 'reel-recalled',
        conversationId: 'conversation-1',
        senderId: 'user-1',
        content: '',
        type: 'reel',
        createdAt: new Date(),
        isRecalled: true,
        media: { fileUrl: '', reelId: 'reel-42' },
      }),
      null,
    ]) {
      const { useCase, askQuestionStream } = build(
        jest.fn().mockResolvedValue(target),
      );

      await useCase.execute(buildUserMessage('target'));

      expect(askQuestionStream.mock.calls[0][0]).not.toHaveProperty(
        'replyToReelId',
      );
    }
  });

  it('still answers when the lookup fails', async () => {
    const { useCase, askQuestionStream } = build(
      jest.fn().mockRejectedValue(new Error('db down')),
    );

    const result = await useCase.execute(buildUserMessage('target'));

    expect(askQuestionStream).toHaveBeenCalledTimes(1);
    expect(askQuestionStream.mock.calls[0][0]).not.toHaveProperty(
      'replyToReelId',
    );
    expect(result.botError).toBeUndefined();
  });
});
