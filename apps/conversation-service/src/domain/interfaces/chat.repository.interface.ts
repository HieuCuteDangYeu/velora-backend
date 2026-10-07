import { Conversation } from 'apps/conversation-service/src/domain/entities/conversation.entity';
import {
  Message,
  type MessageMedia,
  type RecallMessageResult,
} from 'apps/conversation-service/src/domain/entities/message.entity';

export interface MediaProcessingSyncResult {
  conversationIds: string[];
  messageIds: string[];
  media: MessageMedia;
  discardedBecauseRecalled?: boolean;
}

/**
 * `created` is deliberately part of the persistence contract.  Callers must
 * only dispatch socket events and bot work for a newly-created message.
 * Notification intent is committed inside persistence and delivered separately.
 */
export interface CreateMessageResult {
  message: Message;
  created: boolean;
  /** Conversation returned by the same committed transaction, before User RPC enrichment. */
  conversation?: Conversation;
}

export interface MarkMessagesAsSeenResult {
  updatedCount: number;
  seenAt?: Date;
  seenUpTo?: {
    messageId: string;
    createdAt: Date;
  };
}

export interface AnchorMessageWindow {
  targetMessageId: string;
  messages: Message[];
  hasOlder: boolean;
  hasNewer: boolean;
  oldestCursor?: string;
  newestCursor?: string;
}

export interface AnchorMessageExpansion {
  messages: Message[];
  hasMore: boolean;
  nextCursor?: string;
}

export abstract class IChatRepository {
  abstract createMessage(message: Message): Promise<Message>;
  abstract createMessageIdempotently(
    message: Message,
    options?: { enqueueNotification: boolean },
  ): Promise<CreateMessageResult>;
  abstract assertConversationParticipant(
    conversationId: string,
    userId: string,
  ): Promise<void>;
  abstract findMessagesByConversationId(
    conversationId: string,
    limit: number,
    cursor?: string,
  ): Promise<Message[]>;
  abstract findMessageWindowAroundId(
    conversationId: string,
    messageId: string,
    before: number,
    after: number,
  ): Promise<AnchorMessageWindow>;
  abstract findOlderMessagesFromAnchorCursor(
    conversationId: string,
    cursor: string,
    limit: number,
  ): Promise<AnchorMessageExpansion>;
  abstract findNewerMessagesFromAnchorCursor(
    conversationId: string,
    cursor: string,
    limit: number,
  ): Promise<AnchorMessageExpansion>;
  abstract createConversation(
    conversation: Conversation,
  ): Promise<Conversation>;
  abstract findConversation(id: string): Promise<Conversation | null>;
  abstract populateConversationParticipants(
    conversation: Conversation,
  ): Promise<Conversation>;
  abstract markMessagesAsSeen(
    conversationId: string,
    userId: string,
    upToMessageId?: string,
  ): Promise<MarkMessagesAsSeenResult>;
  abstract hasSharedConversation(
    userId1: string,
    userId2: string,
  ): Promise<boolean>;
  abstract findPresenceAudienceUserIds(userId: string): Promise<string[]>;
  abstract findPrivateConversation(
    userId1: string,
    userId2: string,
  ): Promise<Conversation | null>;

  abstract findConversationsByUserId(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<Conversation[]>;
  abstract addReaction(
    messageId: string,
    userId: string,
    emoji: string,
  ): Promise<Message>;
  abstract removeReaction(messageId: string, userId: string): Promise<Message>;
  abstract recallMessage(
    messageId: string,
    userId: string,
  ): Promise<RecallMessageResult>;
  abstract syncMediaProcessingResult(
    fileKey: string,
    media: MessageMedia,
  ): Promise<MediaProcessingSyncResult>;
}
