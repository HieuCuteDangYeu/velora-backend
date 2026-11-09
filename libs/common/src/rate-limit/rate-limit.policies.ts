import type { RateLimitPolicy } from './rate-limit.types';

type PolicyDefaults = Omit<RateLimitPolicy, 'name'>;

const MINUTE = 60;
const HOUR = 3_600;
const DAY = 86_400;

/**
 * Starting policies. Every value can be overridden without a deploy of code:
 *   RATE_LIMIT_<NAME>_LIMIT, RATE_LIMIT_<NAME>_WINDOW_SECONDS
 * (e.g. RATE_LIMIT_AUTH_LOGIN_IP_LIMIT=20). `RATE_LIMIT_ENABLED=false` is the kill switch.
 *
 * `*_ip` policies cover public endpoints and are the strictest. `*_account`
 * policies are keyed on a hash of the submitted identifier so a botnet that
 * rotates IPs still cannot hammer one account or mailbox.
 */
export const DEFAULT_RATE_LIMIT_POLICIES = {
  // Public auth endpoints
  auth_login_ip: { limit: 10, windowSeconds: MINUTE, onStoreFailure: 'local' },
  auth_login_account: {
    limit: 5,
    windowSeconds: 5 * MINUTE,
    onStoreFailure: 'local',
  },
  auth_register_ip: { limit: 10, windowSeconds: HOUR, onStoreFailure: 'local' },
  auth_google_ip: { limit: 20, windowSeconds: MINUTE, onStoreFailure: 'local' },
  auth_refresh_ip: {
    limit: 60,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  auth_logout_ip: { limit: 30, windowSeconds: MINUTE, onStoreFailure: 'allow' },
  auth_confirm_ip: {
    limit: 10,
    windowSeconds: 5 * MINUTE,
    onStoreFailure: 'local',
  },
  auth_resend_ip: {
    limit: 5,
    windowSeconds: 10 * MINUTE,
    onStoreFailure: 'local',
  },
  auth_resend_account: {
    limit: 3,
    windowSeconds: HOUR,
    onStoreFailure: 'local',
  },
  auth_forgot_ip: {
    limit: 5,
    windowSeconds: 10 * MINUTE,
    onStoreFailure: 'local',
  },
  auth_forgot_account: {
    limit: 3,
    windowSeconds: HOUR,
    onStoreFailure: 'local',
  },
  auth_reset_ip: {
    limit: 10,
    windowSeconds: 10 * MINUTE,
    onStoreFailure: 'local',
  },
  // Public, unauthenticated share-link resolution
  public_share_ip: {
    limit: 60,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  // Authenticated routes, keyed per user. `local` marks paths that are costly or
  // spam-prone; the rest simply let traffic through if Redis is unreachable.
  media_upload_url_user: {
    limit: 30,
    windowSeconds: 10 * MINUTE,
    onStoreFailure: 'local',
  },
  media_finalize_user: {
    limit: 30,
    windowSeconds: 10 * MINUTE,
    onStoreFailure: 'allow',
  },
  content_publish_user: {
    limit: 20,
    windowSeconds: HOUR,
    onStoreFailure: 'local',
  },
  content_write_user: {
    limit: 60,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  content_share_user: {
    limit: 30,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  // Clients batch interaction events, so this is deliberately generous.
  content_events_user: {
    limit: 120,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  content_comment_user: {
    limit: 30,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  friend_request_user: {
    limit: 30,
    windowSeconds: HOUR,
    onStoreFailure: 'local',
  },
  friend_write_user: {
    limit: 60,
    windowSeconds: MINUTE,
    onStoreFailure: 'allow',
  },
  // RAG / AI. The per-user AI-reply budget is enforced in conversation-service, where
  // every path (WebSocket send_message and REST create_message) converges.
  ai_turn_minute: { limit: 10, windowSeconds: MINUTE, onStoreFailure: 'local' },
  ai_turn_day: { limit: 300, windowSeconds: DAY, onStoreFailure: 'local' },
} as const satisfies Record<string, PolicyDefaults>;

export type RateLimitPolicyName = keyof typeof DEFAULT_RATE_LIMIT_POLICIES;

export interface RateLimitConfigReader {
  get<T = string>(key: string): T | undefined;
}

function positiveInt(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveRateLimitPolicy(
  name: RateLimitPolicyName,
  config?: RateLimitConfigReader,
): RateLimitPolicy {
  const defaults = DEFAULT_RATE_LIMIT_POLICIES[name];
  const prefix = `RATE_LIMIT_${name.toUpperCase()}`;
  return {
    name,
    limit: positiveInt(config?.get(`${prefix}_LIMIT`)) ?? defaults.limit,
    windowSeconds:
      positiveInt(config?.get(`${prefix}_WINDOW_SECONDS`)) ??
      defaults.windowSeconds,
    onStoreFailure: defaults.onStoreFailure,
  };
}
