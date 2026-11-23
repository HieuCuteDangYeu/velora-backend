import type { FriendFeedAudienceResponse } from '@common/friend/interfaces/friend-content-access.interface';
import type { IFriendRepository } from '@friend/domain/interfaces/friend.repository.interface';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetReelFeedAudienceUseCase {
  constructor(
    @Inject('IFriendRepository')
    private readonly friendRepository: IFriendRepository,
  ) {}

  async execute(userId: string): Promise<FriendFeedAudienceResponse> {
    const { friendUserIds, blockRelatedUserIds } =
      await this.friendRepository.listReelFeedAudienceIds(userId);

    const excludedSet = new Set(blockRelatedUserIds);

    return {
      friendUserIds: friendUserIds.filter(
        (friendUserId) => !excludedSet.has(friendUserId),
      ),
      excludedUserIds: blockRelatedUserIds,
    };
  }
}
