import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import type { IUserService } from '@auth/domain/interfaces/user-service.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class UnbanUserUseCase {
  constructor(
    @Inject('IBanList') private readonly banList: IBanList,
    @Inject('IUserService') private readonly userService: IUserService,
  ) {}

  async execute(userId: string): Promise<void> {
    await this.banList.unban(userId);
    await this.userService.invalidateCachedUser(userId);
  }
}
