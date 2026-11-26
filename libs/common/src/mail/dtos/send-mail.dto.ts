import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const sendMailSchema = z.object({
  to: z.email(),
  subject: z.string(),
  /** A Resend template id; ignored when `text` is given. */
  template: z.string(),
  context: z.record(z.string(), z.any()),
  /** Plain-text body for internal mail (moderation reports) that needs no template. */
  text: z.string().max(10_000).optional(),
});

export class SendMailDto extends createZodDto(sendMailSchema) {}
