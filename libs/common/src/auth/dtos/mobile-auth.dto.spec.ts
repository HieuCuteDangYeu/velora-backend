import { MobileLogoutSchema } from './mobile-logout.dto';
import { MobileRefreshSchema } from './mobile-refresh.dto';

describe('mobile auth DTO validation', () => {
  it('requires a non-empty refresh token for mobile refresh', () => {
    expect(MobileRefreshSchema.safeParse({}).success).toBe(false);
    expect(MobileRefreshSchema.safeParse({ refreshToken: '' }).success).toBe(
      false,
    );
    expect(
      MobileRefreshSchema.safeParse({ refreshToken: 'refresh-token' }).success,
    ).toBe(true);
    expect(
      MobileRefreshSchema.safeParse({
        refreshToken: 'refresh-token',
        refreshRequestId: '00000000-0000-4000-8000-000000000000',
      }).success,
    ).toBe(true);
    expect(
      MobileRefreshSchema.safeParse({
        refreshToken: 'refresh-token',
        refreshRequestId: 'not-a-uuid',
      }).success,
    ).toBe(false);
  });

  it('requires a non-empty refresh token for mobile logout', () => {
    expect(MobileLogoutSchema.safeParse({}).success).toBe(false);
    expect(MobileLogoutSchema.safeParse({ refreshToken: '' }).success).toBe(
      false,
    );
    expect(
      MobileLogoutSchema.safeParse({ refreshToken: 'refresh-token' }).success,
    ).toBe(true);
    expect(
      MobileLogoutSchema.safeParse({
        refreshToken: 'refresh-token',
        pushTokens: [
          { provider: 'fcm', token: 'fcm-token-that-is-long-enough' },
          { provider: 'apns_voip', token: 'voip-token-that-is-long-enough' },
        ],
      }).success,
    ).toBe(true);
  });
});
