import { InvalidAppleTokenError } from '../../domain/errors/invalid-apple-token.error';
import { VerifyAppleTokenUseCase } from './verify-apple-token.use-case';

describe('VerifyAppleTokenUseCase', () => {
  const tokens = { accessToken: 'access', refreshToken: 'refresh' };

  const setup = () => {
    const verifier = {
      verify: jest.fn().mockResolvedValue({
        sub: 'apple-sub',
        email: 'user@privaterelay.appleid.com',
        isPrivateEmail: true,
      }),
    };
    const socialLogin = { execute: jest.fn().mockResolvedValue(tokens) };
    const useCase = new VerifyAppleTokenUseCase(
      verifier as never,
      socialLogin as never,
    );
    return { verifier, socialLogin, useCase };
  };

  it('signs in with the verified e-mail and Apple subject', async () => {
    const { verifier, socialLogin, useCase } = setup();

    await expect(
      useCase.execute({
        identityToken: 'token',
        nonce: 'raw-nonce-0123456789',
        fullName: '  Quan Le  ',
      }),
    ).resolves.toBe(tokens);

    expect(verifier.verify).toHaveBeenCalledWith(
      'token',
      'raw-nonce-0123456789',
    );
    expect(socialLogin.execute).toHaveBeenCalledWith({
      email: 'user@privaterelay.appleid.com',
      fullName: 'Quan Le',
      provider: 'apple',
      providerId: 'apple-sub',
    });
  });

  it('omits an empty name', async () => {
    const { socialLogin, useCase } = setup();

    await useCase.execute({
      identityToken: 'token',
      nonce: 'raw-nonce-0123456789',
      fullName: '   ',
    });

    expect(socialLogin.execute).toHaveBeenCalledWith(
      expect.objectContaining({ fullName: undefined }),
    );
  });

  it('never signs in when the token is rejected', async () => {
    const { verifier, socialLogin, useCase } = setup();
    verifier.verify.mockRejectedValue(new InvalidAppleTokenError());

    await expect(
      useCase.execute({ identityToken: 'bad', nonce: 'raw-nonce-0123456789' }),
    ).rejects.toBeInstanceOf(InvalidAppleTokenError);
    expect(socialLogin.execute).not.toHaveBeenCalled();
  });
});
