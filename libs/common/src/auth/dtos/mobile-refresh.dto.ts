import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const MobileRefreshSchema = z.object({
  refreshToken: z.string().min(1),
  refreshRequestId: z.string().uuid().optional(),
});

export class MobileRefreshDto extends createZodDto(MobileRefreshSchema) {}
