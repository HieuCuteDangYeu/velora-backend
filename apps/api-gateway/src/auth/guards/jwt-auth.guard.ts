import { isRpcError } from '@common/constants/rpc-error.types';
import { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { Request } from 'express';
import { lastValueFrom, timeout, TimeoutError } from 'rxjs';

export interface AuthenticatedRequest extends Request {
  user?: AuthUser;
  cookies: { [key: string]: string };
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger(JwtAuthGuard.name);

  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('No authentication token found');
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
