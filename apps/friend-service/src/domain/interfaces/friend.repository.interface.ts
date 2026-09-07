import { Friendship } from '@friend/domain/entities/friendship.entity';

export interface FriendshipPaginationCursor {
  timestamp: Date;
  id: string;
}

export interface PaginatedFriendCollection<T> {
  items: T[];
  nextCursor: FriendshipPaginationCursor | null;
}

export type PaginatedFriendships = PaginatedFriendCollection<Friendship>;

export interface CreateOrFindFriendshipResult {
  friendship: Friendship;
  created: boolean;
}

export type AcceptFriendRequestResult =
  | {
      outcome: 'accepted';
      friendship: Friendship;
    }
  | {
      outcome: 'already_accepted';
      friendship: Friendship;
    }
  | {
      outcome: 'not_found';
    }
  | {
      outcome: 'forbidden';
    }
  | {
      outcome: 'not_pending';
    };

export type DeleteFriendRequestResult =
  | {
      outcome: 'deleted';
    }
  | {
      outcome: 'not_found';
    }
  | {
      outcome: 'forbidden';
    }
  | {
      outcome: 'not_pending';
    };

export interface IFriendRepository {
  createOrFindPending(
    friendship: Friendship,
  ): Promise<CreateOrFindFriendshipResult>;

  findById(id: string): Promise<Friendship | null>;

  findByUsers(userId: string, otherUserId: string): Promise<Friendship | null>;

  acceptPendingRequest(
    requestId: string,
    recipientId: string,
    respondedAt: Date,
  ): Promise<AcceptFriendRequestResult>;

  deletePendingIncomingRequest(
    requestId: string,
    recipientId: string,
  ): Promise<DeleteFriendRequestResult>;

  deletePendingOutgoingRequest(
    requestId: string,
    requesterId: string,
  ): Promise<DeleteFriendRequestResult>;

  deleteAcceptedByUsers(userId: string, otherUserId: string): Promise<boolean>;

  listIncomingPending(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships>;

  listOutgoingPending(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships>;

  listAccepted(
    userId: string,
    limit: number,
    cursor?: FriendshipPaginationCursor,
  ): Promise<PaginatedFriendships>;

  listAcceptedUserIds(userId: string): Promise<string[]>;
}
