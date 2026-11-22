import { Logger } from '@nestjs/common';
import { deriveAccessKeyPair } from '@common/auth/access-token';
import { of, throwError } from 'rxjs';
import { AccessKeyProvider } from './access-key.provider';

describe('AccessKeyProvider', () => {
  const key = deriveAccessKeyPair(
    'provider-spec-secret-32-characters!!',
  ).publicKey;

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('loads the public key from auth-service at startup', async () => {
    const send = jest.fn(() => of([key]));
    const provider = new AccessKeyProvider({ send } as never);
    await provider.onModuleInit();
    expect(provider.current().has(key.kid)).toBe(true);
    expect(send).toHaveBeenCalledWith('auth.access_public_keys', {});
  });

  it('starts empty and keeps running when auth-service is unavailable', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const provider = new AccessKeyProvider({
      send: () => throwError(() => new Error('down')),
    } as never);
    await provider.onModuleInit();
    expect(provider.current().size).toBe(0);
  });

  it('refetches for an unknown key at most once every 30 seconds', async () => {
    jest.useFakeTimers();
    const send = jest.fn(() => of([key]));
    const provider = new AccessKeyProvider({ send } as never);
    await provider.onModuleInit();
    provider.refreshSoon();
    expect(send).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(31_000);
    provider.refreshSoon();
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(2);
  });
});
