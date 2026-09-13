import { ConfirmAccountDto } from '@common/auth/dtos/confirm-account.dto';
import { ForgotPasswordDto } from '@common/auth/dtos/forgot-password.dto';
import { LoginDto } from '@common/auth/dtos/login.dto';
import { LogoutDto } from '@common/auth/dtos/logout.dto';
import { MobileLogoutDto } from '@common/auth/dtos/mobile-logout.dto';
import { MobileRefreshDto } from '@common/auth/dtos/mobile-refresh.dto';
import { RegisterDto } from '@common/auth/dtos/register.dto';
import { ResendVerificationDto } from '@common/auth/dtos/resend-verification.dto';
import { ResetPasswordDto } from '@common/auth/dtos/reset-password.dto';
import { VerifyGoogleTokenDto } from '@common/auth/dtos/verify-google-token.dto';
import type { AuthUser } from '@common/auth/interfaces/auth-user.interface';
import { TokenResponse } from '@common/auth/interfaces/token.interface';
import { isRpcError } from '@common/constants/rpc-error.types';
import { CreateUserResponse } from '@common/user/interfaces/create-user-response.types';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response as ExpressResponse } from 'express';
import { catchError, lastValueFrom, timeout } from 'rxjs';

type LogoutResponse = {
  message: string;
  userId?: string;
};

type LogoutPushToken = {
  provider: 'fcm' | 'apns_voip';
  token: string;
  deviceId?: string;
  lifecycleVersion?: number;
};

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  private readonly notificationServiceUrl: string;
  private readonly notificationGatewaySecret: string | undefined;

  constructor(
    @Inject('AUTH_SERVICE') private readonly authClient: ClientProxy,
    private readonly configService: ConfigService,
  ) {
    this.notificationServiceUrl = (
      this.configService.get<string>('NOTIFICATION_SERVICE_URL') ||
      'http://localhost:3015'
    ).replace(/\/$/, '');
    this.notificationGatewaySecret = this.configService.get<string>(
      'NOTIFICATION_GATEWAY_SECRET',
    );
  }

  @Post('register')
  @ApiOperation({ summary: 'Register a new user' })
  async register(@Body() dto: RegisterDto): Promise<CreateUserResponse> {
    return await lastValueFrom(
      this.authClient.send<CreateUserResponse>('auth.register', dto).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );
  }

  @Post('login')
  @ApiOperation({ summary: 'Login and set HTTP-only cookies' })
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ) {
    const tokens = await lastValueFrom(
      this.authClient.send<TokenResponse>('auth.login', dto).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );

    this.setCookies(response, tokens.accessToken, tokens.refreshToken);

    return { message: 'Login successful' };
  }

  @Post('mobile/login')
  @ApiOperation({ summary: 'Login for mobile clients' })
  async mobileLogin(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ): Promise<TokenResponse> {
    this.setNoStore(response);

    return lastValueFrom(
      this.authClient
        .send<TokenResponse>('auth.login', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post('mobile/google/verify')
  @ApiOperation({ summary: 'Verify a Google ID token for mobile clients' })
  async mobileVerifyGoogleToken(
    @Body() dto: VerifyGoogleTokenDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ): Promise<TokenResponse> {
    this.setNoStore(response);

    return lastValueFrom(
      this.authClient
        .send<TokenResponse>('auth.verify_google_token', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post('mobile/refresh')
  @ApiOperation({ summary: 'Refresh a mobile access token' })
  async mobileRefresh(
    @Body() dto: MobileRefreshDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ): Promise<TokenResponse> {
    this.setNoStore(response);

    return lastValueFrom(
      this.authClient
        .send<TokenResponse>('auth.refresh', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post('mobile/logout')
  @ApiOperation({ summary: 'Logout a mobile client' })
  async mobileLogout(
    @Body() dto: MobileLogoutDto,
  ): Promise<{ message: string }> {
    const logoutResult = await lastValueFrom(
      this.authClient
        .send<LogoutResponse>('auth.logout', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );

    const pushTokens = this.getLogoutPushTokens(dto);
    const userId = logoutResult.userId;

    if (userId && pushTokens.length > 0) {
      try {
        await Promise.all(
          pushTokens.map((pushToken) =>
            this.forwardToNotificationService({
              path: '/notifications/push-tokens/deactivate',
              userId,
              body: pushToken,
            }),
          ),
        );
      } catch {
        // Sign-out must not be blocked by notification token cleanup.
      }
    }

    return { message: logoutResult.message };
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  @ApiOperation({ summary: 'Get current logged-in user session' })
  getProfile(@Req() request: AuthenticatedRequest): AuthUser {
    return request.user!;
  }

  @UseGuards(JwtAuthGuard)
  @Get('socket-token')
  @ApiOperation({
    summary:
      'Return the currently valid access token for authenticated WebSocket handshakes',
  })
  getSocketToken(@Req() request: AuthenticatedRequest): {
    accessToken: string;
  } {
    const accessToken =
      request.cookies?.['access_token'] || this.getBearerToken(request);

    if (!accessToken) {
      throw new HttpException('No access token found', HttpStatus.UNAUTHORIZED);
    }

    return { accessToken };
  }

  private getBearerToken(request: AuthenticatedRequest): string | undefined {
    const authHeader = request.headers['authorization'];
    if (!authHeader) return undefined;

    const [type, token] = authHeader.split(' ');
    return type === 'Bearer' ? token : undefined;
  }

  @Post('confirm')
  @ApiOperation({ summary: 'Confirm user account' })
  async confirmAccount(@Body() dto: ConfirmAccountDto) {
    return lastValueFrom(
      this.authClient
        .send<{ message: string }>('auth.confirm_account', dto)
        .pipe(
          catchError((error) => {
            this.handleMicroserviceError(error);
          }),
        ),
    );
  }

  @Post('resend-verification')
  @ApiOperation({ summary: 'Resend verification email' })
  async resendVerification(
    @Body() dto: ResendVerificationDto,
  ): Promise<{ message: string }> {
    return lastValueFrom(
      this.authClient
        .send<{ message: string }>('auth.resend_verification', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  private handleMicroserviceError(error: unknown): never {
    if (isRpcError(error)) {
      throw new HttpException(error.message, error.statusCode);
    }

    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token using cookie' })
  async refresh(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: ExpressResponse,
  ) {
    const incomingRefreshToken = request.cookies['refresh_token'];

    if (!incomingRefreshToken) {
      throw new HttpException(
        'No refresh token found',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const tokens = await lastValueFrom(
      this.authClient
        .send<TokenResponse>('auth.refresh', {
          refreshToken: incomingRefreshToken,
        })
        .pipe(
          catchError(() => {
            response.clearCookie('access_token');
            response.clearCookie('refresh_token');
            throw new HttpException(
              'Invalid refresh token',
              HttpStatus.UNAUTHORIZED,
            );
          }),
        ),
    );

    this.setCookies(response, tokens.accessToken, tokens.refreshToken);

    return { message: 'Token refreshed successfully' };
  }

  @Post('logout')
  @ApiOperation({ summary: 'Logout and clear cookies' })
  async logout(
    @Body() dto: LogoutDto | undefined,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: ExpressResponse,
  ) {
    const refreshToken = request.cookies['refresh_token'];
    let logoutResult: LogoutResponse | null = null;
    const pushTokens = this.getLogoutPushTokens(dto);

    if (pushTokens.length > 0) {
      try {
        const cleanupUser = await this.resolvePushTokenCleanupUser(request);

        await Promise.all(
          pushTokens.map((pushToken) =>
            this.forwardToNotificationService({
              path: '/notifications/push-tokens/deactivate',
              userId: cleanupUser.id,
              body: pushToken,
            }),
          ),
        );
      } catch {
        // Sign-out must not be blocked by notification token cleanup.
      }
    }

    if (refreshToken) {
      logoutResult = await lastValueFrom(
        this.authClient
          .send<LogoutResponse>('auth.logout', { refreshToken })
          .pipe(
            catchError((error) => {
              if (pushTokens.length > 0) {
                this.handleMicroserviceError(error);
              }

              return [null];
            }),
          ),
      );
    }

    response.clearCookie('access_token', {
      ...this.getCookieOptions(),
    });
    response.clearCookie('refresh_token', {
      ...this.getCookieOptions(),
    });

    return { message: logoutResult?.message ?? 'Logged out successfully' };
  }

  private async resolvePushTokenCleanupUser(
    request: AuthenticatedRequest,
  ): Promise<AuthUser> {
    const accessToken = request.cookies['access_token'];

    if (!accessToken) {
      throw new HttpException(
        'No access token found for push token cleanup',
        HttpStatus.UNAUTHORIZED,
      );
    }

    try {
      return await lastValueFrom(
        this.authClient
          .send<AuthUser>('auth.verify_token', { token: accessToken })
          .pipe(timeout(5000)),
      );
    } catch {
      throw new HttpException(
        'Unable to authenticate push token cleanup',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private getLogoutPushTokens(dto?: LogoutDto): LogoutPushToken[] {
    const tokens: LogoutPushToken[] = [];
    const legacyPushToken = dto?.pushToken?.trim();

    if (legacyPushToken) {
      tokens.push({ provider: 'fcm', token: legacyPushToken });
    }

    for (const pushToken of dto?.pushTokens ?? []) {
      const token = pushToken.token.trim();

      if (token) {
        tokens.push({
          provider: pushToken.provider,
          token,
          ...(pushToken.deviceId ? { deviceId: pushToken.deviceId } : {}),
          ...(pushToken.lifecycleVersion !== undefined
            ? { lifecycleVersion: pushToken.lifecycleVersion }
            : {}),
        });
      }
    }

    return [
      ...new Map(
        tokens.map((token) => [`${token.provider}:${token.token}`, token]),
      ).values(),
    ];
  }

  @Post('google/verify')
  @ApiOperation({
    summary: 'Verify Google ID token from Web/Mobile and set cookies',
  })
  async verifyGoogleToken(
    @Body() dto: VerifyGoogleTokenDto,
    @Res({ passthrough: true }) response: ExpressResponse,
  ) {
    const tokens = await lastValueFrom(
      this.authClient.send<TokenResponse>('auth.verify_google_token', dto).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );

    this.setCookies(response, tokens.accessToken, tokens.refreshToken);

    return { message: 'Google login successful' };
  }

  private setCookies(
    response: ExpressResponse,
    accessToken: string,
    refreshToken: string,
  ) {
    response.cookie('access_token', accessToken, {
      ...this.getCookieOptions(),
      maxAge: 15 * 60 * 1000,
    });

    response.cookie('refresh_token', refreshToken, {
      ...this.getCookieOptions(),
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
  }

  private setNoStore(response: ExpressResponse): void {
    response.setHeader('Cache-Control', 'no-store');
  }

  private getCookieOptions() {
    const sameSite: 'lax' | 'none' =
      this.configService.get<string>('AUTH_COOKIE_SAME_SITE') === 'none'
        ? 'none'
        : 'lax';

    return {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || sameSite === 'none',
      sameSite,
      path: '/',
    };
  }

  @Post('forgot-password')
  @ApiOperation({ summary: 'Send forgot password email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    return lastValueFrom(
      this.authClient
        .send<{ message: string }>('auth.forgot_password', dto)
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post('reset-password')
  @ApiOperation({ summary: 'Reset user password' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return lastValueFrom(
      this.authClient
        .send<{ message: string }>('auth.reset_password', dto)
        .pipe(catchError((err) => this.handleMicroserviceError(err))),
    );
  }

  private async forwardToNotificationService({
    path,
    userId,
    body,
  }: {
    path: string;
    userId: string;
    body: unknown;
  }) {
    if (!this.notificationGatewaySecret) {
      throw new ServiceUnavailableException(
        'Notification token registration is not configured',
      );
    }

    let response: Response;

    try {
      response = await fetch(`${this.notificationServiceUrl}${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': userId,
          'x-notification-gateway-secret': this.notificationGatewaySecret,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new HttpException(
        `Notification service unavailable: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    const responseBody = await this.readResponseBody(response);

    if (!response.ok) {
      throw new HttpException(responseBody, response.status);
    }

    return responseBody;
  }

  private async readResponseBody(
    response: Response,
  ): Promise<string | Record<string, any>> {
    const contentType = response.headers.get('content-type') ?? '';

    if (!contentType.includes('application/json')) {
      return response.text();
    }

    const data: unknown = await response.json();

    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, any>;
    }

    return {
      message: data,
    };
  }
}
