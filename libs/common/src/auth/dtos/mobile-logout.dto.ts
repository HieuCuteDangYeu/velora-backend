import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { LogoutSchema } from './logout.dto';

export const MobileLogoutSchema = LogoutSchema.extend({
  refreshToken: z.string().min(1),
});

export class MobileLogoutDto extends createZodDto(MobileLogoutSchema) {}
