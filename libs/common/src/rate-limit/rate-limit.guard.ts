import { createHash } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { resolveClientIp } from './client-ip';
import {
  RATE_LIMIT_RULES,
  type RateLimitRule,
  type RateLimitSubject,
} from './rate-limit.decorator';
import { RateLimitService } from './rate-limit.service';

type RateLimitedRequest = Request & { user?: { id?: string } };

/**
 * Enforces `@RateLimit(...)` rules. For authenticated routes list it after
 * JwtAuthGuard (`@UseGuards(JwtAuthGuard, RateLimitGuard)`); for public routes
 * it is the first line of defence, ahead of any RPC to the auth service.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly clientIpHeader?: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly rateLimits: RateLimitService,
    config: ConfigService,
  ) {
    this.clientIpHeader =
      config.get<string>('RATE_LIMIT_CLIENT_IP_HEADER')?.trim() || undefined;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const rules = this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
      RATE_LIMIT_RULES,
      [context.getHandler(), context.getClass()],
    );
    if (!rules?.length) return true;

    const http = context.switchToHttp();
    const request = http.getRequest<RateLimitedRequest>();

    for (const rule of rules) {
      const subject = this.subjectFor(rule.by, request);
      if (subject === undefined) continue;

      const decision = await this.rateLimits.check(rule.policy, subject);
      if (decision.allowed) continue;

      this.rateLimits.logDenied(rule.policy, decision);
      const response = http.getResponse<Response>();
      response.setHeader('Retry-After', String(decision.retryAfterSeconds));
      response.setHeader('RateLimit-Limit', String(decision.limit));
      response.setHeader('RateLimit-Remaining', '0');
      throw new HttpException(
        {
          statusCode: HttpStatus.TOO_MANY_REQUESTS,
          message: 'Too many requests. Please try again later.',
          retryAfterSeconds: decision.retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }

  private subjectFor(
    by: RateLimitSubject,
    request: RateLimitedRequest,
  ): string | undefined {
    if (by === 'user') {
      const userId = request.user?.id;
      if (userId) return `u:${userId}`;
      return `ip:${resolveClientIp(request, this.clientIpHeader)}`;
    }
    if (by === 'ip') {
      return `ip:${resolveClientIp(request, this.clientIpHeader)}`;
    }
    const value = (request.body as Record<string, unknown> | undefined)?.[
      by.body
    ];
    if (typeof value !== 'string' || value.trim() === '') return undefined;
    // Hash so raw emails never become Redis keys or end up in logs.
    return `b:${createHash('sha256')
      .update(value.trim().toLowerCase())
      .digest('hex')
      .slice(0, 32)}`;
  }
}
