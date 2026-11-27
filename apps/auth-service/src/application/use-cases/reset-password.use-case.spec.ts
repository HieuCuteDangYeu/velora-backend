import { InvalidResetTokenError } from '@auth/domain/errors/invalid-reset-token.error';
import { ResetPasswordUseCase } from './reset-password.use-case';

describe('ResetPasswordUseCase', () => {
  const dto = {
    email: 'alice@example.com',
    token: '123456',
    newPassword: 'NewPassword123!',
  };

  const setup = (
    user: { id: string } | null,
    isValid: boolean,
  ) => {
    const findByEmail = jest.fn().mockResolvedValue(user);
    const updateUser = jest.fn().mockResolvedValue(undefined);
    const check = jest.fn().mockResolvedValue(isValid);
    const useCase = new ResetPasswordUseCase(
      { findByEmail, updateUser } as any,
      { check } as any,
    );
    return { useCase, findByEmail, updateUser, check };
  };

  it('consumes the code of the account named by the email before updating its password', async () => {
    const { useCase, findByEmail, updateUser, check } = setup(
      { id: 'alice-id' },
      true,
    );

    await expect(useCase.execute(dto)).resolves.toEqual({
      message: 'Password has been reset successfully.',
    });

    expect(findByEmail).toHaveBeenCalledWith('alice@example.com');
    expect(check).toHaveBeenCalledWith('alice-id', '123456', { consume: true });
    expect(updateUser).toHaveBeenCalledWith({
      id: 'alice-id',
      data: { password: 'NewPassword123!' },
    });
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(
      updateUser.mock.invocationCallOrder[0],
    );
  });

  it('rejects a code that is not the live code for that email', async () => {
    const { useCase, updateUser } = setup({ id: 'alice-id' }, false);

    await expect(useCase.execute(dto)).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    );
    expect(updateUser).not.toHaveBeenCalled();
  });

  it('rejects an unknown email the same way, without checking any code', async () => {
    const { useCase, updateUser, check } = setup(null, true);

    await expect(useCase.execute(dto)).rejects.toBeInstanceOf(
      InvalidResetTokenError,
    );
    expect(check).not.toHaveBeenCalled();
    expect(updateUser).not.toHaveBeenCalled();
  });
});
