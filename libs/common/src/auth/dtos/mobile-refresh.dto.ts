import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MobileRefreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export class MobileRefreshDto extends createZodDto(MobileRefreshSchema) {}
