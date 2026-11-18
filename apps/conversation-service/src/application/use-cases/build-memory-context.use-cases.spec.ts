import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Message } from '../../domain/entities/message.entity';
import { BuildBotMemoryContextUseCase } from './build-bot-memory-context.use-case';
import { BuildCompletedTurnMemoryContextUseCase } from './build-completed-turn-memory-context.use-case';

describe('conversation memory context builders', () => {
  const at = (second: number) =>
    new Date(`2026-01-01T00:00:${String(second).padStart(2, '0')}Z`);

  it('preserves structural reel-share events without exposing reel IDs', async () => {
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue([
        new Message({
          id: 'share',
          senderId: 'user',
          type: 'reel',
          content: '',
          media: { fileUrl: 'safe', reelId: 'private-id', reelTitle: 'Orbit' },
          createdAt: at(1),
        }),
        new Message({
          id: 'assistant',
          senderId: BOT_USER_ID,
          type: 'text',
          content: 'How can I help?',
          createdAt: at(2),
        }),
      ]),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({
      conversationId: 'conversation',
      currentMessageId: 'current',
    });
    expect(result).toEqual({
      recentMessages: [
        {
          role: 'user',
          content: '[Shared reel] Orbit',
          createdAt: at(1).toISOString(),
          eventType: 'REEL_SHARE',
        },
        {
          role: 'assistant',
          content: 'How can I help?',
          createdAt: at(2).toISOString(),
          eventType: 'TEXT',
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('keeps a photo message as a caption line and never as image data', async () => {
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue([
        new Message({
          id: 'captioned',
          senderId: 'user',
          type: 'image',
          content: 'find reels like this',
          media: { fileKey: 'chat-images/user/secret.jpg' },
          createdAt: at(1),
        }),
        new Message({
          id: 'bare',
          senderId: 'user',
          type: 'image',
          content: '[Hình ảnh]',
          createdAt: at(2),
        }),
      ]),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({ conversationId: 'conversation', currentMessageId: 'current' });

    expect(result.recentMessages.map((message) => message.content)).toEqual([
      '[Photo] find reels like this',
      '[Photo]',
    ]);
    expect(JSON.stringify(result)).not.toContain('secret.jpg');
  });

  it('adds what the AI saw in a photo, but only from the bot reply that describes that photo', async () => {
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue([
        new Message({
          id: 'photo',
          senderId: 'user',
          type: 'image',
          content: 'find reels like this',
          createdAt: at(1),
        }),
        new Message({
          id: 'reply',
          senderId: BOT_USER_ID,
          type: 'text',
          content: 'Here are some reels',
          metadata: {
            photoOfMessageId: 'photo',
            photoDescription: 'a plate of pasta with tomato sauce',
          },
          createdAt: at(2),
        }),
        new Message({
          id: 'forged-photo',
          senderId: 'user',
          type: 'image',
          content: '[Hình ảnh]',
          createdAt: at(3),
        }),
        new Message({
          id: 'forged-reply',
          senderId: 'user',
          type: 'text',
          content: 'not a bot',
          metadata: {
            photoOfMessageId: 'forged-photo',
            photoDescription: 'FORGED',
          },
          createdAt: at(4),
        }),
      ]),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({ conversationId: 'conversation', currentMessageId: 'current' });

    expect(result.recentMessages.map((message) => message.content)).toEqual([
      '[Photo] find reels like this shows: a plate of pasta with tomato sauce',
      'Here are some reels',
      '[Photo]',
      'not a bot',
    ]);
  });

  it('offers messages beyond the live window as shortened older messages', async () => {
    const messages = Array.from(
      { length: 20 },
      (_, index) =>
        new Message({
          id: `m${index}`,
          senderId: index % 2 ? BOT_USER_ID : 'user',
          type: 'text',
          content:
            index === 0 ? `first ${'x'.repeat(500)}` : `message ${index}`,
          createdAt: at(index),
        }),
    );
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue(messages),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({ conversationId: 'conversation', currentMessageId: 'current' });

    expect(result.recentMessages).toHaveLength(12);
    expect(result.recentMessages[0].content).toBe('message 8');
    expect(result.olderMessages).toHaveLength(8);
    expect(result.olderMessages?.[0].content.length).toBeLessThanOrEqual(300);
    expect(result.olderMessages?.[7].content).toBe('message 7');
    expect(repository.findMessagesByConversationId).toHaveBeenCalledWith(
      'conversation',
      120,
    );
  });

  it('marks which user messages were written by the requester so other members are not remembered as them', async () => {
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue([
        new Message({
          id: 'a',
          senderId: 'alice',
          type: 'text',
          content: 'I am vegan and I live in Hanoi',
          createdAt: at(1),
        }),
        new Message({
          id: 'b',
          senderId: BOT_USER_ID,
          type: 'text',
          content: 'Noted.',
          createdAt: at(2),
        }),
        new Message({
          id: 'c',
          senderId: 'bob',
          type: 'text',
          content: 'I prefer short answers',
          createdAt: at(3),
        }),
      ]),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({
      conversationId: 'conversation',
      currentMessageId: 'current',
      requesterUserId: 'bob',
    });

    expect(
      result.recentMessages
        .filter((message) => message.role === 'user')
        .map((message) => [message.content, message.authorIsRequester]),
    ).toEqual([
      ['I am vegan and I live in Hanoi', false],
      ['I prefer short answers', true],
    ]);
  });

  it('leaves authorship unset when no requester is given', async () => {
    const repository = {
      findMessagesByConversationId: jest.fn().mockResolvedValue([
        new Message({
          id: 'a',
          senderId: 'alice',
          type: 'text',
          content: 'hello there',
          createdAt: at(1),
        }),
      ]),
    };

    const result = await new BuildBotMemoryContextUseCase(
      repository as never,
    ).execute({ conversationId: 'conversation', currentMessageId: 'current' });

    expect(result.recentMessages[0]).not.toHaveProperty('authorIsRequester');
  });

  it('marks the completed turn user message as written by the requester', () => {
    const result = new BuildCompletedTurnMemoryContextUseCase().execute({
      userMessage: new Message({ content: 'What is it?', createdAt: at(2) }),
      assistantMessage: new Message({
        content: 'An answer.',
        createdAt: at(3),
      }),
    });

    expect(result.recentMessages[0]).toMatchObject({
      role: 'user',
      authorIsRequester: true,
    });
    expect(result.recentMessages[1]).not.toHaveProperty('authorIsRequester');
  });

  it('marks newly completed user and assistant messages as text events', () => {
    const result = new BuildCompletedTurnMemoryContextUseCase().execute({
      previousMemory: {
        recentMessages: [
          {
            role: 'user',
            content: '[Shared reel] Prior',
            createdAt: at(1).toISOString(),
            eventType: 'REEL_SHARE',
          },
        ],
      },
      userMessage: new Message({ content: 'What is it?', createdAt: at(2) }),
      assistantMessage: new Message({
        content: 'An answer.',
        createdAt: at(3),
      }),
    });

    expect(result.recentMessages.map((message) => message.eventType)).toEqual([
      'REEL_SHARE',
      'TEXT',
      'TEXT',
    ]);
  });
});
