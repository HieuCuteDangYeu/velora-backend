import { ConfirmAccountUseCase } from '@auth/application/use-cases/confirm-account.use-case';
import { ForgotPasswordUseCase } from '@auth/application/use-cases/forgot-password.use-case';
import { GoogleLoginUseCase } from '@auth/application/use-cases/google-login.use-case';
import { LoginUseCase } from '@auth/application/use-cases/login.use-case';
import { LogoutUseCase } from '@auth/application/use-cases/logout.use-case';
import { RefreshTokenUseCase } from '@auth/application/use-cases/refresh-token.use-case';
import { ResendVerificationUseCase } from '@auth/application/use-cases/resend-verification.use-case';
import { ResetPasswordUseCase } from '@auth/application/use-cases/reset-password.use-case';
import { VerifyGoogleTokenUseCase } from '@auth/application/use-cases/verify-google-token.use-case';
import { VerifyTokenUseCase } from '@auth/application/use-cases/verify-token.use-case';
import { AccountNotVerifiedError } from '@auth/domain/errors/account-not-verified.error';
import { GoogleAuthNotConfiguredError } from '@auth/domain/errors/google-auth-not-configured.error';
import { InvalidCredentialsError } from '@auth/domain/errors/invalid-credentials.error';
import { InvalidGoogleTokenError } from '@auth/domain/errors/invalid-google-token.error';
import { InvalidResetTokenError } from '@auth/domain/errors/invalid-reset-token.error';
import { InvalidTokenError } from '@auth/domain/errors/invalid-token.error';
import { ConfirmAccountDto } from '@common/auth/dtos/confirm-account.dto';
import { ForgotPasswordDto } from '@common/auth/dtos/forgot-password.dto';
import { LoginDto } from '@common/auth/dtos/login.dto';
import { RegisterDto } from '@common/auth/dtos/register.dto';
import { ResendVerificationDto } from '@common/auth/dtos/resend-verification.dto';
import { ResetPasswordDto } from '@common/auth/dtos/reset-password.dto';
import { VerifyGoogleTokenDto } from '@common/auth/dtos/verify-google-token.dto';
import type { GoogleProfile } from '@common/auth/interfaces/google-profile.interface';
import { SagaCompensationError } from '@common/domain/errors/saga.error';
import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { UserAlreadyExistsError } from '@user/domain/errors/user-already-exists.error';
import { UsernameAlreadyTakenError } from '@user/domain/errors/username-already-taken.error';
import { RegisterUseCase } from '../../application/use-cases/register.use-case';

@Controller()
export class AuthController {
  constructor(
    private readonly registerUseCase: RegisterUseCase,
    private readonly loginUseCase: LoginUseCase,
    private readonly confirmAccountUseCase: ConfirmAccountUseCase,
    private readonly resendVerificationUseCase: ResendVerificationUseCase,
    private readonly refreshTokenUseCase: RefreshTokenUseCase,
    private readonly logoutUseCase: LogoutUseCase,
    private readonly googleLoginUseCase: GoogleLoginUseCase,
    private readonly forgotPasswordUseCase: ForgotPasswordUseCase,
    private readonly resetPasswordUseCase: ResetPasswordUseCase,
    private readonly verifyTokenUseCase: VerifyTokenUseCase,
    private readonly verifyGoogleTokenUseCase: VerifyGoogleTokenUseCase,
  ) {}

  @MessagePattern('auth.register')
  async register(@Payload() dto: RegisterDto) {
    try {
      return await this.registerUseCase.execute(dto);
    } catch (error) {
      if (
        error instanceof UserAlreadyExistsError ||
        error instanceof UsernameAlreadyTakenError
      ) {
        throw new RpcException({
          statusCode: 409,
          message: error.message,
        });
      }

      if (error instanceof SagaCompensationError) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: 'Internal Server Error',
      });
    }
  }

  @MessagePattern('auth.login')
  async login(@Payload() dto: LoginDto) {
    try {
      return await this.loginUseCase.execute(dto);
    } catch (error) {
      if (error instanceof AccountNotVerifiedError) {
        throw new RpcException({
          statusCode: 403,
          message: error.message,
        });
      }

      if (error instanceof InvalidCredentialsError) {
        throw new RpcException({
          statusCode: 401,
          message: error.message,
        });
      }

      console.error('Login failed:', error);

      throw new RpcException({
        statusCode: 500,
        message: 'Login failed',
      });
    }
  }

  @MessagePattern('auth.verify_token')
  async verifyToken(@Payload() data: { token: string }) {
    try {
      return await this.verifyTokenUseCase.execute(data.token);
    } catch {
      throw new RpcException({
        statusCode: 401,
        message: 'Invalid or expired token',
      });
    }
  }

  @MessagePattern('auth.confirm_account')
  async handleConfirmAccount(@Payload() dto: ConfirmAccountDto) {
    try {
      return await this.confirmAccountUseCase.execute(dto);
    } catch (error) {
      if (error instanceof InvalidTokenError) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
        });
      }
      throw error;
    }
  }

  @MessagePattern('auth.resend_verification')
  async handleResendVerification(@Payload() dto: ResendVerificationDto) {
    try {
      return await this.resendVerificationUseCase.execute(dto);
    } catch (error) {
      console.error(error);
      throw new RpcException({
        statusCode: 500,
        message: 'Failed to resend verification email',
      });
    }
  }

  @MessagePattern('auth.refresh')
  async refresh(
    @Payload() data: { refreshToken: string; refreshRequestId?: string },
  ) {
    try {
      return await this.refreshTokenUseCase.execute(
        data.refreshToken,
        data.refreshRequestId,
      );
    } catch (error) {
      console.error(error);
      throw new RpcException({
        statusCode: 401,
        message: 'Invalid or expired refresh token',
      });
    }
  }

  @MessagePattern('auth.logout')
  async logout(@Payload() data: { refreshToken: string }) {
    return await this.logoutUseCase.execute(data.refreshToken);
  }

  @MessagePattern('auth.login_google')
  async loginGoogle(@Payload() profile: GoogleProfile) {
    return await this.googleLoginUseCase.execute(profile);
  }

  @MessagePattern('auth.forgot_password')
  async handleForgotPassword(@Payload() dto: ForgotPasswordDto) {
    return await this.forgotPasswordUseCase.execute(dto);
  }

  @MessagePattern('auth.reset_password')
  async handleResetPassword(@Payload() dto: ResetPasswordDto) {
    try {
      return await this.resetPasswordUseCase.execute(dto);
    } catch (error) {
      if (error instanceof InvalidResetTokenError) {
        throw new RpcException({
          statusCode: 400,
          message: error.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: 'Internal Server Error',
      });
    }
  }

  @MessagePattern('auth.verify_google_token')
  async verifyGoogleToken(@Payload() dto: VerifyGoogleTokenDto) {
    try {
      return await this.verifyGoogleTokenUseCase.execute(dto.idToken);
    } catch (error) {
      console.error(error);

      if (error instanceof InvalidGoogleTokenError) {
        throw new RpcException({
          statusCode: 401,
          message: error.message,
        });
      }

      if (error instanceof GoogleAuthNotConfiguredError) {
        throw new RpcException({
          statusCode: 500,
          message: error.message,
        });
      }

      if (error instanceof SagaCompensationError) {
        throw new RpcException({
          statusCode: 500,
          message: error.message,
        });
      }

      throw new RpcException({
        statusCode: 500,
        message: 'Internal Server Error',
      });
    }
  }
}
