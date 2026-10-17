import { LoginDto } from '@common/auth/dtos/login.dto';
import { RegisterDto } from '@common/auth/dtos/register.dto';
import { isRpcError } from '@common/constants/rpc-error.types';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { CreateUserPayloadDto } from '@common/user/dtos/create-user.dto';
import { CreateUserResponse } from '@common/user/interfaces/create-user-response.types';
import {
  UpdateUserPayload,
  UpdateUserResponse,
} from '@common/user/interfaces/update-user.types';
import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { UserAlreadyExistsError } from '@user/domain/errors/user-already-exists.error';
import { UsernameAlreadyTakenError } from '@user/domain/errors/username-already-taken.error';
import type Redis from 'ioredis';
import { catchError, lastValueFrom, of, throwError, timeout } from 'rxjs';
import { IUserService } from '../../domain/interfaces/user-service.interface';

// Socket authentication verifies a token on every connect, and each verification needs the
// user record from the user service (and its cloud database round trip). The record used
// for that is cached briefly in Redis. Only the identity fields returned to callers are
// stored, never credentials, and a missing user or a failed lookup is never cached. A
// deleted user is evicted by the delete event (`auth.delete_user_roles`) and a user changed
// through this service is evicted on update or verification; profile edits made elsewhere
// show up when the entry expires, so a deactivated or deleted user stops authenticating
// within the TTL (30 s by default, `AUTH_USER_CACHE_TTL_SECONDS`, 0 disables).
const USER_KEY_PREFIX = 'auth:verify-user:';
const DEFAULT_USER_TTL_SECONDS = 30;
const MAX_USER_TTL_SECONDS = 300;
const userKey = (id: string) => `${USER_KEY_PREFIX}${id}`;

function userTtlSeconds(raw: string | undefined) {
  const value =
    raw === undefined || raw.trim() === ''
      ? DEFAULT_USER_TTL_SECONDS
      : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_USER_TTL_SECONDS);
}

function pickIdentity(user: ValidateUserResponse): ValidateUserResponse {
  const { id, email, fullName, username, picture, isVerified } = user;
  return { id, email, fullName, username, picture, isVerified };
}

@Injectable()
export class UserServiceAdapter implements IUserService {
  private readonly logger = new Logger(UserServiceAdapter.name);
  private readonly userTtl = userTtlSeconds(
    process.env['AUTH_USER_CACHE_TTL_SECONDS'],
  );

  constructor(
    @Inject('USER_SERVICE_RMQ') private readonly rmqClient: ClientProxy,
    @Optional() @Inject('REDIS_CLIENT') private readonly redis?: Redis,
  ) {}

  async createUser(dto: RegisterDto): Promise<CreateUserResponse> {
    const payload: CreateUserPayloadDto = {
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
      isVerified: false,
    };

    return lastValueFrom(
      this.rmqClient.send<CreateUserResponse>('create_user', payload).pipe(
        catchError((err) => {
          if (isRpcError(err) && err.statusCode === 409) {
            if (
              typeof err.message === 'string' &&
              err.message.toLowerCase().includes('username')
            ) {
              return throwError(
                () => new UsernameAlreadyTakenError('username'),
              );
            }

            return throwError(() => new UserAlreadyExistsError(dto.email));
          }

          let errorMessage = 'User Service Failed';

          if (isRpcError(err)) {
            errorMessage = Array.isArray(err.message)
              ? err.message.join(', ')
              : err.message;
          } else if (err instanceof Error) {
            errorMessage = err.message;
          }

          return throwError(() => new Error(errorMessage));
        }),
      ),
    );
  }

  async validateUser(dto: LoginDto): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('validate_user', dto)
        .pipe(
          catchError(() => throwError(() => new Error('Validation failed'))),
        ),
    );
  }

  async verifyUser(id: string): Promise<void> {
    await lastValueFrom(
      this.rmqClient.send<void>('verify_user', id).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to verify user'));
        }),
      ),
      { defaultValue: undefined },
    );
    await this.invalidateCachedUser(id);
  }

  async findByEmail(email: string): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('user.find_by_email', { email })
        .pipe(
          catchError(() => {
            return of(null);
          }),
        ),
      { defaultValue: null },
    );
  }

  async findById(id: string): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('user.find_by_id', id)
        .pipe(timeout(5000)),
      { defaultValue: null },
    );
  }

  async findByIdForAuth(id: string): Promise<ValidateUserResponse | null> {
    if (!this.redis || this.userTtl <= 0) return this.findById(id);

    try {
      const raw = await this.redis.get(userKey(id));
      if (raw) {
        const cached = JSON.parse(raw) as ValidateUserResponse;
        if (cached && cached.id === id) return cached;
      }
    } catch {
      this.logger.warn('User cache unavailable; using the user service');
    }

    const user = await this.findById(id);
    if (user && user.id === id) await this.writeCachedUser(user);
    return user;
  }

  async invalidateCachedUser(id: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.del(userKey(id));
    } catch {
      this.logger.warn('User cache eviction failed; entry expires by TTL');
    }
  }

  private async writeCachedUser(user: ValidateUserResponse) {
    try {
      await this.redis!.set(
        userKey(user.id),
        JSON.stringify(pickIdentity(user)),
        'EX',
        this.userTtl,
      );
    } catch {
      this.logger.warn('User cache write failed; continuing');
    }
  }

  async createSocialUser(
    dto: CreateSocialUserDto,
  ): Promise<ValidateUserResponse> {
    return lastValueFrom(
      this.rmqClient.send<ValidateUserResponse>('user.create_social', dto).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to create social user'));
        }),
      ),
    );
  }

  rollbackUser(id: string): void {
    this.rmqClient.emit('user.rollback', { id });
  }

  async updateUser(payload: UpdateUserPayload): Promise<UpdateUserResponse> {
    const result = await lastValueFrom(
      this.rmqClient.send<UpdateUserResponse>('update_user', payload).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to update user'));
        }),
      ),
    );
    await this.invalidateCachedUser(payload.id);
    return result;
  }
}
