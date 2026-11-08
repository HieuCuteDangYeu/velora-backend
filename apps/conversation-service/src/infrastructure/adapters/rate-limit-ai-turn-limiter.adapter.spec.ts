import { RateLimitService } from '@common/rate-limit/rate-limit.service';
import { RATE_LIMIT_REDIS } from '@common/rate-limit/rate-limit.types';
import { Test } from '@nestjs/testing';
import type { AiTurnLimitDecision } from '../../domain/interfaces/ai-turn-limiter.interface';
import { ProcessBotReplyUseCase } from '../../application/use-cases/process-bot-reply.use-case';
import { TriggerBotReplyUseCase } from '../../application/use-cases/trigger-bot-reply.use-case';
import { RateLimitAiTurnLimiterAdapter } from './rate-limit-ai-turn-limiter.adapter';

const service = (env: Record<string, string> = {}) =>
  new RateLimitService(undefined, { get: (key: string) => env[key] } as never);

describe('RateLimitAiTurnLimiterAdapter', () => {
  it('allows turns up to the per-minute budget, then reports when to retry', async () => {
    const limiter = new RateLimitAiTurnLimiterAdapter(
      service({ RATE_LIMIT_AI_TURN_MINUTE_LIMIT: '2' }),
    );
    const results: AiTurnLimitDecision[] = [];
    for (let i = 0; i < 3; i += 1)
      results.push(await limiter.consume('user-1'));
    expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
    expect(results[2].retryAfterSeconds).toBeGreaterThan(0);
  });

  it('enforces the daily budget independently of the minute budget', async () => {
    const limiter = new RateLimitAiTurnLimiterAdapter(
      service({ RATE_LIMIT_AI_TURN_DAY_LIMIT: '1' }),
    );
    expect((await limiter.consume('user-1')).allowed).toBe(true);
    expect((await limiter.consume('user-1')).allowed).toBe(false);
  });

  it('budgets each user separately', async () => {
    const limiter = new RateLimitAiTurnLimiterAdapter(
      service({ RATE_LIMIT_AI_TURN_MINUTE_LIMIT: '1' }),
    );
    expect((await limiter.consume('user-a')).allowed).toBe(true);
    expect((await limiter.consume('user-b')).allowed).toBe(true);
    expect((await limiter.consume('user-a')).allowed).toBe(false);
  });

  it('is bound to the IAiTurnLimiter token and spends the module Redis', async () => {
    const redis = { defineCommand: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        { provide: 'REDIS_CLIENT', useValue: redis },
        { provide: RATE_LIMIT_REDIS, useExisting: 'REDIS_CLIENT' },
        RateLimitService,
        { provide: 'IAiTurnLimiter', useClass: RateLimitAiTurnLimiterAdapter },
        { provide: 'IChatRepository', useValue: {} },
        { provide: ProcessBotReplyUseCase, useValue: { execute: jest.fn() } },
        TriggerBotReplyUseCase,
      ],
    }).compile();

    expect(redis.defineCommand).toHaveBeenCalledWith(
      'rateLimitConsume',
      expect.objectContaining({ numberOfKeys: 1 }),
    );
    expect(moduleRef.get('IAiTurnLimiter')).toBeInstanceOf(
      RateLimitAiTurnLimiterAdapter,
    );
    // The use case is required to receive the limiter: DI would fail otherwise.
    expect(moduleRef.get(TriggerBotReplyUseCase)).toBeDefined();
  });
});
