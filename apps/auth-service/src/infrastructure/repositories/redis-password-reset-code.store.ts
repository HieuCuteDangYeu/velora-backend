import type { IPasswordResetCodeStore } from '@auth/domain/interfaces/password-reset-code.store.interface';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import Redis from 'ioredis';

export const MAX_RESET_CODE_ATTEMPTS = 5;

// One atomic step, so parallel guesses cannot get past the attempt cap.
// Returns 1 for a correct code, 0 otherwise.
const CHECK_SCRIPT = `
  local stored = redis.call('HGET', KEYS[1], 'hash')
  if not stored then return 0 end
  if stored == ARGV[1] then
    if ARGV[2] == '1' then redis.call('DEL', KEYS[1]) end
    return 1
  end
  local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
  if attempts >= tonumber(ARGV[3]) then redis.call('DEL', KEYS[1]) end
  return 0
`;

/**
 * Reset codes are keyed by user, so a code only works together with the email
 * it was sent to, and each code allows a few wrong guesses before it is dropped.
 */
@Injectable()
export class RedisPasswordResetCodeStore implements IPasswordResetCodeStore {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async issue(userId: string, code: string, ttlSeconds: number) {
    const key = this.key(userId);
    await this.redis
      .multi()
      .del(key)
      .hset(key, 'hash', this.hash(userId, code), 'attempts', '0')
      .expire(key, ttlSeconds)
      .exec();
  }

  async check(userId: string, code: string, options: { consume: boolean }) {
    const result = await this.redis.eval(
      CHECK_SCRIPT,
      1,
      this.key(userId),
      this.hash(userId, code),
      options.consume ? '1' : '0',
      String(MAX_RESET_CODE_ATTEMPTS),
    );
    return result === 1;
  }

  private key(userId: string) {
    return `reset_password:user:${userId}`;
  }

  // Keeps plain codes out of Redis.
  private hash(userId: string, code: string) {
    return createHash('sha256').update(`${userId}:${code}`).digest('hex');
  }
}
