import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import type Redis from 'ioredis';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { IUserService } from '../../domain/interfaces/user-service.interface';

// Display profiles are cached briefly so a burst of messages does not repeat the same
// user-service lookup (and its cloud database round trip) for every message and every
// notification. Only these display fields are stored, never credentials. Invalidation is
// by expiry alone: a renamed user or a new avatar shows up within the TTL.
const PROFILE_KEY_PREFIX = 'conversation:user-profile:';
const DEFAULT_PROFILE_TTL_SECONDS = 60;
const MAX_PROFILE_TTL_SECONDS = 600;
const profileKey = (id: string) => `${PROFILE_KEY_PREFIX}${id}`;

function profileTtlSeconds(raw: string | undefined) {
  const value =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_PROFILE_TTL_SECONDS
      : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_PROFILE_TTL_SECONDS);
}

function pickProfile(user: ValidateUserResponse) {
  const { id, email, fullName, username, picture } = user;
  return { id, email, fullName, username, picture };
}

@Injectable()
export class UserServiceAdapter implements IUserService {
  private readonly logger = new Logger(UserServiceAdapter.name);
  private readonly participantLookups = new Map<
    string,
    Promise<ValidateUserResponse | null>
  >();

  private readonly profileTtl = profileTtlSeconds(
    process.env['USER_PROFILE_CACHE_TTL_SECONDS'],
  );

  constructor(
    @Inject('USER_SERVICE_RMQ') private readonly client: ClientProxy,
    private readonly metrics?: ConversationPrometheusMetricsService,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async validateUsers(ids: string[]): Promise<boolean> {
    return lastValueFrom(
      this.client
        .send<boolean>('user.validate_list', { ids }) // 👈 Gọi đúng Pattern mới
        .pipe(
          timeout(5000), // Quá 5s thì tự cắt
          catchError((err: unknown) => {
            const error = err as Error;
            this.logger.error(`RPC Error [validateUsers]: ${error.message}`);
            return of(false); // Lỗi thì trả về false (An toàn)
          }),
        ),
      { defaultValue: false },
    );
  }

  findUsersByIds(ids: string[]): Promise<ValidateUserResponse | null> {
    const uniqueIds = [...new Set(ids)].sort();
    const key = JSON.stringify(uniqueIds);
    const pending = this.participantLookups.get(key);
    if (pending) return pending;

    const lookup = this.loadParticipants(uniqueIds).finally(() => {
      this.participantLookups.delete(key);
    });
    this.participantLookups.set(key, lookup);
    return lookup;
  }

  // Concurrent identical lookups share one request. When Redis is available, display
  // profiles are also kept for a short TTL (see the cache notes above); membership
  // checks and token verification never use this path.
  private async loadParticipants(
    ids: string[],
  ): Promise<ValidateUserResponse | null> {
    if (!this.redis || this.profileTtl <= 0) return this.requestProfiles(ids);

    const cached = await this.readCachedProfiles(ids);
    const missing = ids.filter((id) => !cached.has(id));
    if (missing.length === 0) return [...cached.values()] as never;

    const response = await this.requestProfiles(missing);
    const fetched = Array.isArray(response)
      ? (response as ValidateUserResponse[])
      : Array.isArray((response as { users?: unknown } | null)?.users)
        ? (response as unknown as { users: ValidateUserResponse[] }).users
        : null;
    if (!fetched) {
      // The lookup failed or had an unknown shape: serve what the cache has.
      return cached.size > 0 ? ([...cached.values()] as never) : response;
    }
    void this.writeCachedProfiles(fetched);
    return cached.size > 0
      ? ([...cached.values(), ...fetched] as never)
      : response;
  }

  private async readCachedProfiles(ids: string[]) {
    const found = new Map<string, ValidateUserResponse>();
    try {
      const values = await this.redis!.mget(ids.map(profileKey));
      values.forEach((raw, index) => {
        if (!raw) return;
        try {
          const profile = JSON.parse(raw) as ValidateUserResponse;
          if (profile && profile.id === ids[index])
            found.set(ids[index], profile);
        } catch {
          // A corrupt entry is a miss; it is replaced after the next lookup.
        }
      });
    } catch {
      this.logger.warn(
        'User profile cache unavailable; using the user service',
      );
    }
    return found;
  }

  private async writeCachedProfiles(users: ValidateUserResponse[]) {
    try {
      const pipeline = this.redis!.pipeline();
      for (const user of users) {
        if (user && typeof user.id === 'string' && user.id) {
          pipeline.set(
            profileKey(user.id),
            JSON.stringify(pickProfile(user)),
            'EX',
            this.profileTtl,
          );
        }
      }
      await pipeline.exec();
    } catch {
      this.logger.warn('User profile cache write failed; continuing');
    }
  }

  private async requestProfiles(
    ids: string[],
  ): Promise<ValidateUserResponse | null> {
    const request = () =>
      lastValueFrom(
        this.client
          .send<ValidateUserResponse | null>('user.find_by_ids', ids)
          .pipe(timeout(5000)),
        { defaultValue: null },
      );
    try {
      return await (this.metrics
        ? this.metrics.measurePhase('user_lookup', request)
        : request());
    } catch {
      this.logger.warn('User lookup RPC unavailable');
      return null;
    }
  }
}
