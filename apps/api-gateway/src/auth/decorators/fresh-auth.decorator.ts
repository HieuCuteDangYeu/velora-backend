import { SetMetadata } from '@nestjs/common';

export const FRESH_AUTH_KEY = 'freshAuth';

/**
 * The route needs the current user record, not the claims inside the token (for example
 * `/auth/me` after a profile edit). The guard then asks auth-service on every request.
 */
export const FreshAuth = () => SetMetadata(FRESH_AUTH_KEY, true);
