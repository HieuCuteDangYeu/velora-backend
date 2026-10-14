import {
  ReelNotReadyError,
  ReelShareForbiddenError,
  ReelShareLinkExpiredError,
  ReelShareLinkNotFoundError,
  ReelShareLinkRevokedError,
} from '@content/domain/errors/content.error';
import type {
  IContentRepository,
  ReelShareLinkWithReel,
} from '@content/domain/interfaces/content.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ResolveReelShareLinkUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,
  ) {}

  async execute(input: { token: string }): Promise<ReelShareLinkWithReel> {
    const result = await this.contentRepository.findReelShareLinkByToken(
      input.token,
    );

    if (!result) {
      throw new ReelShareLinkNotFoundError();
    }

    if (result.link.revokedAt) {
      throw new ReelShareLinkRevokedError();
    }

    if (
      result.link.expiresAt &&
      result.link.expiresAt.getTime() <= Date.now()
    ) {
      throw new ReelShareLinkExpiredError();
    }

    if (result.reel.mediaStatus !== 'COMPLETED' || !result.reel.hlsMasterKey) {
      throw new ReelNotReadyError();
    }

    if (result.reel.visibility !== 'public') {
      throw new ReelShareForbiddenError(
        'This reel is no longer publicly available.',
      );
    }

    const updatedLink =
      await this.contentRepository.incrementReelShareLinkClickCount(
        result.link.id,
      );

    return {
      link: updatedLink,
      reel: result.reel,
    };
  }
}
