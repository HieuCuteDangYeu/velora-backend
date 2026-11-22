import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable } from '@nestjs/common';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

@Injectable()
export class FindUserByIdUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {}

  async execute(id: string): Promise<ValidateUserResponse | null> {
    const user = await this.userRepository.findById(id);

    if (!user) return null;

    return {
      id: user.id!,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      isVerified: user.isVerified,
      status: user.status,
      password: user.password,
      picture: user.picture,
      provider: user.provider,
      providerId: user.providerId,
    };
  }
}
