import type { ReelShareLink } from '@content/domain/entities/reel-share-link.entity';
import {
  ReelNotFoundError,
  ReelNotReadyError,
  ReelShareForbiddenError,
} from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

@Injectable()
export class CreateReelShareLinkUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(input: {
    reelId: string;
    createdBy: string;
    expiresInDays?: number;
    reuseExisting?: boolean;
  }): Promise<ReelShareLink> {
    const reel = await this.contentRepository.findById(input.reelId);

    if (!reel) {
      throw new ReelNotFoundError();
    }

    if (reel.mediaStatus !== 'COMPLETED' || !reel.hlsMasterKey) {
      throw new ReelNotReadyError();
    }

    if (reel.visibility !== 'public') {
      throw new ReelShareForbiddenError(
        'Only public reels can be shared with an external link.',
      );
    }

    const now = new Date();
    const reuseExisting = input.reuseExisting !== false;

    if (reuseExisting) {
      const existing =
        await this.contentRepository.findActiveReelShareLinkByReelAndCreator({
          reelId: reel.id,
          createdBy: input.createdBy,
          now,
        });

      if (existing) {
        return existing;
      }
    }

    const expiresAt = this.resolveExpiresAt(input.expiresInDays);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const token = this.generateToken();
      const existing =
        await this.contentRepository.findReelShareLinkByToken(token);

      if (existing) {
        continue;
      }

      return await this.contentRepository.createReelShareLink({
        reelId: reel.id,
        ownerId: reel.userId,
        token,
        createdBy: input.createdBy,
        expiresAt,
      });
    }

    throw new Error('Failed to generate a unique reel share token.');
  }

  private resolveExpiresAt(expiresInDays?: number): Date | null {
    if (
      expiresInDays === undefined ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1
    ) {
      return null;
    }

    const safeDays = Math.min(expiresInDays, 365);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + safeDays);

    return expiresAt;
  }

  private generateToken(): string {
    return randomBytes(12)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');
  }
}
