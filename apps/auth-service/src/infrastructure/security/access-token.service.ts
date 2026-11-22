import {
  type AccessClaims,
  type AccessKeyPair,
  type AccessPublicKey,
  deriveAccessKeyPair,
  signAccessToken,
  toPublicKeyObjects,
  type VerifiedAccessToken,
  verifyAccessToken,
} from '@common/auth/access-token';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { KeyObject } from 'node:crypto';

@Injectable()
export class AccessTokenService {
  private readonly keys: AccessKeyPair;
  private readonly keyObjects: Map<string, KeyObject>;

  constructor(config: ConfigService) {
    this.keys = deriveAccessKeyPair(config.getOrThrow<string>('JWT_SECRET'));
    this.keyObjects = toPublicKeyObjects([this.keys.publicKey]);
  }

  sign(claims: AccessClaims): string {
    return signAccessToken(this.keys, claims);
  }

  verify(token: string): VerifiedAccessToken {
    return verifyAccessToken(token, this.keyObjects);
  }

  publicKeys(): AccessPublicKey[] {
    return [this.keys.publicKey];
  }
}
