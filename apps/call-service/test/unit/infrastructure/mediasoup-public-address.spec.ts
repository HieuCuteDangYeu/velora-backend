import { MediasoupPublicAddress } from '../../../src/infrastructure/engines/mediasoup-public-address';
import type { StunServer } from '../../../src/infrastructure/engines/stun-public-ip';

const OLD_IP = '203.0.113.7';
const NEW_IP = '198.51.100.20';
const OTHER_IP = '192.0.2.44';

const stunEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  MEDIASOUP_ANNOUNCED_IP_MODE: 'stun',
  MEDIASOUP_ANNOUNCED_IP: OLD_IP,
  ...overrides,
});

const answers = (...results: Array<string | Error>) => {
  const lookup = jest.fn<Promise<string>, [StunServer]>();
  for (const result of results) {
    if (result instanceof Error) lookup.mockRejectedValueOnce(result);
    else lookup.mockResolvedValueOnce(result);
  }
  return lookup;
};

const candidate = (address: string) => ({
  foundation: 'udpcandidate',
  priority: 1076302079,
  ip: address,
  address,
  protocol: 'udp' as const,
  port: 40000,
  type: 'host' as const,
});

describe('MediasoupPublicAddress static mode', () => {
  it('keeps today’s configured address and never asks STUN', async () => {
    const lookup = answers();
    const publicAddress = new MediasoupPublicAddress(
      { NODE_ENV: 'production', MEDIASOUP_ANNOUNCED_IP: ` ${OLD_IP} ` },
      lookup,
    );

    await publicAddress.initialize();
    await publicAddress.check();

    expect(lookup).not.toHaveBeenCalled();
    expect(publicAddress.current()).toBe(OLD_IP);
    expect(publicAddress.announce([candidate('10.0.0.1')])).toEqual([
      candidate('10.0.0.1'),
    ]);
    expect(publicAddress.status()).toEqual(
      expect.objectContaining({ detectionEnabled: false }),
    );
  });

  it('still requires a public address in production', async () => {
    await expect(
      new MediasoupPublicAddress({ NODE_ENV: 'production' }).initialize(),
    ).rejects.toThrow('MEDIASOUP_ANNOUNCED_IP must be configured');
  });

  it('rejects an unknown mode', () => {
    expect(
      () => new MediasoupPublicAddress({ MEDIASOUP_ANNOUNCED_IP_MODE: 'auto' }),
    ).toThrow('MEDIASOUP_ANNOUNCED_IP_MODE must be static or stun');
  });
});

describe('MediasoupPublicAddress STUN startup', () => {
  it('announces the detected address instead of the fallback', async () => {
    const lookup = answers(NEW_IP);
    const publicAddress = new MediasoupPublicAddress(
      stunEnv(),
      lookup,
      () => 1_700_000_000_000,
    );

    await publicAddress.initialize();

    expect(lookup).toHaveBeenCalledWith({
      host: 'stun.relay.metered.ca',
      port: 80,
    });
    expect(publicAddress.current()).toBe(NEW_IP);
    expect(publicAddress.status()).toEqual({
      detectionEnabled: true,
      lastCheckSucceeded: true,
      lastSuccessTimestampSeconds: 1_700_000_000,
      changes: 0,
      mismatch: false,
    });
  });

  it('skips failed and private answers and tries the next server', async () => {
    const lookup = answers(new Error('timeout'), '192.168.1.9', NEW_IP);
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({
        MEDIASOUP_PUBLIC_IP_STUN_SERVERS:
          'a.example:3478,b.example:3478,c.example:19302',
      }),
      lookup,
    );

    await publicAddress.initialize();

    expect(lookup.mock.calls.map(([server]) => server.host)).toEqual([
      'a.example',
      'b.example',
      'c.example',
    ]);
    expect(publicAddress.current()).toBe(NEW_IP);
  });

  it('falls back to MEDIASOUP_ANNOUNCED_IP when no server answers', async () => {
    const publicAddress = new MediasoupPublicAddress(
      stunEnv(),
      jest.fn().mockRejectedValue(new Error('timeout')),
    );

    await publicAddress.initialize();

    expect(publicAddress.current()).toBe(OLD_IP);
    expect(publicAddress.status()).toEqual(
      expect.objectContaining({
        lastCheckSucceeded: false,
        lastSuccessTimestampSeconds: 0,
      }),
    );
  });

  it('refuses to start in production with neither an answer nor a fallback', async () => {
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ MEDIASOUP_ANNOUNCED_IP: '' }),
      jest.fn().mockRejectedValue(new Error('timeout')),
    );

    await expect(publicAddress.initialize()).rejects.toThrow(
      'MEDIASOUP_ANNOUNCED_IP_MODE=stun found no public IPv4 and MEDIASOUP_ANNOUNCED_IP has no fallback',
    );
  });

  it('starts without an address outside production', async () => {
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ NODE_ENV: 'development', MEDIASOUP_ANNOUNCED_IP: '' }),
      jest.fn().mockRejectedValue(new Error('timeout')),
    );

    await expect(publicAddress.initialize()).resolves.toBeUndefined();
    expect(publicAddress.current()).toBeUndefined();
  });

  it('rejects an invalid fallback even when STUN would answer', async () => {
    const lookup = answers(NEW_IP);
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ MEDIASOUP_ANNOUNCED_IP: '192.168.1.9' }),
      lookup,
    );

    await expect(publicAddress.initialize()).rejects.toThrow(
      'must not be a private, loopback, link-local, or reserved address',
    );
  });
});

describe('MediasoupPublicAddress rechecks', () => {
  const started = async (...results: Array<string | Error>) => {
    const lookup = answers(OLD_IP, ...results);
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ MEDIASOUP_PUBLIC_IP_STUN_SERVERS: 'stun.example:3478' }),
      lookup,
    );
    await publicAddress.initialize();
    return publicAddress;
  };

  it('moves new transports to a new address after two identical answers', async () => {
    const publicAddress = await started(NEW_IP, NEW_IP);

    await publicAddress.check();
    expect(publicAddress.current()).toBe(OLD_IP);
    expect(publicAddress.status()).toEqual(
      expect.objectContaining({ mismatch: true, changes: 0 }),
    );

    await publicAddress.check();
    expect(publicAddress.current()).toBe(NEW_IP);
    expect(publicAddress.status()).toEqual(
      expect.objectContaining({ mismatch: false, changes: 1 }),
    );
    expect(publicAddress.announce([candidate(OLD_IP)])).toEqual([
      candidate(NEW_IP),
    ]);
  });

  it('ignores a single odd answer', async () => {
    const publicAddress = await started(NEW_IP, OLD_IP, NEW_IP);

    await publicAddress.check();
    await publicAddress.check();
    await publicAddress.check();

    expect(publicAddress.current()).toBe(OLD_IP);
    expect(publicAddress.status().changes).toBe(0);
  });

  it('needs two answers for the same new address', async () => {
    const publicAddress = await started(NEW_IP, OTHER_IP, OTHER_IP);

    await publicAddress.check();
    await publicAddress.check();
    expect(publicAddress.current()).toBe(OLD_IP);

    await publicAddress.check();
    expect(publicAddress.current()).toBe(OTHER_IP);
  });

  it('keeps the last known address while checks fail', async () => {
    const publicAddress = await started(new Error('timeout'));

    await publicAddress.check();

    expect(publicAddress.current()).toBe(OLD_IP);
    expect(publicAddress.status()).toEqual(
      expect.objectContaining({ lastCheckSucceeded: false, mismatch: false }),
    );
  });

  it('runs one lookup round for overlapping checks', async () => {
    let answer: (address: string) => void = () => undefined;
    const lookup = answers(OLD_IP).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ MEDIASOUP_PUBLIC_IP_STUN_SERVERS: 'stun.example:3478' }),
      lookup,
    );
    await publicAddress.initialize();

    const first = publicAddress.check();
    const second = publicAddress.check();
    answer(OLD_IP);
    await Promise.all([first, second]);

    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('leaves candidates that already carry the current address untouched', async () => {
    const publicAddress = await started();
    const current = candidate(OLD_IP);

    expect(publicAddress.announce([current])[0]).toBe(current);
  });
});

describe('MediasoupPublicAddress timer', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rechecks on the interval until stopped', async () => {
    const lookup = jest.fn().mockResolvedValue(OLD_IP);
    const publicAddress = new MediasoupPublicAddress(
      stunEnv({ MEDIASOUP_PUBLIC_IP_STUN_SERVERS: 'stun.example:3478' }),
      lookup,
    );
    await publicAddress.initialize();

    publicAddress.start(30_000);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lookup).toHaveBeenCalledTimes(3);

    publicAddress.stop();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('does not schedule checks in static mode', () => {
    const publicAddress = new MediasoupPublicAddress({});

    publicAddress.start(30_000);

    expect(jest.getTimerCount()).toBe(0);
  });
});
