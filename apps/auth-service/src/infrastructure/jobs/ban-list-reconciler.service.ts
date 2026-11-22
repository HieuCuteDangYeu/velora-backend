import type { IBanList } from '@auth/domain/interfaces/ban-list.interface';
import type { IUserService } from '@auth/domain/interfaces/user-service.interface';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';

/**
 * The user database is the source of truth for bans; Redis is the fast copy the gateway
 * reads on every request. If Redis loses its data (restart without persistence, flush), this
 * puts the missing entries back, so a ban is never silently forgotten for longer than a minute.
 */
@Injectable()
export class BanListReconciler implements OnApplicationBootstrap {
  private readonly logger = new Logger(BanListReconciler.name);

  constructor(
    @Inject('IBanList') private readonly banList: IBanList,
    @Inject('IUserService') private readonly userService: IUserService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.reconcile();
  }

  @Interval(60_000)
  async reconcile(): Promise<void> {
    try {
      const bannedIds = await this.userService.listBannedIds();
      let restored = 0;
      for (const userId of bannedIds) {
        if (await this.banList.ensureBanned(userId)) restored += 1;
      }
      if (restored > 0) {
        this.logger.warn(`Restored ${restored} missing ban list entries`);
      }
    } catch (error) {
      this.logger.warn(
        `Ban list reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
