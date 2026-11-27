import { PublicUserProfile } from '@common/user/interfaces/public-user-profile.types';
import { Inject, Injectable } from '@nestjs/common';
import type { IFriendDiscoveryService } from '@user/domain/interfaces/friend-discovery.service.interface';
import type { IUserRepository } from '@user/domain/interfaces/user.repository.interface';

@Injectable()
export class SearchPublicUsersUseCase {
  constructor(
    @Inject('IUserRepository')
    private readonly userRepository: IUserRepository,

    @Inject('IFriendDiscoveryService')
    private readonly friendDiscoveryService: IFriendDiscoveryService,
  ) {}

  async execute(
    query: string,
    limit: number,
    viewerId: string,
    cursor?: string,
  ): Promise<PublicUserProfile[]> {
    const trimmedQuery = query.trim();
    const normalizedQuery = trimmedQuery.replace(/^@+/, '');

    const audience = await this.friendDiscoveryService.getAudience(viewerId);

    // Existing friends remain searchable. Only the viewer and users
    // blocked in either direction are hidden from global discovery.
    const excludedUserIds = [
      ...new Set([viewerId, ...audience.excludedUserIds]),
    ];

    const users = await this.userRepository.searchPublicUsers({
      query: normalizedQuery || trimmedQuery,
      limit: Math.min(Math.max(limit, 1), 30),
      excludedUserIds,
      ...(cursor ? { afterUsername: cursor } : {}),
    });

    return users.map((user) => ({
      id: user.id!,
      fullName: user.fullName,
      username: user.username,
      picture: user.picture,
      isVerified: user.isVerified,
    }));
  }
}
