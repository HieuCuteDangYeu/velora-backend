import { BOT_USER_ID } from '@common/constants/seed.constants';
import { Message } from '../../domain/entities/message.entity';
import type {
  AiTurnLimitDecision,
  IAiTurnLimiter,
} from '../../domain/interfaces/ai-turn-limiter.interface';
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
    type: 'text',
    createdAt: new Date('2026-08-19T00:01:00.000Z'),
  });

const allowAll: IAiTurnLimiter = {
  consume: jest.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
};

describe('TriggerBotReplyUseCase', () => {
  it.each([false, true])(
    'reuses dispatch membership with bot=%s',
    async (withBot) => {
      const repository = { findConversation: jest.fn() };
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        repository as never,
        process as never,
        allowAll,
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
      allowAll,
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
      allowAll,
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
      allowAll,
    );

    await expect(useCase.execute(userMessage(), USER_ID)).resolves.toEqual({
      triggered: false,
      botError: {
        code: 'UNKNOWN',
        message: 'internal detail',
      },
    });
  });

  describe('AI turn limit', () => {
    const botConversation = () =>
      new Conversation({
        id: CONVERSATION_ID,
        participantIds: [USER_ID, BOT_USER_ID],
      });
    const limiterWith = (decision: AiTurnLimitDecision): IAiTurnLimiter => ({
      consume: jest.fn().mockResolvedValue(decision),
    });

    it('withholds the AI turn and reports RATE_LIMITED when the budget is spent', async () => {
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const limiter = limiterWith({ allowed: false, retryAfterSeconds: 7 });
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        process as never,
        limiter,
      );

      expect(
        await useCase.execute(userMessage(), USER_ID, botConversation()),
      ).toEqual({
        triggered: false,
        botError: {
          code: 'RATE_LIMITED',
          message: 'Too many AI requests. Please try again later.',
          retryAfterSeconds: 7,
        },
      });
      expect(limiter.consume).toHaveBeenCalledWith(USER_ID);
      expect(process.execute).not.toHaveBeenCalled();
    });

    it('runs the AI turn when the budget allows it', async () => {
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        process as never,
        limiterWith({ allowed: true, retryAfterSeconds: 0 }),
      );
      expect(
        (await useCase.execute(userMessage(), USER_ID, botConversation()))
          .triggered,
      ).toBe(true);
      expect(process.execute).toHaveBeenCalledTimes(1);
    });

    it('does not spend the budget on plain chats or on the bot own messages', async () => {
      const limiter = limiterWith({ allowed: true, retryAfterSeconds: 0 });
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        { execute: jest.fn() } as never,
        limiter,
      );
      const plain = new Conversation({
        id: CONVERSATION_ID,
        participantIds: [USER_ID, '22222222-2222-4222-8222-222222222222'],
      });
      await useCase.execute(userMessage(), USER_ID, plain);
      await useCase.execute(userMessage(), BOT_USER_ID, botConversation());
      expect(limiter.consume).not.toHaveBeenCalled();
    });
  });
});
