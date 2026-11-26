import { createHash, generateKeyPairSync, sign } from 'crypto';

import { InvalidAppleTokenError } from '../../domain/errors/invalid-apple-token.error';
import {
  APPLE_ISSUER,
  AppleIdentityTokenVerifier,
} from './apple-identity-token.verifier';

const NOW_MS = Date.UTC(2026, 10, 26, 10, 0, 0);
const NOW_S = NOW_MS / 1000;
const RAW_NONCE = 'raw-nonce-0123456789abcdef';
const HASHED_NONCE = createHash('sha256').update(RAW_NONCE).digest('hex');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const otherPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

const jwk = {
  ...publicKey.export({ format: 'jwk' }),
  kid: 'key-1',
  alg: 'RS256',
  use: 'sig',
};

const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const makeToken = (
  claims: Record<string, unknown> = {},
  options: { kid?: string; alg?: string; key?: typeof privateKey } = {},
) => {
  const header = encode({
    alg: options.alg ?? 'RS256',
    kid: options.kid ?? 'key-1',
  });
  const payload = encode({
    iss: APPLE_ISSUER,
    aud: 'com.quan.velora.dev',
    exp: NOW_S + 600,
    iat: NOW_S - 5,
    sub: '001234.abcdef.1234',
    email: 'User@Privaterelay.AppleID.com',
    email_verified: 'true',
    is_private_email: 'true',
    nonce: HASHED_NONCE,
    ...claims,
  });
  const signature = sign(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    options.key ?? privateKey,
  ).toString('base64url');
  return `${header}.${payload}.${signature}`;
};

const createVerifier = () => {
  const verifier = new AppleIdentityTokenVerifier();
  const fetchKeys = jest.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ keys: [jwk] }),
  });
  verifier.fetchKeys = fetchKeys;
  verifier.now = () => NOW_MS;
  return { verifier, fetchKeys };
};

describe('AppleIdentityTokenVerifier', () => {
  const originalAudiences = process.env.APPLE_SIGN_IN_AUDIENCES;
  afterEach(() => {
    if (originalAudiences === undefined)
      delete process.env.APPLE_SIGN_IN_AUDIENCES;
    else process.env.APPLE_SIGN_IN_AUDIENCES = originalAudiences;
  });

  it('accepts a valid token and returns the verified identity', async () => {
    const { verifier } = createVerifier();

    await expect(verifier.verify(makeToken(), RAW_NONCE)).resolves.toEqual({
      sub: '001234.abcdef.1234',
      email: 'user@privaterelay.appleid.com',
      isPrivateEmail: true,
    });
  });

  it('caches Apple keys between sign-ins', async () => {
    const { verifier, fetchKeys } = createVerifier();

    await verifier.verify(makeToken(), RAW_NONCE);
    await verifier.verify(makeToken(), RAW_NONCE);

    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'a signature from another key',
      () => makeToken({}, { key: otherPair.privateKey }),
    ],
    ['another issuer', () => makeToken({ iss: 'https://accounts.google.com' })],
    ['another audience', () => makeToken({ aud: 'com.example.other' })],
    ['an expired token', () => makeToken({ exp: NOW_S - 120 })],
    ['a token issued in the future', () => makeToken({ iat: NOW_S + 600 })],
    ['a different nonce', () => makeToken({ nonce: 'f'.repeat(64) })],
    ['a missing nonce', () => makeToken({ nonce: undefined })],
    ['an unverified e-mail', () => makeToken({ email_verified: 'false' })],
    ['a missing e-mail', () => makeToken({ email: undefined })],
    ['an unknown key id', () => makeToken({}, { kid: 'key-unknown' })],
    ['another algorithm', () => makeToken({}, { alg: 'HS256' })],
    ['a malformed token', () => 'not-a-jwt'],
  ])('rejects %s', async (_case, token) => {
    const { verifier } = createVerifier();

    await expect(verifier.verify(token(), RAW_NONCE)).rejects.toBeInstanceOf(
      InvalidAppleTokenError,
    );
  });

  it('honours configured audiences', async () => {
    process.env.APPLE_SIGN_IN_AUDIENCES = 'com.example.app, com.example.other';
    const { verifier } = createVerifier();

    await expect(
      verifier.verify(makeToken({ aud: 'com.example.other' }), RAW_NONCE),
    ).resolves.toMatchObject({ sub: '001234.abcdef.1234' });
    await expect(
      verifier.verify(makeToken(), RAW_NONCE),
    ).rejects.toBeInstanceOf(InvalidAppleTokenError);
  });

  it('refreshes keys at most once a minute for unknown key ids', async () => {
    const { verifier, fetchKeys } = createVerifier();

    await verifier.verify(makeToken(), RAW_NONCE);
    await expect(
      verifier.verify(makeToken({}, { kid: 'key-unknown' }), RAW_NONCE),
    ).rejects.toBeInstanceOf(InvalidAppleTokenError);
    await expect(
      verifier.verify(makeToken({}, { kid: 'key-unknown' }), RAW_NONCE),
    ).rejects.toBeInstanceOf(InvalidAppleTokenError);

    expect(fetchKeys).toHaveBeenCalledTimes(1);
  });

  it('rejects every token when Apple keys cannot be fetched', async () => {
    const verifier = new AppleIdentityTokenVerifier();
    verifier.fetchKeys = jest.fn().mockRejectedValue(new Error('offline'));
    verifier.now = () => NOW_MS;

    await expect(
      verifier.verify(makeToken(), RAW_NONCE),
    ).rejects.toBeInstanceOf(InvalidAppleTokenError);
  });
});
