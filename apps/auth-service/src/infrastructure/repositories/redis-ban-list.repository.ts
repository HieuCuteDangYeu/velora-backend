import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import { bannedUserKey } from '@common/auth/access-token';
import { USER_BANNED_CHANNEL } from '@common/auth/ban-events';
import { Inject, Injectable } from '@nestjs/common';
import type Redis from 'ioredis';

@Injectable()
export class RedisBanList implements IBanList {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async ban(userId: string): Promise<void> {
    // No expiry: a ban lasts until an admin lifts it.
    await this.redis.set(bannedUserKey(userId), '1');
    // Open WebSocket sessions authenticate only at connect, so tell the gateways to drop them.
    await this.redis.publish(USER_BANNED_CHANNEL, userId);
  }

  async ensureBanned(userId: string): Promise<boolean> {
    const added = await this.redis.set(bannedUserKey(userId), '1', 'NX');
    if (added === 'OK') await this.redis.publish(USER_BANNED_CHANNEL, userId);
    return added === 'OK';
  }

  async unban(userId: string): Promise<void> {
    await this.redis.del(bannedUserKey(userId));
  }

  async isBanned(userId: string): Promise<boolean> {
    return (await this.redis.exists(bannedUserKey(userId))) === 1;
  }
}
