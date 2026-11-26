import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const VerifyAppleTokenSchema = z.object({
  identityToken: z.string().min(1).max(8192),
  /** The raw nonce whose SHA-256 the app passed to Apple. */
  nonce: z.string().min(16).max(128),
  /** Sent by Apple to the app on the first authorization only. */
  fullName: z.string().trim().max(100).optional(),
});

export class VerifyAppleTokenDto extends createZodDto(VerifyAppleTokenSchema) {}
