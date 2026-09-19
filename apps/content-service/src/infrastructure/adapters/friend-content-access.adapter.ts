import type {
  CanViewReelContentResponse,
  FriendFeedAudienceResponse,
} from '@common/friend/interfaces/friend-content-access.interface';
import type { IFriendContentAccessService } from '@content/domain/interfaces/friend-content-access.service.interface';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { catchError, firstValueFrom, of, throwError, timeout } from 'rxjs';

@Injectable()
export class FriendContentAccessAdapter implements IFriendContentAccessService {
  private readonly logger = new Logger(FriendContentAccessAdapter.name);

  constructor(
    @Inject('FRIEND_SERVICE_RMQ')
    private readonly friendClient: ClientProxy,
  ) {}

  async getFeedAudience(viewerId: string): Promise<FriendFeedAudienceResponse> {
    return await firstValueFrom(
      this.friendClient
        .send<FriendFeedAudienceResponse>('friend.get_reel_feed_audience', {
          userId: viewerId,
        })
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            this.logger.warn(
              `Friend feed audience lookup failed: ${this.describeError(
                error,
              )}`,
            );

            return throwError(() => error);
          }),
        ),
    );
  }

  async canView(input: {
    viewerId: string;
    ownerId: string;
    visibility: 'public' | 'friends' | 'private';
  }): Promise<boolean> {
    const response = await firstValueFrom(
      this.friendClient
        .send<CanViewReelContentResponse>('friend.can_view_reel_content', input)
        .pipe(
          timeout(5000),
          catchError((error: unknown) => {
            this.logger.warn(
              `Reel content access lookup failed: ${this.describeError(error)}`,
            );

            return of({
              allowed: false,
            });
          }),
        ),
    );

    return response.allowed;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }

    return String(error);
  }
}
