import { BOT_USER_ID } from '@common/constants/seed.constants';
import type { ReelShareResponse } from '@common/content/interfaces/reel-share.interface';
import {
  ReelNotFoundError,
  ReelNotReadyError,
  ReelShareForbiddenError,
} from '@content/domain/errors/content.error';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import type { IConversationMessageService } from '@content/domain/interfaces/conversation-message.service.interface';
import type { IFriendSharePolicyService } from '@content/domain/interfaces/friend-share-policy.service.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ShareReelUseCase {
  constructor(
    @Inject('IContentRepository')
    private readonly contentRepository: IContentRepository,

    @Inject('IFriendSharePolicyService')
    private readonly friendSharePolicyService: IFriendSharePolicyService,

    @Inject('IConversationMessageService')
    private readonly conversationMessageService: IConversationMessageService,
  ) {}

  async execute(input: {
    reelId: string;
    sharedByUserId: string;
    conversationId: string;
    sharedWithUserId?: string;
  }): Promise<ReelShareResponse> {
    const sharedWithUserId = input.sharedWithUserId?.trim() || BOT_USER_ID;

    const reel = await this.contentRepository.findById(input.reelId);

    if (!reel) {
      throw new ReelNotFoundError();
    }

    if (reel.mediaStatus !== 'COMPLETED' || !reel.hlsMasterKey) {
      throw new ReelNotReadyError();
    }

    this.assertCanShareReel({
      reelOwnerId: reel.userId,
      reelVisibility: reel.visibility,
      sharedByUserId: input.sharedByUserId,
    });

    if (sharedWithUserId === BOT_USER_ID) {
      await this.assertConversationContainsBot({
        conversationId: input.conversationId,
        sharedByUserId: input.sharedByUserId,
      });
    } else {
      await this.assertCanShareWithTargetUser({
        sharedByUserId: input.sharedByUserId,
        sharedWithUserId,
      });
    }

    const share = await this.contentRepository.shareReel({
      reelId: reel.id,
      ownerId: reel.userId,
      sharedByUserId: input.sharedByUserId,
      sharedWithUserId,
      conversationId: input.conversationId,
      messageId: null,
    });

    if (share.messageId) {
      return {
        id: share.id,
        reelId: share.reelId,
        ownerId: share.ownerId,
        sharedByUserId: share.sharedByUserId,
        sharedWithUserId: share.sharedWithUserId,
        conversationId: share.conversationId,
        messageId: share.messageId,
        createdAt: share.createdAt.toISOString(),
      };
    }

    const message = await this.conversationMessageService.createReelMessage({
      conversationId: input.conversationId,
      senderId: input.sharedByUserId,
      reel,
    });

    const updatedShare = await this.contentRepository.updateReelShareMessageId(
      share.id,
      message.id,
    );

    return {
      id: updatedShare.id,
      reelId: updatedShare.reelId,
      ownerId: updatedShare.ownerId,
      sharedByUserId: updatedShare.sharedByUserId,
      sharedWithUserId: updatedShare.sharedWithUserId,
      conversationId: updatedShare.conversationId,
      messageId: updatedShare.messageId,
      createdAt: updatedShare.createdAt.toISOString(),
      message,
    };
  }

  private assertCanShareReel(input: {
    reelOwnerId: string;
    reelVisibility: string;
    sharedByUserId: string;
  }): void {
    if (input.reelOwnerId === input.sharedByUserId) {
      return;
    }

    if (input.reelVisibility === 'public') {
      return;
    }

    throw new ReelShareForbiddenError(
      'Private reels can only be shared by their owner.',
    );
  }

  private async assertConversationContainsBot(input: {
    conversationId: string;
    sharedByUserId: string;
  }): Promise<void> {
    const isBotConversation =
      await this.conversationMessageService.isBotConversation({
        conversationId: input.conversationId,
        userId: input.sharedByUserId,
      });

    if (!isBotConversation) {
      throw new ReelShareForbiddenError(
        'Bot shares are only allowed in conversations that include the bot.',
      );
    }
  }

  private async assertCanShareWithTargetUser(input: {
    sharedByUserId: string;
    sharedWithUserId: string;
  }): Promise<void> {
    if (input.sharedByUserId === input.sharedWithUserId) {
      return;
    }

    const result = await this.friendSharePolicyService.canShareWithUser({
      requesterId: input.sharedByUserId,
      targetUserId: input.sharedWithUserId,
    });

    if (!result.allowed) {
      throw new ReelShareForbiddenError(
        result.reason || 'You can only share reels with friends.',
      );
    }
  }
}
