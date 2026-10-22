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
