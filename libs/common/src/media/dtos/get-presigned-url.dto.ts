import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const GetPresignedUrlSchema = z
  .object({
    publishIntentId: z.string().uuid().optional(),
    fileType: z
      .string()
      .regex(/^(image\/(jpeg|png|webp)|video\/(mp4|quicktime|webm))$/),
    purpose: z
      .enum(['avatar', 'chat', 'reel', 'chat_thumbnail'])
      .default('chat'),
  })
  .superRefine((value, context) => {
    if (value.publishIntentId && value.purpose !== 'reel') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publishIntentId'],
        message: 'publishIntentId is only supported for reel uploads.',
      });
    }
  });

export class GetPresignedUrlDto extends createZodDto(GetPresignedUrlSchema) {}
