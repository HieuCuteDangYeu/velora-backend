import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
import { Inject, Injectable } from '@nestjs/common';
import { normalizeUsername } from '@user/application/utils/public-identity.utils';
import { UsernameNotFoundError } from '@user/domain/errors/username-not-found.error';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';

@Injectable()
export class FindPublicUserByUsernameUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
  ) {}

  async execute(rawUsername: string): Promise<PublicUserProfile> {
    const username = normalizeUsername(rawUsername);
    const user = await this.userRepository.findByUsername(username);

    if (!user || user.status === 'BANNED') {
      throw new UsernameNotFoundError(username);
    }

    return {
      id: user.id!,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture,
      isVerified: user.isVerified,
    };
  }
}
