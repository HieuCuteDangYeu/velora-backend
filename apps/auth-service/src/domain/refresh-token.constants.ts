export const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const REFRESH_SESSION_MAX_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const REFRESH_REQUEST_ID_TTL_MS = 5 * 60 * 1000;

export const getRefreshSessionExpiresAt = (now = new Date()): Date =>
  new Date(now.getTime() + REFRESH_SESSION_MAX_LIFETIME_MS);

export const getRefreshTokenExpiresAt = (
  now: Date,
  absoluteExpiresAt: Date,
): Date =>
  new Date(
    Math.min(now.getTime() + REFRESH_TOKEN_TTL_MS, absoluteExpiresAt.getTime()),
  );

export const getRefreshTokenExpiresInSeconds = (
  now: Date,
  expiresAt: Date,
): number =>
  Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

export const getRefreshRequestExpiresAt = (now = new Date()): Date =>
  new Date(now.getTime() + REFRESH_REQUEST_ID_TTL_MS);
