import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const REPORT_TARGET_TYPES = [
  'user',
  'message',
  'reel',
  'comment',
] as const;
export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate',
  'sexual',
  'violence',
  'self_harm',
  'illegal',
  'impersonation',
  'other',
] as const;

export const ReportContentSchema = z.object({
  targetType: z.enum(REPORT_TARGET_TYPES),
  targetId: z.string().trim().min(1).max(128),
  /** The author of the reported content, when the app knows it. */
  targetUserId: z.string().trim().min(1).max(128).optional(),
  /** Conversation of a reported message, so a moderator can find it. */
  conversationId: z.string().trim().min(1).max(128).optional(),
  reason: z.enum(REPORT_REASONS),
  details: z.string().trim().max(1000).optional(),
});

export class ReportContentDto extends createZodDto(ReportContentSchema) {}
