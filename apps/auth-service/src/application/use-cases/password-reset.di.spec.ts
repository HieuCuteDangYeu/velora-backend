import { RedisPasswordResetCodeStore } from '@auth/infrastructure/repositories/redis-password-reset-code.store';
import { Test } from '@nestjs/testing';
import { ForgotPasswordUseCase } from './forgot-password.use-case';
import { ResetPasswordUseCase } from './reset-password.use-case';
import { VerifyResetCodeUseCase } from './verify-reset-code.use-case';

// Hand-built instances in the other specs cannot catch a wrong injection token,
// so compile the real providers with the tokens auth-service.module registers.
describe('password reset providers', () => {
  it('resolve with the module tokens', async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ForgotPasswordUseCase,
        ResetPasswordUseCase,
        VerifyResetCodeUseCase,
        {
          provide: 'IPasswordResetCodeStore',
          useClass: RedisPasswordResetCodeStore,
        },
        { provide: 'REDIS_CLIENT', useValue: {} },
        { provide: 'IUserService', useValue: {} },
        { provide: 'IMailService', useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(ForgotPasswordUseCase)).toBeDefined();
    expect(moduleRef.get(ResetPasswordUseCase)).toBeDefined();
    expect(moduleRef.get(VerifyResetCodeUseCase)).toBeDefined();
  });
});
