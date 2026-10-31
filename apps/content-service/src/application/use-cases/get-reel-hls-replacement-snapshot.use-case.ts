import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';

@Injectable()
export class GetReelHlsReplacementSnapshotUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}
  async execute(reelId: string) {
    const reel = await this.repository.findById(reelId);
    if (!reel?.hlsMasterKey || !reel.updatedAt)
      throw new Error('Reel has no current HLS');
    return {
      reelId: reel.id,
      userId: reel.userId,
      expectedUpdatedAt: reel.updatedAt.toISOString(),
      previousHlsMasterKey: reel.hlsMasterKey,
      mediaKeySha256: createHash('sha256').update(reel.mediaKey).digest('hex'),
      mediaAttemptId: reel.mediaAttemptId ?? null,
      indexAttemptId: reel.indexAttemptId ?? null,
    };
  }
}
