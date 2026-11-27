import { InvalidResetTokenError } from '@auth/domain/errors/invalid-reset-token.error';
import type { IPasswordResetCodeStore } from '@auth/domain/interfaces/password-reset-code.store.interface';
import type { IUserService } from '@auth/domain/interfaces/user-service.interface';
import { ResetPasswordDto } from '@common/auth/dtos/reset-password.dto';
import { UpdateUserPayload } from '@common/user/interfaces/update-user.types';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ResetPasswordUseCase {
  constructor(
    @Inject('IUserService') private readonly userService: IUserService,
    @Inject('IPasswordResetCodeStore')
    private readonly resetCodes: IPasswordResetCodeStore,
  ) {}

  async execute(dto: ResetPasswordDto) {
    const user = await this.userService.findByEmail(dto.email);
    const isValid =
      user !== null &&
      (await this.resetCodes.check(user.id, dto.token, { consume: true }));

    if (!user || !isValid) {
      throw new InvalidResetTokenError();
    }

    const payload: UpdateUserPayload = {
      id: user.id,
      data: {
        password: dto.newPassword,
      },
    };

    await this.userService.updateUser(payload);

    return { message: 'Password has been reset successfully.' };
  }
}
