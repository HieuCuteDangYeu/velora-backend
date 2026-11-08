import { SetMetadata } from '@nestjs/common';
import type { RateLimitPolicyName } from './rate-limit.policies';

/**
 * What the bucket is keyed on.
 * - `ip`: the client address (use before authentication, on public endpoints).
 * - `user`: the authenticated user id; falls back to IP if no user is attached,
 *   so a mis-ordered guard fails safe instead of skipping the limit.
 * - `{ body }`: a hash of a request-body field (e.g. the email being attacked),
 *   so rotating IPs cannot target a single account or mailbox.
 */
export type RateLimitSubject = 'ip' | 'user' | { body: string };

export interface RateLimitRule {
  policy: RateLimitPolicyName;
  by: RateLimitSubject;
}

export const RATE_LIMIT_RULES = 'rate_limit_rules';

/** Rules are evaluated in order and the first denial rejects the request. */
export const RateLimit = (...rules: RateLimitRule[]) =>
  SetMetadata(RATE_LIMIT_RULES, rules);
