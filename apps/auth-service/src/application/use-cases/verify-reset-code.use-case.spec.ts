import { InvalidResetTokenError } from '@auth/domain/errors/invalid-reset-token.error';
import { VerifyResetCodeUseCase } from './verify-reset-code.use-case';

describe('VerifyResetCodeUseCase', () => {
  const dto = { email: 'alice@example.com', token: '123456' };

  it('accepts the live code for that email without consuming it', async () => {
    const check = jest.fn().mockResolvedValue(true);
    const useCase = new VerifyResetCodeUseCase(
      { findByEmail: jest.fn().mockResolvedValue({ id: 'alice-id' }) } as any,
      { check } as any,
    );

    await expect(useCase.execute(dto)).resolves.toEqual({
      message: 'Reset code verified.',
    });
    expect(check).toHaveBeenCalledWith('alice-id', '123456', {
      consume: false,
    });
  });

  it('rejects a wrong or expired code', async () => {
    const useCase = new VerifyResetCodeUseCase(
      { findByEmail: jest.fn().mockResolvedValue({ id: 'alice-id' }) } as any,
      { check: jest.fn().mockResolvedValue(false) } as any,
    );

    await expect(useCase.execute(dto)).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    );
  });

  it('rejects an unknown email', async () => {
    const check = jest.fn();
    const useCase = new VerifyResetCodeUseCase(
      { findByEmail: jest.fn().mockResolvedValue(null) } as any,
      { check } as any,
    );

    await expect(useCase.execute(dto)).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    );
    expect(check).not.toHaveBeenCalled();
  });
});
