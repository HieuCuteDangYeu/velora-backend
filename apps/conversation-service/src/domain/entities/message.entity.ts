import type {
  AiRagCitation,
  AiRecommendedReel,
} from '@common/ai/dtos/ask-question-response.dto';
import { ReadStatus } from './read-status.entity';

export const RECALLED_MESSAGE_CONTENT = 'Tin nhắn đã thu hồi';

export interface MessageReaction {
  emoji: string;
  createdAt: string;
}

export type MessageReactionMap = Record<string, MessageReaction>;

export type ConversationMessageType =
  | 'text'
  | 'image'
  | 'video'
  | 'file'
  | 'call'
  | 'reel';

export type GroupSystemActivityType =
  | 'GROUP_CREATED'
  | 'MEMBER_ADDED'
  | 'MEMBER_LEFT'
  | 'MEMBER_REMOVED'
  | 'MEMBER_PROMOTED'
  | 'MEMBER_DEMOTED'
  | 'OWNERSHIP_TRANSFERRED'
  | 'GROUP_RENAMED'
  | 'GROUP_PICTURE_CHANGED';

export interface GroupSystemActivity {
  type: GroupSystemActivityType;
  actorUserId: string;
  actorName?: string;
  targetUserId?: string;
  targetName?: string;
  previousValue?: string | null;
  nextValue?: string | null;
}

export interface MessageReplyPreview {
  senderName: string;
  content: string;
  thumbnailUri?: string;
  mediaWidth?: number;
  mediaHeight?: number;
  type: ConversationMessageType;
}

export interface MessageMedia {
  fileKey?: string;
  fileUrl: string;
  thumbnailKey?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  durationMs?: number;
  status?: 'ready' | 'processing' | 'failed';
  failureReason?: string;
  reelId?: string;
  reelSourceOrientation?: 'PORTRAIT' | 'LANDSCAPE' | 'SQUARE';
  reelSourceAspectRatio?: number;
  reelPlaybackPresentation?: 'PORTRAIT_COVER' | 'FIT_WITH_LETTERBOX';
  reelOwnerId?: string;
  reelOwnerUsername?: string;
  reelOwnerAvatarUrl?: string;
  reelTitle?: string;
  reelDescription?: string;
  reelTags?: string[];
}

export interface MessageMetadata {
  kind?:
    | 'velora_ai_response'
    | 'velora_ai_reel_recommendations'
    | 'group_system_activity';
  citations?: AiRagCitation[];
  recommendedReels?: AiRecommendedReel[];
  suggestedQueries?: string[];
  groupActivity?: GroupSystemActivity;
}

export interface RecallMessageResult {
  message: Message;
  updatedReplyMessageIds: string[];
  previewContent: string;
}

export class Message {
  id!: string;
  conversationId!: string;
  senderId!: string;
  clientMessageId?: string;
  signalType!: number;
  content!: string;
  media?: MessageMedia;
  metadata?: MessageMetadata;
  registrationId?: number;
  type!: string;
  createdAt!: Date;
  readBy: ReadStatus[] = [];
  isRecalled?: boolean;
  recalledAt?: Date;
  replyToId?: string;
  replyPreview?: MessageReplyPreview;
  reactions?: MessageReactionMap;

  constructor(partial: Partial<Message> = {}) {
    Object.assign(this, partial);

    this.readBy = (partial.readBy || []).map((status) =>
      status instanceof ReadStatus ? status : new ReadStatus(status),
    );
  }
}
