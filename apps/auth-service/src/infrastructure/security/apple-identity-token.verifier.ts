import { Injectable, Logger } from '@nestjs/common';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'crypto';
import type { JsonWebKey, KeyObject } from 'crypto';

import { InvalidAppleTokenError } from '../../domain/errors/invalid-apple-token.error';

export const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_KEYS_URL = 'https://appleid.apple.com/auth/keys';
/** The app's bundle id; Apple puts it in `aud` for native Sign in with Apple. */
const DEFAULT_APPLE_AUDIENCES = ['com.quan.velora.dev'];
const KEYS_TTL_MS = 24 * 60 * 60 * 1000;
const KEYS_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const KEYS_FETCH_TIMEOUT_MS = 5_000;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_LENGTH = 8_192;

export interface AppleIdentity {
  /** Apple's stable, app-scoped user identifier. */
  sub: string;
  email: string;
  isPrivateEmail: boolean;
}

type AppleJwk = JsonWebKey & { kid?: string; alg?: string };

type FetchLike = (
  url: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Verifies the identity token returned by native Sign in with Apple:
 * RS256 signature against Apple's published keys, issuer, audience (the
 * bundle id), expiry, and the nonce the app asked Apple to embed, so a token
 * captured from another sign-in cannot be replayed here.
 */
@Injectable()
export class AppleIdentityTokenVerifier {
  private readonly logger = new Logger(AppleIdentityTokenVerifier.name);
  private keys = new Map<string, KeyObject>();
  private keysFetchedAt = 0;
  private lastFetchAttemptAt = 0;

  /** Replaced in tests; Nest must see a constructor without parameters. */
  fetchKeys: FetchLike = (url, init) => fetch(url, init);
  now: () => number = () => Date.now();

  async verify(
    identityToken: string,
    rawNonce: string,
  ): Promise<AppleIdentity> {
    if (identityToken.length > MAX_TOKEN_LENGTH)
      throw new InvalidAppleTokenError();
    const parts = identityToken.split('.');
    if (parts.length !== 3) throw new InvalidAppleTokenError();
    const [encodedHeader, encodedPayload, encodedSignature] = parts;

    const header = this.decodeJson(encodedHeader);
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
      throw new InvalidAppleTokenError();
    }

    const key = await this.keyFor(header.kid);
    const signatureValid = verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      key,
      Buffer.from(encodedSignature, 'base64url'),
    );
    if (!signatureValid) throw new InvalidAppleTokenError();

    const claims = this.decodeJson(encodedPayload);
    const nowSeconds = Math.floor(this.now() / 1000);
    const audiences = this.audiences();

    if (claims.iss !== APPLE_ISSUER) throw new InvalidAppleTokenError();
    if (typeof claims.aud !== 'string' || !audiences.includes(claims.aud)) {
      throw new InvalidAppleTokenError();
    }
    if (
      typeof claims.exp !== 'number' ||
      claims.exp + CLOCK_SKEW_SECONDS < nowSeconds
    ) {
      throw new InvalidAppleTokenError();
    }
    if (
      typeof claims.iat === 'number' &&
      claims.iat - CLOCK_SKEW_SECONDS > nowSeconds
    ) {
      throw new InvalidAppleTokenError();
    }
    if (!this.nonceMatches(claims.nonce, rawNonce))
      throw new InvalidAppleTokenError();
    if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
      throw new InvalidAppleTokenError();
    }
    // An account is found by e-mail, so only an address Apple has verified may
    // be trusted. Relay addresses (Hide My Email) are verified as well.
    if (
      typeof claims.email !== 'string' ||
      !this.isTrue(claims.email_verified)
    ) {
      throw new InvalidAppleTokenError();
    }

    return {
      sub: claims.sub,
      email: claims.email.toLowerCase(),
      isPrivateEmail: this.isTrue(claims.is_private_email),
    };
  }

  private audiences(): string[] {
    const configured = (process.env.APPLE_SIGN_IN_AUDIENCES ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return configured.length > 0 ? configured : DEFAULT_APPLE_AUDIENCES;
  }

  /** The app sends Apple sha256(rawNonce) in hex and sends rawNonce here. */
  private nonceMatches(claim: unknown, rawNonce: string): boolean {
    if (typeof claim !== 'string' || !rawNonce) return false;
    const expected = Buffer.from(
      createHash('sha256').update(rawNonce).digest('hex'),
    );
    const actual = Buffer.from(claim);
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }

  private isTrue(value: unknown): boolean {
    return value === true || value === 'true';
  }

  private decodeJson(segment: string): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(
        Buffer.from(segment, 'base64url').toString('utf8'),
      );
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Fall through to the uniform rejection below.
    }
    throw new InvalidAppleTokenError();
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const fresh = this.now() - this.keysFetchedAt < KEYS_TTL_MS;
    const cached = this.keys.get(kid);
    if (cached && fresh) return cached;

    // Apple rotates keys; an unknown kid triggers one refresh, rate-limited so
    // forged tokens cannot make this service hammer Apple.
    if (
      !fresh ||
      this.now() - this.lastFetchAttemptAt >= KEYS_REFRESH_MIN_INTERVAL_MS
    ) {
      await this.refreshKeys();
    }
    const key = this.keys.get(kid);
    if (!key) throw new InvalidAppleTokenError();
    return key;
  }

  private async refreshKeys() {
    this.lastFetchAttemptAt = this.now();
    try {
      const response = await this.fetchKeys(APPLE_KEYS_URL, {
        signal: AbortSignal.timeout(KEYS_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`status ${response.status}`);
      const body = (await response.json()) as { keys?: AppleJwk[] };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (typeof jwk.kid !== 'string' || jwk.kty !== 'RSA') continue;
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
      if (next.size === 0) throw new Error('no RSA keys');
      this.keys = next;
      this.keysFetchedAt = this.now();
    } catch (error) {
      // Keep any previous keys; a token signed with them still verifies.
      this.logger.warn(
        `Could not refresh Apple sign-in keys: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }
}
