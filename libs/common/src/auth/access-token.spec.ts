import {
  deriveAccessKeyPair,
  signAccessToken,
  toPublicKeyObjects,
  verifyAccessToken,
} from './access-token';

describe('access token (ES256, derived from JWT_SECRET)', () => {
  const secret = 'x'.repeat(40);
  const keys = deriveAccessKeyPair(secret);
  const publicKeys = toPublicKeyObjects([keys.publicKey]);
  const claims = { sub: 'u1', email: 'a@b.c', roles: ['USER'] };

  it('derives the same key from the same secret and a different one otherwise', () => {
    expect(deriveAccessKeyPair(secret).kid).toBe(keys.kid);
    expect(deriveAccessKeyPair('y'.repeat(40)).kid).not.toBe(keys.kid);
  });

  it('verifies a token with only the public key', () => {
    const result = verifyAccessToken(signAccessToken(keys, claims), publicKeys);
    expect(result).toMatchObject({
      ok: true,
      payload: { sub: 'u1', roles: ['USER'] },
    });
  });

  it('rejects an expired token', () => {
    const token = signAccessToken(keys, claims, 1_000);
    expect(verifyAccessToken(token, publicKeys, 1_000 + 15 * 60)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a tampered payload', () => {
    const [h, , s] = signAccessToken(keys, claims).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        sub: 'admin',
        roles: ['ADMIN'],
        tokenType: 'access',
        exp: 9_999_999_999,
      }),
    ).toString('base64url');
    expect(verifyAccessToken(`${h}.${forged}.${s}`, publicKeys)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('rejects a token signed by another secret', () => {
    const other = deriveAccessKeyPair('y'.repeat(40));
    expect(
      verifyAccessToken(signAccessToken(other, claims), publicKeys),
    ).toEqual({
      ok: false,
      reason: 'unknown_key',
    });
  });

  it('rejects other algorithms, including alg=none and HS256', () => {
    const body = Buffer.from(
      JSON.stringify({ sub: 'u1', exp: 9_999_999_999, tokenType: 'access' }),
    ).toString('base64url');
    for (const alg of ['none', 'HS256']) {
      const header = Buffer.from(
        JSON.stringify({ alg, kid: keys.kid }),
      ).toString('base64url');
      expect(verifyAccessToken(`${header}.${body}.`, publicKeys)).toMatchObject(
        { ok: false, reason: 'algorithm' },
      );
    }
    expect(verifyAccessToken('not-a-token', publicKeys)).toMatchObject({
      ok: false,
      reason: 'format',
    });
  });
});
