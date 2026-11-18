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

describe('ProcessBotReplyUseCase photo turns', () => {
  const photo = (content: string) =>
    new Message({
      id: 'photo-1',
      conversationId: 'conversation-1',
      senderId: 'user-1',
      content,
      type: 'image',
      createdAt: new Date(),
      media: {
        fileKey: 'chat-images/user-1/abc.png',
        fileUrl: 'https://cdn.example/abc.png',
        mimeType: 'image/png',
      },
    });

  const build = () => {
    const askQuestionStream = jest.fn().mockResolvedValue({ answer: 'ok' });
    const emitConversationTurnCompleted = jest.fn();
    const completedTurn = jest.fn().mockReturnValue({ recentMessages: [] });
    const useCase = new ProcessBotReplyUseCase(
      {
        findMessageById: jest.fn(),
        createMessage: jest.fn((message: Message) => Promise.resolve(message)),
      } as never,
      { askQuestionStream, emitConversationTurnCompleted },
      { execute: jest.fn().mockResolvedValue({ recentMessages: [] }) } as never,
      { execute: completedTurn } as never,
    );
    return {
      useCase,
      askQuestionStream,
      emitConversationTurnCompleted,
      completedTurn,
    };
  };

  it('sends the caption with the photo key', async () => {
    const { useCase, askQuestionStream, emitConversationTurnCompleted } =
      build();

    await useCase.execute(photo('find reels like this'));

    expect(askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'find reels like this',
        images: [
          { fileKey: 'chat-images/user-1/abc.png', mimeType: 'image/png' },
        ],
      }),
    );
    expect(emitConversationTurnCompleted).toHaveBeenCalledWith(
      expect.objectContaining({ userMessage: 'find reels like this' }),
    );
  });

  it('keeps what the AI saw in the photo on the reply so memory can recall it', async () => {
    const created: Message[] = [];
    const askQuestionStream = jest.fn().mockResolvedValue({
      answer: 'Here are some reels for "pasta dinner":',
      imageDescription: 'a plate of pasta',
    });
    const useCase = new ProcessBotReplyUseCase(
      {
        findMessageById: jest.fn(),
        createMessage: jest.fn((message: Message) => {
          created.push(message);
          return Promise.resolve(message);
        }),
      } as never,
      { askQuestionStream, emitConversationTurnCompleted: jest.fn() },
      { execute: jest.fn().mockResolvedValue({ recentMessages: [] }) } as never,
      { execute: jest.fn().mockReturnValue({ recentMessages: [] }) } as never,
    );

    await useCase.execute(photo('find reels like this'));

    expect(created[0].metadata).toEqual({
      photoOfMessageId: 'photo-1',
      photoDescription: 'a plate of pasta',
    });
  });

  it('adds no metadata to a plain text reply', async () => {
    const created: Message[] = [];
    const useCase = new ProcessBotReplyUseCase(
      {
        findMessageById: jest.fn(),
        createMessage: jest.fn((message: Message) => {
          created.push(message);
          return Promise.resolve(message);
        }),
      } as never,
      {
        askQuestionStream: jest.fn().mockResolvedValue({ answer: 'ok' }),
        emitConversationTurnCompleted: jest.fn(),
      },
      { execute: jest.fn().mockResolvedValue({ recentMessages: [] }) } as never,
      { execute: jest.fn().mockReturnValue({ recentMessages: [] }) } as never,
    );

    await useCase.execute(photo('hello'));

    expect(created[0].metadata).toBeUndefined();
  });

  it('sends no words for a bare photo and keeps the placeholder out of memory', async () => {
    const {
      useCase,
      askQuestionStream,
      emitConversationTurnCompleted,
      completedTurn,
    } = build();

    await useCase.execute(photo('[Hình ảnh]'));

    expect(askQuestionStream).toHaveBeenCalledWith(
      expect.objectContaining({ message: '', images: expect.any(Array) }),
    );
    expect(emitConversationTurnCompleted).not.toHaveBeenCalled();
    expect(completedTurn.mock.calls[0][0].userMessage.content).toBe('');
  });

  it('sends no images for a text turn', async () => {
    const { useCase, askQuestionStream } = build();

    await useCase.execute(
      new Message({
        id: 'm',
        conversationId: 'conversation-1',
        senderId: 'user-1',
        content: 'hello',
        type: 'text',
        createdAt: new Date(),
      }),
    );

    expect(askQuestionStream.mock.calls[0][0]).not.toHaveProperty('images');
  });

  it('keeps an unreadable-image failure for the client', async () => {
    const { useCase, askQuestionStream } = build();
    askQuestionStream.mockResolvedValue({
      answer: null,
      error: {
        code: 'IMAGE_UNREADABLE',
        message: 'Could not read that image.',
      },
    });

    expect(await useCase.execute(photo('what is this'))).toEqual({
      botReply: undefined,
      botError: {
        code: 'IMAGE_UNREADABLE',
        message: 'Could not read that image.',
      },
    });
  });
});
