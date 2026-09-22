import { AssignRoleUseCase } from '@auth/application/use-cases/assign-role.use-case';
import { ConfirmAccountUseCase } from '@auth/application/use-cases/confirm-account.use-case';
import { DeleteUserRolesUseCase } from '@auth/application/use-cases/delete-user-roles.use-case';
import { ForgotPasswordUseCase } from '@auth/application/use-cases/forgot-password.use-case';
import { GoogleLoginUseCase } from '@auth/application/use-cases/google-login.use-case';
import { LoginUseCase } from '@auth/application/use-cases/login.use-case';
import { LogoutUseCase } from '@auth/application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '@auth/application/use-cases/refresh-token.use-case';
import { ResendVerificationUseCase } from '@auth/application/use-cases/resend-verification.use-case';
import { ResetPasswordUseCase } from '@auth/application/use-cases/reset-password.use-case';
import { VerifyGoogleTokenUseCase } from '@auth/application/use-cases/verify-google-token.use-case';
import { VerifyTokenUseCase } from '@auth/application/use-cases/verify-token.use-case';
import { MailServiceAdapter } from '@auth/infrastructure/adapters/mail-service.adapter';
import { AuthMetricsController } from '@auth/infrastructure/controllers/auth-metrics.controller';
import { RoleController } from '@auth/infrastructure/controllers/role.controller';
import { TokenCleanupService } from '@auth/infrastructure/jobs/token-cleanup.service';
import { AuthPrometheusMetricsService } from '@auth/infrastructure/metrics/auth-prometheus-metrics.service';
import { RedisUserRoleRepository } from '@auth/infrastructure/repositories/redis-user-role.repository';
import { RedisVerificationCodeRepository } from '@auth/infrastructure/repositories/redis-verification-code.repository';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ScheduleModule } from '@nestjs/schedule';
import Redis from 'ioredis';
import { RegisterUseCase } from './application/use-cases/register.use-case';
import { UserServiceAdapter } from './infrastructure/adapters/user-service.adapter';
import { AuthController } from './infrastructure/controllers/auth.controller';
import { PrismaService } from './infrastructure/prisma/prisma.service';
import { AuthRepository } from './infrastructure/repositories/auth.repository';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    ClientsModule.registerAsync([
      {
        name: 'MAIL_SERVICE_CLIENT',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'mail_queue',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
      {
        name: 'USER_SERVICE_RMQ',
        useFactory: (config: ConfigService) => ({
          transport: Transport.RMQ,
          options: {
            urls: [config.getOrThrow<string>('RABBITMQ_URL')],
            queue: 'user_queue',
            queueOptions: { durable: true },
          },
        }),
        inject: [ConfigService],
      },
    ]),
    ScheduleModule.forRoot(),
    JwtModule.registerAsync({
      global: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const secret = config.getOrThrow<string>('JWT_SECRET');
        if (secret.length < 32) {
          throw new Error('JWT_SECRET must contain at least 32 characters');
        }

        return {
          secret,
          signOptions: { expiresIn: '15m' },
        };
      },
    }),
  ],
  controllers: [AuthController, AuthMetricsController, RoleController],
  providers: [
    PrismaService,
    AuthPrometheusMetricsService,
    TokenCleanupService,
    RegisterUseCase,
    LoginUseCase,
    DeleteUserRolesUseCase,
    ConfirmAccountUseCase,
    ResendVerificationUseCase,
    RefreshTokenUseCase,
    LogoutUseCase,
    GoogleLoginUseCase,
    AssignRoleUseCase,
    ForgotPasswordUseCase,
    ResetPasswordUseCase,
    VerifyTokenUseCase,
    VerifyGoogleTokenUseCase,
    {
      provide: 'IAuthRepository',
      useClass: AuthRepository,
    },
    {
      provide: 'IUserService',
      useClass: UserServiceAdapter,
    },
    {
      provide: 'IMailService',
      useClass: MailServiceAdapter,
    },
    {
      provide: 'REDIS_CLIENT',
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        return new Redis({
          host: config.get('REDIS_HOST'),
          port: config.get<number>('REDIS_PORT'),
          password: config.get('REDIS_PASSWORD'),
          tls: (config.get<string>('REDIS_HOST') ?? '').includes('upstash')
            ? { servername: config.get('REDIS_HOST') }
            : undefined,
        });
      },
    },
    {
      provide: 'IVerificationCodeRepository',
      useClass: RedisVerificationCodeRepository,
    },
    {
      provide: 'IUserRoleRepository',
      useClass: RedisUserRoleRepository,
    },
  ],
})
export class AuthServiceModule {}
