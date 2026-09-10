import { DeactivatePushTokenUseCase } from './deactivate-push-token.use-case';

describe('DeactivatePushTokenUseCase lifecycle ordering', () => {
  it('ignores an older deactivate operation', async () => {
    const pushTokenRepository = {
      deactivate: jest.fn(),
    };
    const lifecycleRepository = {
      acquireLock: jest.fn().mockResolvedValue('lock-1'),
      releaseLock: jest.fn().mockResolvedValue(undefined),
      advance: jest.fn().mockResolvedValue(false),
    };
    const useCase = new DeactivatePushTokenUseCase(
      pushTokenRepository as never,
      lifecycleRepository as never,
    );
    const input = {
      provider: 'fcm' as const,
      token: 'fcm-token-that-is-long-enough',
      deviceId: 'installation-1',
      lifecycleVersion: 1,
    };

    await expect(useCase.execute('user-1', input)).resolves.toEqual({
      count: 0,
    });
    expect(pushTokenRepository.deactivate).not.toHaveBeenCalled();
    expect(lifecycleRepository.releaseLock).toHaveBeenCalledWith(
      input,
      'lock-1',
    );
  });
});
