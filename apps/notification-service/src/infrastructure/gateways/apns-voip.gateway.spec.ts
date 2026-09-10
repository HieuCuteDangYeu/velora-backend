import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApnsVoipGateway } from './apns-voip.gateway';

jest.mock('node:http2', () => {
  const actual = jest.requireActual<typeof import('node:http2')>('node:http2');
  return { ...actual, connect: jest.fn() };
});

describe('ApnsVoipGateway', () => {
  const originalEnv = process.env;
  let tempDir: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    tempDir = mkdtempSync(join(tmpdir(), 'velora-apns-'));
  });

  afterEach(() => {
    jest.clearAllMocks();
    process.env = originalEnv;
    rmSync(tempDir, { force: true, recursive: true });
  });

  const configureApnsCredentials = () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const privateKeyPath = join(tempDir, 'AuthKey_TEST.p8');

    writeFileSync(
      privateKeyPath,
      privateKey.export({ format: 'pem', type: 'pkcs8' }),
      'utf8',
    );
    process.env.NOTIFICATION_APNS_TEAM_ID = 'TEAM123456';
    process.env.NOTIFICATION_APNS_KEY_ID = 'KEY1234567';
    process.env.NOTIFICATION_APNS_PRIVATE_KEY_PATH = privateKeyPath;
  };

  it('signs APNs provider JWT with raw ES256 signature bytes', () => {
    configureApnsCredentials();

    const gateway = new ApnsVoipGateway();
    const token = (
      gateway as unknown as {
        getJwt: () => string;
      }
    ).getJwt();
    const [, , signature] = token.split('.');

    expect(Buffer.from(signature, 'base64url')).toHaveLength(64);
  });

  it('uses immediate APNs expiry even when the call itself expires later', async () => {
    configureApnsCredentials();
    const request = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });
    const session = {
      request: jest.fn().mockReturnValue(request),
      close: jest.fn(),
      destroy: jest.fn(),
    };
    const connect = jest.mocked(http2.connect);
    connect.mockReturnValue(session as unknown as http2.ClientHttp2Session);
    const gateway = new ApnsVoipGateway();

    const sending = gateway.send({
      token: 'device-token',
      bundleId: 'com.example.velora',
      deliveryEnvironment: 'development',
      payload: {
        aps: { 'content-available': 1 },
        type: 'INCOMING_CALL',
        callId: 'call-1',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    });
    request.emit('response', { ':status': 200 });
    request.emit('end');

    await expect(sending).resolves.toBeUndefined();
    expect(connect).toHaveBeenCalledWith('https://api.sandbox.push.apple.com');
    expect(session.request).toHaveBeenCalledWith(
      expect.objectContaining({
        'apns-push-type': 'voip',
        'apns-expiration': '0',
      }),
    );
  });
});
