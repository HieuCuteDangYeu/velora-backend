import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, lastValueFrom, of, timeout } from 'rxjs';
import { ConversationPrometheusMetricsService } from '../metrics/conversation-prometheus-metrics.service';
import { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class UserServiceAdapter implements IUserService {
  private readonly logger = new Logger(UserServiceAdapter.name);
  private readonly participantLookups = new Map<
    string,
    Promise<ValidateUserResponse | null>
  >();

  constructor(
    @Inject('USER_SERVICE_RMQ') private readonly client: ClientProxy,
    private readonly metrics?: ConversationPrometheusMetricsService,
  ) {}

  async validateUsers(ids: string[]): Promise<boolean> {
    return lastValueFrom(
      this.client
        .send<boolean>('user.validate_list', { ids }) // 👈 Gọi đúng Pattern mới
        .pipe(
          timeout(5000), // Quá 5s thì tự cắt
          catchError((err: unknown) => {
            const error = err as Error;
            this.logger.error(`RPC Error [validateUsers]: ${error.message}`);
            return of(false); // Lỗi thì trả về false (An toàn)
          }),
        ),
      { defaultValue: false },
    );
  }

  findUsersByIds(ids: string[]): Promise<ValidateUserResponse | null> {
    const uniqueIds = [...new Set(ids)].sort();
    const key = JSON.stringify(uniqueIds);
    const pending = this.participantLookups.get(key);
    if (pending) return pending;

    const lookup = this.loadParticipants(uniqueIds).finally(() => {
      this.participantLookups.delete(key);
    });
    this.participantLookups.set(key, lookup);
    return lookup;
  }

  // Share only concurrent profile hydration. Completed results are never cached;
  // membership checks and token verification do not use this map.
  private async loadParticipants(
    ids: string[],
  ): Promise<ValidateUserResponse | null> {
    const request = () =>
      lastValueFrom(
        this.client
          .send<ValidateUserResponse | null>('user.find_by_ids', ids)
          .pipe(timeout(5000)),
        { defaultValue: null },
      );
    try {
      return await (this.metrics
        ? this.metrics.measurePhase('user_lookup', request)
        : request());
    } catch {
      this.logger.warn('User lookup RPC unavailable');
      return null;
    }
  }
}
