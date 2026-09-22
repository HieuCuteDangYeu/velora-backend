import { UpdateAvatarDto } from '@common/user/dtos/update-avatar.dto';
import { Inject, Injectable } from '@nestjs/common';
import { InvalidAvatarFileError } from '@user/domain/errors/invalid-avatar-file.error';
import { UserNotFoundError } from '@user/domain/errors/user-not-found.error';
import type { IStorageService } from '../../domain/interfaces/storage.service.interface';
import type { IUserRepository } from '../../domain/interfaces/user.repository.interface';
import { UserPrometheusMetricsService } from '../../infrastructure/metrics/user-prometheus-metrics.service';

@Injectable()
export class UpdateUserAvatarUseCase {
  constructor(
    @Inject('IUserRepository') private readonly userRepository: IUserRepository,
    @Inject('IStorageService') private readonly storageService: IStorageService,
    private readonly metrics: UserPrometheusMetricsService,
  ) {}

  async execute(userId: string, payload: UpdateAvatarDto) {
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new UserNotFoundError(userId);
    }

    let fileExists: boolean;
    try {
      fileExists = await this.storageService.checkFileExists(payload.avatarKey);
      this.metrics.recordStorage('success');
    } catch (error) {
      this.metrics.recordStorage('error');
      throw error;
    }

    if (!fileExists) {
      throw new InvalidAvatarFileError();
    }

    const updatedEntity = await this.userRepository.update(userId, {
      picture: payload.avatarKey,
    });

    return {
      id: updatedEntity.id,
      email: updatedEntity.email,
      picture: updatedEntity.picture,
    };
  }
}
