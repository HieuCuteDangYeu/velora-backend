import { validateMediasoupNetworkConfiguration } from '../../../src/infrastructure/engines/mediasoup-network-configuration';

describe('Mediasoup network configuration', () => {
  it('allows local development without an announced IP', () => {
    expect(() =>
      validateMediasoupNetworkConfiguration({ environment: 'development' }),
    ).not.toThrow();
  });

  it('requires an announced IP in production', () => {
    expect(() =>
      validateMediasoupNetworkConfiguration({ environment: 'production' }),
    ).toThrow('MEDIASOUP_ANNOUNCED_IP must be configured');
  });

  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '::1',
    'fc00::1',
  ])('rejects unroutable production addresses: %s', (announcedIp) => {
    expect(() =>
      validateMediasoupNetworkConfiguration({
        environment: 'production',
        announcedIp,
      }),
    ).toThrow(
      'must not be a private, loopback, link-local, or reserved address',
    );
  });

  it('rejects malformed production addresses', () => {
    expect(() =>
      validateMediasoupNetworkConfiguration({
        environment: 'production',
        announcedIp: 'sfu.example.com',
      }),
    ).toThrow('must be a valid IP address');
  });

  it.each(['8.8.8.8', '2606:4700:4700::1111'])(
    'accepts public production addresses: %s',
    (announcedIp) => {
      expect(() =>
        validateMediasoupNetworkConfiguration({
          environment: 'production',
          announcedIp,
        }),
      ).not.toThrow();
    },
  );
});
