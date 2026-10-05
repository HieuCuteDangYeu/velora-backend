import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import { TriggerBotReplyUseCase } from './trigger-bot-reply.use-case';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '507f1f77bcf86cd799439011';

const userMessage = () =>
  new Message({
    id: 'user-message-id',
    conversationId: CONVERSATION_ID,
    senderId: USER_ID,
    content: 'question',
    signalType: 0,
    type: 'text',
    createdAt: new Date('2026-08-19T00:01:00.000Z'),
  });

describe('TriggerBotReplyUseCase', () => {
  it.each([false, true])(
    'reuses dispatch membership with bot=%s',
    async (withBot) => {
      const repository = { findConversation: jest.fn() };
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        repository as never,
        process as never,
      );
      const conversation = new Conversation({
        id: CONVERSATION_ID,
        participantIds: withBot ? [USER_ID, BOT_USER_ID] : [USER_ID],
      });
      expect(
        await useCase.execute(userMessage(), USER_ID, conversation),
      ).toEqual({
        triggered: withBot,
        ...(withBot ? { botReply: undefined, botError: undefined } : {}),
      });
      expect(repository.findConversation).not.toHaveBeenCalled();
      expect(process.execute).toHaveBeenCalledTimes(withBot ? 1 : 0);
    },
  );

  it('does not hydrate a known missing dispatch conversation again', async () => {
    const repository = { findConversation: jest.fn() };
    const process = { execute: jest.fn() };
    const useCase = new TriggerBotReplyUseCase(
      repository as never,
      process as never,
    );
    expect(await useCase.execute(userMessage(), USER_ID, null)).toEqual({
      triggered: false,
    });
    expect(repository.findConversation).not.toHaveBeenCalled();
    expect(process.execute).not.toHaveBeenCalled();
  });
  it('preserves an AI failure for the transport layer to emit', async () => {
    const chatRepository = {
      findConversation: jest.fn().mockResolvedValue({
        participantIds: [USER_ID, BOT_USER_ID],
      }),
    };
    const processBotReplyUseCase = {
      execute: jest.fn().mockResolvedValue({
        botError: {
          code: 'AI_UNAVAILABLE',
          message: 'provider detail must not reach clients',
        },
      }),
    };
    const useCase = new TriggerBotReplyUseCase(
      chatRepository as never,
      processBotReplyUseCase as never,
    );

    await expect(useCase.execute(userMessage(), USER_ID)).resolves.toEqual({
      triggered: true,
      botError: {
        code: 'AI_UNAVAILABLE',
        message: 'provider detail must not reach clients',
      },
    });
  });

  it('keeps unexpected trigger failures inside the declared error contract', async () => {
    const chatRepository = {
      findConversation: jest.fn().mockResolvedValue({
        participantIds: [USER_ID, BOT_USER_ID],
      }),
    };
    const processBotReplyUseCase = {
      execute: jest.fn().mockRejectedValue(new Error('internal detail')),
    };
    const useCase = new TriggerBotReplyUseCase(
      chatRepository as never,
      processBotReplyUseCase as never,
    );

    await expect(useCase.execute(userMessage(), USER_ID)).resolves.toEqual({
      triggered: false,
      botError: {
        code: 'UNKNOWN',
        message: 'internal detail',
      },
    });
  });
});
