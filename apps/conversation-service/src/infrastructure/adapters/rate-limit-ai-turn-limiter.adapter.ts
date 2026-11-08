import { RateLimitService } from '@common/rate-limit/rate-limit.service';
import { Injectable } from '@nestjs/common';
import {
  AiTurnLimitDecision,
  IAiTurnLimiter,
} from '../../domain/interfaces/ai-turn-limiter.interface';

/** Spends one token from the per-minute and per-day AI-turn buckets (see rate-limit.policies.ts). */
@Injectable()
export class RateLimitAiTurnLimiterAdapter implements IAiTurnLimiter {
  constructor(private readonly rateLimits: RateLimitService) {}

  async consume(userId: string): Promise<AiTurnLimitDecision> {
    for (const policy of ['ai_turn_minute', 'ai_turn_day'] as const) {
      const decision = await this.rateLimits.check(policy, `u:${userId}`);
      if (!decision.allowed) {
        this.rateLimits.logDenied(policy, decision);
        return {
          allowed: false,
          retryAfterSeconds: decision.retryAfterSeconds,
        };
      }
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
