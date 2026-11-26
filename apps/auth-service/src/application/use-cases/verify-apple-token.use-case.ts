import { AppleIdentityTokenVerifier } from '@auth/infrastructure/security/apple-identity-token.verifier';
import { GoogleProfile } from '@common/auth/interfaces/google-profile.interface';
import { Injectable } from '@nestjs/common';
import { GoogleLoginUseCase } from './google-login.use-case';

/**
 * Sign in with Apple for the mobile app. Apple shares the user's name only on
 * the very first authorization and only with the app, so the app forwards it;
 * the e-mail comes from the verified token, never from the client.
 */
@Injectable()
export class VerifyAppleTokenUseCase {
  constructor(
    private readonly verifier: AppleIdentityTokenVerifier,
    private readonly socialLogin: GoogleLoginUseCase,
  ) {}

  async execute(input: {
    identityToken: string;
    nonce: string;
    fullName?: string;
  }) {
    const identity = await this.verifier.verify(
      input.identityToken,
      input.nonce,
    );
    const fullName = input.fullName?.trim() || undefined;

    const profile: GoogleProfile = {
      email: identity.email,
      fullName,
      provider: 'apple',
      providerId: identity.sub,
    };

    return this.socialLogin.execute(profile);
  }
}
