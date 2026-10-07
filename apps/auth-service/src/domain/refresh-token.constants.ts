export const REFRESH_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const REFRESH_REQUEST_ID_TTL_MS = 5 * 60 * 1000;

export const getRefreshTokenExpiresAt = (now = new Date()): Date =>
  new Date(now.getTime() + REFRESH_TOKEN_TTL_MS);

export const getRefreshTokenExpiresInSeconds = (
  now: Date,
  expiresAt: Date,
): number =>
  Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / 1000));

export const getRefreshRequestExpiresAt = (now = new Date()): Date =>
  new Date(now.getTime() + REFRESH_REQUEST_ID_TTL_MS);
