import { LoginDto } from '@common/auth/dtos/login.dto';
import { Inject, Injectable } from '@nestjs/common';
import type { IUserRepository } from '@user/domain/interfaces/user.repository.interface';
import * as bcrypt from 'bcrypt';

@Injectable()
export class ValidateUserUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {}

  async execute(dto: LoginDto) {
    const user = await this.userRepository.findByEmail(dto.email);

    if (!user) return null;

    if (!user.password) return null;

    const isValid = await bcrypt.compare(dto.password, user.password);
    if (!isValid) return null;

    return {
      id: user.id,
      email: user.email,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture,
      isVerified: user.isVerified,
      status: user.status,
    };
  }
}
