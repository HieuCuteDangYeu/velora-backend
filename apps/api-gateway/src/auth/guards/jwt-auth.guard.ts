import { verifyAccessToken, bannedUserKey } from '@common/auth/access-token';
import { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import { RATE_LIMIT_REDIS } from '@common/rate-limit/rate-limit.types';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ClientProxy } from '@nestjs/microservices';
import { Request } from 'express';
import type Redis from 'ioredis';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';
import { AccessKeyProvider } from '../access-key.provider';
import { FRESH_AUTH_KEY } from '../decorators/fresh-auth.decorator';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  cookies: { [key: string]: string };
}

/**
 * Ordinary users are verified here, without a round trip: the ES256 signature, expiry and
 * token type are checked locally and one Redis lookup confirms the user is not banned.
 * Everything else asks auth-service, which is authoritative:
 *  - admin tokens (so a demoted admin loses access at once),
 *  - routes marked @FreshAuth (they return the current profile),
 *  - tokens signed before the ES256 rollout, tokens with an unknown key, and any Redis error.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
    private readonly accessKeys: AccessKeyProvider,
    private readonly reflector: Reflector,
    @Optional() @Inject(RATE_LIMIT_REDIS) private readonly redis?: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token found');
    }

    const needsFreshIdentity = this.reflector.getAllAndOverride<boolean>(
      FRESH_AUTH_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!needsFreshIdentity) {
      const local = await this.verifyLocally(token);
      if (local) {
        request.user = local;
        return true;
      }
    }

    const startedAt = Date.now();
    try {
      const user = await lastValueFrom(
        this.authClient
          .send<AuthUser>('auth.verify_token', { token })
          .pipe(timeout(5000)),
      );

      request.user = user;
      return true;
    } catch (error) {
      if (isRpcError(error) && error.statusCode === 401)
        throw new UnauthorizedException('Invalid or expired token');
      this.logger.warn(
        `auth.verify_token unavailable reason=${error instanceof TimeoutError ? 'timeout' : 'upstream'} elapsed_ms=${Date.now() - startedAt}`,
      );
      throw new ServiceUnavailableException(
        'Authentication service unavailable',
      );
    }
  }

  /** The user for a token that can be decided here, or null to ask auth-service. */
  private async verifyLocally(token: string): Promise<AuthUser | null> {
    const result = verifyAccessToken(token, this.accessKeys.current());
    if (!result.ok) {
      if (result.reason === 'unknown_key') this.accessKeys.refreshSoon();
      return null;
    }

    const claims = result.payload;
    if (!Array.isArray(claims.roles) || claims.roles.includes('ADMIN')) {
      return null;
    }
    if (!this.redis) return null;

    let banned: number;
    try {
      banned = await this.redis.exists(bannedUserKey(claims.sub));
    } catch {
      return null; // ban list unreachable: let auth-service decide
    }
    if (banned !== 0) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    return {
      id: claims.sub,
      email: claims.email,
      fullName: claims.fullName,
      username: claims.username,
      picture: claims.picture ?? undefined,
      isVerified: claims.isVerified,
      roles: claims.roles,
    };
  }

  private extractToken(request: AuthenticatedRequest): string | undefined {
    if (request.cookies && request.cookies['access_token']) {
      return request.cookies['access_token'];
    }

    const authHeader = request.headers['authorization'];
    if (!authHeader) return undefined;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }
}
