import { BOT_USER_ID } from '@common/constants/seed.constants';
import { RateLimitService } from '@common/rate-limit/rate-limit.service';
import { RATE_LIMIT_REDIS } from '@common/rate-limit/rate-limit.types';
import { Test } from '@nestjs/testing';
import { Message } from '../../domain/entities/message.entity';
import { Conversation } from '../../domain/entities/conversation.entity';
import { ProcessBotReplyUseCase } from './process-bot-reply.use-case';
import {
  TriggerBotReplyUseCase,
  type TriggerBotReplyResult,
} from './trigger-bot-reply.use-case';

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
  describe('AI turn rate limit', () => {
    const botConversation = () =>
      new Conversation({
        id: CONVERSATION_ID,
        participantIds: [USER_ID, BOT_USER_ID],
      });
    const limiter = (overrides: Record<string, string> = {}) =>
      new RateLimitService(undefined, {
        get: (key: string) => overrides[key],
      } as never);

    it('withholds the AI turn once the per-minute budget is spent', async () => {
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        process as never,
        limiter({ RATE_LIMIT_AI_TURN_MINUTE_LIMIT: '2' }),
      );
      const outcomes: TriggerBotReplyResult[] = [];
      for (let i = 0; i < 3; i += 1) {
        outcomes.push(
          await useCase.execute(userMessage(), USER_ID, botConversation()),
        );
      }
      expect(outcomes.map((o) => o.triggered)).toEqual([true, true, false]);
      expect(outcomes[2].botError).toMatchObject({
        code: 'RATE_LIMITED',
        retryAfterSeconds: expect.any(Number),
      });
      expect(process.execute).toHaveBeenCalledTimes(2);
    });

    it('enforces the daily budget independently of the minute budget', async () => {
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        process as never,
        limiter({ RATE_LIMIT_AI_TURN_DAY_LIMIT: '1' }),
      );
      await useCase.execute(userMessage(), USER_ID, botConversation());
      const second = await useCase.execute(
        userMessage(),
        USER_ID,
        botConversation(),
      );
      expect(second.botError?.code).toBe('RATE_LIMITED');
      expect(process.execute).toHaveBeenCalledTimes(1);
    });

    it('limits each user separately and ignores non-bot conversations', async () => {
      const process = { execute: jest.fn().mockResolvedValue({}) };
      const useCase = new TriggerBotReplyUseCase(
        { findConversation: jest.fn() } as never,
        process as never,
        limiter({ RATE_LIMIT_AI_TURN_MINUTE_LIMIT: '1' }),
      );
      const other = '22222222-2222-4222-8222-222222222222';
      await useCase.execute(userMessage(), USER_ID, botConversation());
      expect(
        (await useCase.execute(userMessage(), other, botConversation()))
          .triggered,
      ).toBe(true);
      // Plain chats must not burn the AI budget.
      const plain = new Conversation({
        id: CONVERSATION_ID,
        participantIds: [USER_ID, other],
      });
      for (let i = 0; i < 5; i += 1) {
        await useCase.execute(userMessage(), USER_ID, plain);
      }
      expect(process.execute).toHaveBeenCalledTimes(2);
    });

    it('is wired by Nest DI with the module Redis token', async () => {
      const redis = { defineCommand: jest.fn() };
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: 'REDIS_CLIENT', useValue: redis },
          { provide: RATE_LIMIT_REDIS, useExisting: 'REDIS_CLIENT' },
          RateLimitService,
          { provide: 'IChatRepository', useValue: {} },
          { provide: ProcessBotReplyUseCase, useValue: { execute: jest.fn() } },
          TriggerBotReplyUseCase,
        ],
      }).compile();
      expect(redis.defineCommand).toHaveBeenCalledWith(
        'rateLimitConsume',
        expect.objectContaining({ numberOfKeys: 1 }),
      );
      const useCase = moduleRef.get(TriggerBotReplyUseCase);
      expect(
        (useCase as unknown as { rateLimits?: RateLimitService }).rateLimits,
      ).toBeInstanceOf(RateLimitService);
    });
  });
});
