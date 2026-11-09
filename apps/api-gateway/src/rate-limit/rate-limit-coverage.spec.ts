import { GUARDS_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type Type } from '@nestjs/common';
import { RATE_LIMIT_RULES } from '@common/rate-limit/rate-limit.decorator';
import type { RateLimitRule } from '@common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import { resolveRateLimitPolicy } from '@common/rate-limit/rate-limit.policies';
import { AuthController } from '@gateway/auth/auth.controller';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { ContentController } from '@gateway/content/content.controller';
import { PublicReelShareController } from '@gateway/content/public-reel-share.controller';
import { ReelCommentsGatewayController } from '@gateway/content/reel-comments.controller';
import { FriendController } from '@gateway/friends/friend.controller';
import { MediaController } from '@gateway/media/media.controller';

interface Route {
  handler: string;
  method: RequestMethod;
  rules?: RateLimitRule[];
}

function routesOf(controller: Type<unknown>): Route[] {
  const prototype = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(prototype).flatMap((name) => {
    const handler = prototype[name];
    if (typeof handler !== 'function') return [];
    const method = Reflect.getMetadata(METHOD_METADATA, handler) as
      | RequestMethod
      | undefined;
    if (method === undefined) return [];
    return [
      {
        handler: name,
        method,
        rules: Reflect.getMetadata(RATE_LIMIT_RULES, handler) as
          | RateLimitRule[]
          | undefined,
      },
    ];
  });
}

const classGuards = (controller: Type<unknown>) =>
  (Reflect.getMetadata(GUARDS_METADATA, controller) ?? []) as unknown[];

const unlimited = (routes: Route[], include: (route: Route) => boolean) =>
  routes.filter((route) => include(route) && !route.rules?.length);

describe('gateway rate-limit coverage', () => {
  const publicControllers = [AuthController, PublicReelShareController];
  const authenticatedWriteControllers = [
    MediaController,
    FriendController,
    ContentController,
    ReelCommentsGatewayController,
  ];

  it('limits every public mutation and the public share lookup', () => {
    // GET routes on AuthController (me, socket-token) are authenticated reads.
    expect(
      unlimited(
        routesOf(AuthController),
        (route) => route.method !== RequestMethod.GET,
      ).map((route) => route.handler),
    ).toEqual([]);
    expect(
      unlimited(routesOf(PublicReelShareController), () => true).map(
        (route) => route.handler,
      ),
    ).toEqual([]);
  });

  it.each(authenticatedWriteControllers.map((c) => [c.name, c] as const))(
    'limits every write route of %s',
    (_name, controller) => {
      expect(
        unlimited(
          routesOf(controller),
          (route) => route.method !== RequestMethod.GET,
        ).map((route) => route.handler),
      ).toEqual([]);
    },
  );

  it.each(
    [...publicControllers, ...authenticatedWriteControllers].map(
      (c) => [c.name, c] as const,
    ),
  )('%s registers RateLimitGuard at class level', (_name, controller) => {
    expect(classGuards(controller)).toContain(RateLimitGuard);
  });

  it.each(authenticatedWriteControllers.map((c) => [c.name, c] as const))(
    '%s authenticates before it rate-limits by user',
    (_name, controller) => {
      const guards = classGuards(controller);
      expect(guards.indexOf(JwtAuthGuard)).toBeGreaterThanOrEqual(0);
      expect(guards.indexOf(JwtAuthGuard)).toBeLessThan(
        guards.indexOf(RateLimitGuard),
      );
    },
  );

  it('only uses user-keyed rules behind authentication', () => {
    for (const controller of publicControllers) {
      for (const route of routesOf(controller)) {
        for (const rule of route.rules ?? []) {
          expect(rule.by).not.toBe('user');
        }
      }
    }
  });

  it('references only policies that resolve to a positive limit', () => {
    const controllers = [
      ...publicControllers,
      ...authenticatedWriteControllers,
    ];
    for (const controller of controllers) {
      for (const route of routesOf(controller)) {
        for (const rule of route.rules ?? []) {
          const policy = resolveRateLimitPolicy(rule.policy);
          expect(policy.limit).toBeGreaterThan(0);
          expect(policy.windowSeconds).toBeGreaterThan(0);
        }
      }
    }
  });
});
