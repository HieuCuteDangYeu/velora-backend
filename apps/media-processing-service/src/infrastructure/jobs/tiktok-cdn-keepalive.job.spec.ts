import { ConfigService } from '@nestjs/config';
import type { ITikTokCdnService } from '../../domain/interfaces/tiktok-cdn.service.interface';
import { TikTokCdnKeepaliveJob } from './tiktok-cdn-keepalive.job';

describe('TikTokCdnKeepaliveJob', () => {
  let job: TikTokCdnKeepaliveJob;
  let mockTiktokCdnService: jest.Mocked<ITikTokCdnService>;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(() => {
    mockTiktokCdnService = {
      processAndUploadVideoHls: jest.fn(),
      uploadHlsDirectory: jest.fn(),
      uploadImage: jest.fn(),
      validateConfig: jest.fn().mockReturnValue(true),
      pingSession: jest.fn().mockResolvedValue({
        isAlive: true,
        message: 'Session active',
        statusCode: 200,
      }),
    };

    mockConfigService = {
      get: jest.fn().mockImplementation((key: string) => {
        if (key === 'TIKTOK_CDN_ENABLED') return 'true';
        return undefined;
      }),
    } as unknown as jest.Mocked<ConfigService>;

    job = new TikTokCdnKeepaliveJob(mockTiktokCdnService, mockConfigService);
  });

  it('should ping session on application bootstrap when enabled', async () => {
    await job.onApplicationBootstrap();
    expect(mockTiktokCdnService.pingSession).toHaveBeenCalledTimes(1);
  });

  it('should not ping session when TIKTOK_CDN_ENABLED is false', async () => {
    mockConfigService.get.mockReturnValue('false');
    const disabledJob = new TikTokCdnKeepaliveJob(
      mockTiktokCdnService,
      mockConfigService,
    );

    await disabledJob.handleKeepalive();
    expect(mockTiktokCdnService.pingSession).not.toHaveBeenCalled();
  });

  it('should skip ping when credentials are not configured', async () => {
    mockTiktokCdnService.validateConfig.mockReturnValue(false);

    await job.handleKeepalive();
    expect(mockTiktokCdnService.pingSession).not.toHaveBeenCalled();
  });

  it('should handle ping session failure gracefully', async () => {
    mockTiktokCdnService.pingSession.mockResolvedValue({
      isAlive: false,
      message: 'permission error',
      statusCode: 40002,
    });

    await expect(job.handleKeepalive()).resolves.not.toThrow();
    expect(mockTiktokCdnService.pingSession).toHaveBeenCalledTimes(1);
  });

  it('should catch unexpected errors during keepalive', async () => {
    mockTiktokCdnService.pingSession.mockRejectedValue(
      new Error('Network timeout'),
    );

    await expect(job.handleKeepalive()).resolves.not.toThrow();
  });
});
