import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import type { IStorageService } from '@content/domain/interfaces/storage.service.interface';
import { Inject, Injectable } from '@nestjs/common';
import * as path from 'node:path';

@Injectable()
export class DeleteReelUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
    @Inject('IStorageService')
    private readonly storageService: IStorageService,
  ) {}

  async execute(id: string, userId: string): Promise<boolean> {
    const reel = await this.repository.findById(id);
    if (!reel) return false;

    const deleted = await this.repository.deleteReel(id, userId);
    if (!deleted) return false;

    // Keep the adopted original source for reprocess and shared-intent safety.
    const keysToDelete: string[] = [];

    const hlsPrefix = reel.hlsMasterKey
      ? path.posix.dirname(reel.hlsMasterKey)
      : undefined;
    if (
      hlsPrefix &&
      !(await this.repository.isReelMediaOutputPrefixProtected(
        hlsPrefix,
        path.posix.basename(hlsPrefix),
      ))
    ) {
      keysToDelete.push(
        ...(await this.storageService.listObjects(`${hlsPrefix}/`)),
      );
    }

    try {
      if (keysToDelete.length > 0) {
        await this.storageService.deleteObjects(keysToDelete);
      }
    } catch (err) {
      // Best-effort cleanup — log and don't fail the delete
      console.error(
        `[DeleteReelUseCase] R2 cleanup failed for reel ${id}:`,
        err,
      );
    }

    return true;
  }
}
