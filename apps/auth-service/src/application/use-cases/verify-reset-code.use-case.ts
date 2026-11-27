import { InvalidResetTokenError } from '@auth/domain/errors/invalid-reset-token.error';
import type { IPasswordResetCodeStore } from '@auth/domain/interfaces/password-reset-code.store.interface';
import type { IUserService } from '@auth/domain/interfaces/user-service.interface';
import { VerifyResetCodeDto } from '@common/auth/dtos/verify-reset-code.dto';
import { Inject, Injectable } from '@nestjs/common';

/**
 * Checks a reset code without consuming it, so the client can confirm the code
 * before asking for a new password. ResetPasswordUseCase still consumes it.
 * Wrong guesses here count against the same attempt cap.
 */
@Injectable()
export class VerifyResetCodeUseCase {
  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IPasswordResetCodeStore')
    private readonly resetCodes: IPasswordResetCodeStore,
  ) {}

  async execute(dto: VerifyResetCodeDto) {
    const user = await this.userService.findByEmail(dto.email);
    const isValid =
      user !== null &&
      (await this.resetCodes.check(user.id, dto.token, { consume: false }));

    if (!isValid) {
      throw new InvalidResetTokenError();
    }

    return { message: 'Reset code verified.' };
  }
}
