import {
  createECDH,
  createHash,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  sign,
  verify,
  type JsonWebKey,
  type KeyObject,
} from 'node:crypto';
import type { JwtPayload } from './interfaces/jwt-payload.interface';

/**
 * Access tokens are ES256 JWTs. Auth-service derives the signing key from JWT_SECRET (no new
 * secret to manage) and publishes only the public half, so the gateway can check a token
 * locally without being able to forge one. Refresh tokens stay HS256 and never leave
 * auth-service.
 */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Redis key written by auth-service when a user is banned; the gateway reads it per request. */
export const BANNED_USER_KEY_PREFIX = 'auth:banned:';
export const bannedUserKey = (userId: string) =>
  `${BANNED_USER_KEY_PREFIX}${userId}`;

export interface AccessPublicKey {
  kid: string;
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}

export interface AccessKeyPair {
  kid: string;
  privateKey: KeyObject;
  publicKey: AccessPublicKey;
}

export type AccessClaims = Omit<JwtPayload, 'tokenType'> & {
  roles: string[];
};

export type VerifiedAccessToken =
  | { ok: true; payload: JwtPayload & { roles?: string[]; exp: number } }
  | {
      ok: false;
      reason:
        | 'format'
        | 'algorithm'
        | 'unknown_key'
        | 'signature'
        | 'expired'
        | 'type';
    };

const b64u = (value: Buffer | string) =>
  Buffer.from(value).toString('base64url');

export function deriveAccessKeyPair(secret: string): AccessKeyPair {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const d = Buffer.from(
      hkdfSync(
        'sha256',
        secret,
        'velora-access-token-v1',
        `es256:${attempt}`,
        32,
      ),
    );
    const ecdh = createECDH('prime256v1');
    try {
      ecdh.setPrivateKey(d);
    } catch {
      continue; // scalar outside the curve order: astronomically rare, try the next derivation
    }
    const point = ecdh.getPublicKey();
    const jwk = {
      kty: 'EC' as const,
      crv: 'P-256' as const,
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33, 65)),
    };
    return {
      kid: createHash('sha256').update(point).digest('hex').slice(0, 16),
      privateKey: createPrivateKey({
        key: { ...jwk, d: b64u(d) } as JsonWebKey,
        format: 'jwk',
      }),
      publicKey: {
        kid: createHash('sha256').update(point).digest('hex').slice(0, 16),
        jwk,
      },
    };
  }
  throw new Error('Could not derive an access-token signing key');
}

export function signAccessToken(
  keys: AccessKeyPair,
  claims: AccessClaims,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  const header = b64u(
    JSON.stringify({ alg: 'ES256', typ: 'JWT', kid: keys.kid }),
  );
  const body = b64u(
    JSON.stringify({
      ...claims,
      tokenType: 'access',
      iat: nowSeconds,
      exp: nowSeconds + ACCESS_TOKEN_TTL_SECONDS,
    }),
  );
  const signature = sign('sha256', Buffer.from(`${header}.${body}`), {
    key: keys.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${header}.${body}.${b64u(signature)}`;
}

export function toPublicKeyObjects(
  keys: readonly AccessPublicKey[],
): Map<string, KeyObject> {
  return new Map(
    keys.map((key) => [
      key.kid,
      createPublicKey({ key: key.jwk as JsonWebKey, format: 'jwk' }),
    ]),
  );
}

/** Pure check: signature, expiry and token type. It knows nothing about bans or deletions. */
export function verifyAccessToken(
  token: string,
  publicKeys: ReadonlyMap<string, KeyObject>,
  nowSeconds = Math.floor(Date.now() / 1000),
): VerifiedAccessToken {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'format' };

  let header: { alg?: unknown; kid?: unknown };
  let payload: VerifiedAccessTokenPayload;
  try {
    header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as { alg?: unknown; kid?: unknown };
    payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as VerifiedAccessTokenPayload;
  } catch {
    return { ok: false, reason: 'format' };
  }
  if (header.alg !== 'ES256') return { ok: false, reason: 'algorithm' };

  const key =
    typeof header.kid === 'string' ? publicKeys.get(header.kid) : undefined;
  if (!key) return { ok: false, reason: 'unknown_key' };

  const valid = verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  );
  if (!valid) return { ok: false, reason: 'signature' };
  if (typeof payload.exp !== 'number' || payload.exp <= nowSeconds)
    return { ok: false, reason: 'expired' };
  if (payload.tokenType !== 'access' || typeof payload.sub !== 'string')
    return { ok: false, reason: 'type' };

  return { ok: true, payload: payload };
}

type VerifiedAccessTokenPayload = JwtPayload & {
  roles?: string[];
  exp: number;
};
