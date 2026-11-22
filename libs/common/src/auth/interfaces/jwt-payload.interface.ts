export interface JwtPayload {
  sub: string;
  tokenType?: 'access' | 'refresh';
  jti?: string;
  email: string;
  fullName?: string;
  username?: string | null;
  picture?: string;
  isVerified?: boolean;
  /** Access tokens only: roles at issue time. Admin tokens are always re-checked live. */
  roles?: string[];
}
