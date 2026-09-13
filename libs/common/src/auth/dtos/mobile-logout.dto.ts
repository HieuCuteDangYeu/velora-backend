import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MobileLogoutSchema = z.object({
  refreshToken: z.string().min(1),
});

export class MobileLogoutDto extends createZodDto(MobileLogoutSchema) {}
