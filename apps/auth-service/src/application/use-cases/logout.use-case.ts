import { Inject, Injectable } from '@nestjs/common';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
  ) {}

  async execute(token: string): Promise<{ message: string; userId?: string }> {
    const storedToken = await this.authRepository.findRefreshToken(token);

    if (storedToken) {
      await this.authRepository.updateRefreshToken(storedToken.id, {
        revoked: true,
      });

      return {
        message: 'Logged out successfully',
        userId: storedToken.userId ?? undefined,
      };
    }

    return { message: 'Logged out successfully' };
  }
}
