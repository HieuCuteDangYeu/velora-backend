import {
  AiRagCitationSchema,
  AiRecommendedReelSchema,
} from '@common/ai/dtos/ask-question-response.dto';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { ConversationMessageTypeSchema } from './create-message.dto';
import { MessageMediaSchema } from './message-media.schema';

export const GroupSystemActivityTypeSchema = z.enum([
  'GROUP_CREATED',
  'MEMBER_ADDED',
  'MEMBER_LEFT',
  'MEMBER_REMOVED',
  'MEMBER_PROMOTED',
  'MEMBER_DEMOTED',
  'OWNERSHIP_TRANSFERRED',
  'GROUP_RENAMED',
  'GROUP_PICTURE_CHANGED',
]);

export const GroupSystemActivitySchema = z.object({
  type: GroupSystemActivityTypeSchema,
  actorUserId: z.string(),
  actorName: z.string().optional(),
  targetUserId: z.string().optional(),
  targetName: z.string().optional(),
  previousValue: z.string().nullable().optional(),
  nextValue: z.string().nullable().optional(),
});

export const CallLogSchema = z.object({
  callId: z.string(),
  callType: z.enum(['VOICE', 'VIDEO']),
  isGroupCall: z.boolean(),
  initiatorId: z.string(),
  outcome: z.enum(['COMPLETED', 'MISSED', 'DECLINED', 'FAILED']),
  terminalReason: z.string().optional(),
  durationSec: z.number().int().nonnegative().optional(),
  participants: z.array(
    z.object({
      userId: z.string(),
      role: z.enum(['CALLER', 'CALLEE']),
      result: z.enum(['ANSWERED', 'MISSED', 'DECLINED', 'CANCELLED', 'FAILED']),
    }),
  ),
});

export const MessageMetadataSchema = z.object({
  kind: z
    .enum([
      'velora_ai_response',
      'velora_ai_reel_recommendations',
      'group_system_activity',
      'call_log',
    ])
    .optional(),
  citations: z.array(AiRagCitationSchema).optional(),
  recommendedReels: z.array(AiRecommendedReelSchema).optional(),
  suggestedQueries: z.array(z.string()).optional(),
  groupActivity: GroupSystemActivitySchema.optional(),
  callLog: CallLogSchema.optional(),
});

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  senderId: z.string(),
  clientMessageId: z.string().optional(),
  content: z.string(),
  media: MessageMediaSchema.optional(),
  metadata: MessageMetadataSchema.optional(),
  type: z.string().default('text'),
  signalType: z.number().int().optional(),
  createdAt: z.string().datetime(),
  isRecalled: z.boolean().optional(),
  recalledAt: z.string().datetime().optional(),
  replyToId: z.string().optional(),
  replyPreview: z
    .object({
      senderName: z.string(),
      content: z.string(),
      thumbnailUri: z.string().optional(),
      mediaWidth: z.number().optional(),
      mediaHeight: z.number().optional(),
      type: ConversationMessageTypeSchema,
    })
    .optional(),
  reactions: z
    .record(
      z.string(),
      z.object({
        emoji: z.string(),
        createdAt: z.string().datetime(),
      }),
    )
    .optional(),
  createdAtMs: z.number().int(),
  readBy: z
    .array(
      z.object({
        userId: z.string(),
        at: z.string().datetime(),
      }),
    )
    .optional(),
});

export class MessageDto extends createZodDto(MessageSchema) {}
