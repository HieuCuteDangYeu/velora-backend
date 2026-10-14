import type { IStorageService } from '@content/domain/interfaces/storage.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import * as path from 'node:path';
import { ContentRepository } from '../repositories/content.repository';

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;

@Injectable()
export class ReelMediaCleanupService {
  private readonly logger = new Logger(ReelMediaCleanupService.name);
  private running = false;

  constructor(
    private readonly repository: ContentRepository,
    @Inject('IStorageService') private readonly storage: IStorageService,
    private readonly config: ConfigService,
  ) {}

  @Interval(CLEANUP_INTERVAL_MS)
  async cleanup(): Promise<void> {
    if (
      this.running ||
      this.config.get<string>('REEL_MEDIA_CLEANUP_ENABLED') !== 'true'
    ) {
      return;
    }

    this.running = true;
    const dryRun =
      this.config.get<string>('REEL_MEDIA_CLEANUP_APPLY') !== 'true';
    try {
      const now = new Date();
      const leases = await this.repository.listExpiredReelUploadLeases(now);
      for (const lease of leases) {
        if (dryRun) {
          this.logger.log(
            `Dry-run expired Reel upload lease cleanup key=${lease.mediaKey}`,
          );
          continue;
        }
        const claimed = await this.repository.cleanupExpiredReelUploadLease(
          lease.id,
          now,
        );
        if (claimed) {
          await this.repository.completeReelUploadLeaseCleanup(lease.id, now);
        }
      }

      const keys = await this.storage.listObjects('reels/');
      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const prefixes = new Set(
        keys.flatMap((key) => {
          const parts = key.split('/');
          if (parts.length < 5 || !uuidPattern.test(parts[3])) return [];
          return [parts.slice(0, 4).join('/')];
        }),
      );
      for (const prefix of prefixes) {
        const mediaAttemptId = path.posix.basename(prefix);
        if (
          await this.repository.isReelMediaOutputPrefixProtected(
            prefix,
            mediaAttemptId,
          )
        ) {
          continue;
        }

        const orphanKeys = keys.filter(
          (key) => key === prefix || key.startsWith(`${prefix}/`),
        );
        if (dryRun) {
          this.logger.log(
            `Dry-run unadopted Reel media cleanup prefix=${prefix} objects=${orphanKeys.length}`,
          );
        } else if (orphanKeys.length > 0) {
          await this.storage.deleteObjects(orphanKeys);
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Reel media cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
