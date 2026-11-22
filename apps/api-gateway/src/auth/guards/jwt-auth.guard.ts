import { isRpcError } from '@common/constants/rpc-error.types';
import { AuthUser } from '@common/auth/interfaces/auth-user.interface';
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
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { createHash } from 'node:crypto';
import { Request } from 'express';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  cookies: { [key: string]: string };
}

const TOKEN_CACHE_MAX_ENTRIES = 10_000;
const TOKEN_CACHE_MAX_TTL_MS = 30_000;
const READ_METHODS = new Set(['GET', 'HEAD']);

interface CachedIdentity {
  user: AuthUser;
  expiresAt: number;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);
  /**
   * Opt-in, per-process memo of successful `auth.verify_token` results.
   * AUTH_TOKEN_CACHE_TTL_MS=0 (default) disables it. It trades up to that many
   * milliseconds of delay before a deleted user or a changed profile is noticed
   * for one fewer RPC chain per read, so it is capped at 30 s and is limited to:
   *  - GET/HEAD requests (writes always re-verify),
   *  - users without the ADMIN role (admin demotion/deletion is never delayed),
   *  - successful verifications only (errors and 401s are never stored).
   * Entries are keyed by a hash of the whole token and never outlive its `exp`.
   */
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CachedIdentity>();

  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
    @Optional() config?: ConfigService,
  ) {
    const raw = Number(config?.get('AUTH_TOKEN_CACHE_TTL_MS') ?? 0);
    this.cacheTtlMs = Number.isFinite(raw)
      ? Math.min(Math.max(Math.trunc(raw), 0), TOKEN_CACHE_MAX_TTL_MS)
      : 0;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token found');
    }

    const cacheable =
      this.cacheTtlMs > 0 && READ_METHODS.has(request.method ?? '');
    const cacheKey = cacheable ? this.cacheKey(token) : undefined;
    if (cacheKey) {
      const hit = this.cache.get(cacheKey);
      if (hit && hit.expiresAt > Date.now()) {
        request.user = hit.user;
        return true;
      }
      if (hit) this.cache.delete(cacheKey);
    }

    const startedAt = Date.now();
    try {
      const user = await lastValueFrom(
        this.authClient
          .send<AuthUser>('auth.verify_token', { token })
          .pipe(timeout(5000)),
      );

      request.user = user;
      if (cacheKey) this.remember(cacheKey, token, user);
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

  private cacheKey(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private remember(key: string, token: string, user: AuthUser): void {
    if (!Array.isArray(user?.roles) || user.roles.includes('ADMIN')) return;
    const tokenExpiryMs = this.tokenExpiryMs(token);
    if (tokenExpiryMs === undefined) return;
    const now = Date.now();
    const expiresAt = Math.min(now + this.cacheTtlMs, tokenExpiryMs);
    if (expiresAt <= now) return;
    if (this.cache.size >= TOKEN_CACHE_MAX_ENTRIES) {
      for (const [k, v] of this.cache) {
        if (v.expiresAt <= now) this.cache.delete(k);
      }
      if (this.cache.size >= TOKEN_CACHE_MAX_ENTRIES) {
        for (const oldest of this.cache.keys()) {
          this.cache.delete(oldest);
          break;
        }
      }
    }
    this.cache.set(key, { user, expiresAt });
  }

  /** `exp` of a token that auth-service has just accepted; undefined if unreadable. */
  private tokenExpiryMs(token: string): number | undefined {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'),
      ) as { exp?: unknown };
      return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
    } catch {
      return undefined;
    }
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
