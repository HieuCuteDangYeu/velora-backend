import { createZodDto } from 'nestjs-zod';
import { ResetPasswordSchema } from './reset-password.dto';

export const VerifyResetCodeSchema = ResetPasswordSchema.pick({
  email: true,
  token: true,
});

export class VerifyResetCodeDto extends createZodDto(VerifyResetCodeSchema) {}
