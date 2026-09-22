import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { IAuthRepository } from '../../domain/interfaces/auth.repository.interface';
import { AuthPrometheusMetricsService } from '../metrics/auth-prometheus-metrics.service';

@Injectable()
export class TokenCleanupService {
  private readonly logger = new Logger(TokenCleanupService.name);

  constructor(
    @Inject('IAuthRepository') private readonly authRepository: IAuthRepository,
    private readonly metrics: AuthPrometheusMetricsService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleCleanup() {
    this.logger.log('Starting scheduled cleanup of expired refresh tokens...');
    const startedAt = process.hrtime.bigint();

    try {
      const count = await this.authRepository.deleteExpiredAndRevokedTokens();
      this.metrics.recordCleanup(
        'success',
        this.elapsedSeconds(startedAt),
        count,
      );
      this.logger.log(
        `Cleanup complete. Deleted ${count} expired/revoked tokens.`,
      );
    } catch (error) {
      this.metrics.recordCleanup('error', this.elapsedSeconds(startedAt));
      this.logger.error('Failed to cleanup tokens', error);
    }
  }

  private elapsedSeconds(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
  }
}
