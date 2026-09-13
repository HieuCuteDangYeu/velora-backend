import { getCallSocketHeartbeatConfig } from '../../../src/infrastructure/gateways/call-socket-config';

describe('Call Socket heartbeat configuration', () => {
  it('uses mobile-safe defaults', () => {
    expect(getCallSocketHeartbeatConfig({})).toEqual({
      pingInterval: 25_000,
      pingTimeout: 20_000,
    });
  });

  it('accepts explicit durations', () => {
    expect(
      getCallSocketHeartbeatConfig({
        CALL_SOCKET_PING_INTERVAL_MS: '30000.9',
        CALL_SOCKET_PING_TIMEOUT_MS: '15000',
      }),
    ).toEqual({ pingInterval: 30_000, pingTimeout: 15_000 });
  });

  it.each([
    ['CALL_SOCKET_PING_INTERVAL_MS', { CALL_SOCKET_PING_INTERVAL_MS: '9999' }],
    ['CALL_SOCKET_PING_TIMEOUT_MS', { CALL_SOCKET_PING_TIMEOUT_MS: 'invalid' }],
  ])('rejects unsafe %s values', (_, environment) => {
    expect(() => getCallSocketHeartbeatConfig(environment)).toThrow(
      'finite duration of at least 10000ms',
    );
  });
});
