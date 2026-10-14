import { Inject, Injectable } from '@nestjs/common';
import type { IContentRepository } from '../../domain/interfaces/content.repository.interface';

@Injectable()
export class ReserveReelUploadLeaseUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly repository: IContentRepository,
  ) {}

  async execute(input: {
    userId: string;
    publishIntentId: string;
    mediaKey: string;
    fileType: string;
    expiresAt: Date;
  }): Promise<void> {
    if (
      !input.userId.trim() ||
      !input.publishIntentId.trim() ||
      !input.mediaKey.trim() ||
      !input.fileType.trim() ||
      !Number.isFinite(input.expiresAt.getTime())
    ) {
      throw new Error('Invalid Reel upload lease.');
    }

    await this.repository.reserveReelUploadLease(input);
  }
}
