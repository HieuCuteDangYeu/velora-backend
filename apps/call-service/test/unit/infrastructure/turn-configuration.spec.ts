import { readTurnIceServers } from '../../../src/infrastructure/engines/turn-configuration';

const config = {
  TURN_URLS:
    'turn:relay.example.com:80, turns:relay.example.com:443?transport=tcp',
  TURN_USERNAME: 'test-user',
  TURN_CREDENTIAL: 'test-password',
};

describe('TURN configuration', () => {
  it('keeps TURN optional for existing deployments', () => {
    expect(readTurnIceServers({})).toBeUndefined();
    expect(
      readTurnIceServers({
        TURN_URLS: '',
        TURN_USERNAME: '',
        TURN_CREDENTIAL: '',
      }),
    ).toBeUndefined();
  });

  it('preserves provider URLs and password while normalizing config whitespace', () => {
    expect(
      readTurnIceServers({
        ...config,
        TURN_USERNAME: ' test-user ',
        TURN_CREDENTIAL: ' password ',
      }),
    ).toEqual([
      {
        urls: [
          'turn:relay.example.com:80',
          'turns:relay.example.com:443?transport=tcp',
        ],
        username: 'test-user',
        credential: ' password ',
      },
    ]);
  });

  it.each(['TURN_URLS', 'TURN_USERNAME', 'TURN_CREDENTIAL'])(
    'rejects partial settings missing %s',
    (key) => {
      expect(() => readTurnIceServers({ ...config, [key]: '' })).toThrow(
        'must all be configured',
      );
    },
  );

  it.each([
    'https://relay.example.com',
    'turn://relay.example.com',
    'turn:relay.example.com:0',
    'turn:relay.example.com:65536',
    'turn:relay.example.com?transport=http',
    'turn:relay.example.com,',
  ])('rejects invalid URI without echoing configuration: %s', (url) => {
    expect(() => readTurnIceServers({ ...config, TURN_URLS: url })).toThrow(
      'TURN_URLS must contain valid turn: or turns: server URIs',
    );
  });
});
