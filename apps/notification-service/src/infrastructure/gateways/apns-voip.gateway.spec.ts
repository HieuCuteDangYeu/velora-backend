import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as http2 from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Logger } from '@nestjs/common';

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
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
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

  const createSession = (request: EventEmitter) =>
    Object.assign(new EventEmitter(), {
      request: jest.fn().mockReturnValue(request),
      close: jest.fn(),
      destroy: jest.fn(),
    });

  const sendInput = () => ({
    token: 'device-token',
    bundleId: 'com.example.velora',
    deliveryEnvironment: 'development' as const,
    payload: {
      aps: { 'content-available': 1 },
      type: 'INCOMING_CALL' as const,
      callId: 'call-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    },
  });

  const createGateway = () =>
    new ApnsVoipGateway({ recordApnsRequest: jest.fn() } as never);

  const newRequest = () =>
    Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });

  /** Every connect returns a fresh session so a retry can be observed. */
  const mockFreshSessions = () => {
    const sessions: ReturnType<typeof createSession>[] = [];
    const requests: EventEmitter[] = [];
    jest.mocked(http2.connect).mockImplementation(() => {
      const request = newRequest();
      const session = createSession(request);
      requests.push(request);
      sessions.push(session);
      return session as unknown as http2.ClientHttp2Session;
    });
    return { sessions, requests };
  };

  const waitForRetry = () => new Promise((done) => setTimeout(done, 250));

  it('signs APNs provider JWT with raw ES256 signature bytes', () => {
    configureApnsCredentials();

    const gateway = createGateway();
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
    const session = createSession(request);
    const connect = jest.mocked(http2.connect);
    connect.mockReturnValue(session as unknown as http2.ClientHttp2Session);
    const gateway = createGateway();

    const sending = gateway.send(sendInput());
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

  it('turns session errors on both attempts into a transport failure', async () => {
    configureApnsCredentials();
    const { sessions } = mockFreshSessions();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const sending = createGateway().send(sendInput());
    sessions[0].emit(
      'error',
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );
    await waitForRetry();
    sessions[1].emit('error', new Error('connect reset'));

    await expect(sending).rejects.toMatchObject({
      code: 'apns/transport_error',
    });
    expect(http2.connect).toHaveBeenCalledTimes(2);
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(sessions[1].destroy).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining(
        '(retrying): stage=session_error cause=ETIMEDOUT',
      ),
      expect.stringContaining('(giving up): stage=session_error cause=none'),
    ]);
    expect(String(warn.mock.calls)).not.toContain('device-token');
    warn.mockRestore();
  });

  it('retries a transport failure once on a fresh connection and succeeds', async () => {
    configureApnsCredentials();
    const { sessions, requests } = mockFreshSessions();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const sending = createGateway().send(sendInput());
    requests[0].emit('close');
    await waitForRetry();
    requests[1].emit('response', { ':status': 200 });
    requests[1].emit('end');

    await expect(sending).resolves.toBeUndefined();
    expect(http2.connect).toHaveBeenCalledTimes(2);
    expect(sessions[1].close).toHaveBeenCalledTimes(1);
  });

  it('does not retry an APNs rejection', async () => {
    configureApnsCredentials();
    const { requests } = mockFreshSessions();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const sending = createGateway().send(sendInput());
    requests[0].emit('response', { ':status': 400 });
    requests[0].emit('data', JSON.stringify({ reason: 'BadDeviceToken' }));
    requests[0].emit('end');

    await expect(sending).rejects.toMatchObject({
      code: 'apns/BadDeviceToken',
    });
    expect(http2.connect).toHaveBeenCalledTimes(1);
  });

  it('settles once when request and session fail together', async () => {
    configureApnsCredentials();
    const { sessions, requests } = mockFreshSessions();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const sending = createGateway().send(sendInput());
    requests[0].emit('error', new Error('stream reset'));
    sessions[0].emit('error', new Error('connect reset'));
    await waitForRetry();
    requests[1].emit('error', new Error('stream reset'));
    sessions[1].emit('error', new Error('connect reset'));

    await expect(sending).rejects.toMatchObject({
      code: 'apns/transport_error',
    });
    expect(sessions[0].destroy).toHaveBeenCalledTimes(1);
    expect(sessions[1].destroy).toHaveBeenCalledTimes(1);
  });

  it('times out the APNs request and returns a retryable delivery failure', async () => {
    jest.useFakeTimers();
    configureApnsCredentials();
    const request = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });
    const session = createSession(request);
    jest
      .mocked(http2.connect)
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);

    const sending = createGateway().send(sendInput());
    const assertion = expect(sending).rejects.toMatchObject({
      code: 'apns/timeout',
    });
    jest.advanceTimersByTime(5_000);

    await assertion;
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('treats GOAWAY as a transport failure', async () => {
    configureApnsCredentials();
    const { sessions } = mockFreshSessions();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();

    const sending = createGateway().send(sendInput());
    sessions[0].emit('goaway');
    await waitForRetry();
    sessions[1].emit('goaway');

    await expect(sending).rejects.toMatchObject({
      code: 'apns/transport_error',
    });
  });

  it('ignores a late session error after a successful response', async () => {
    configureApnsCredentials();
    const request = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });
    const session = createSession(request);
    jest
      .mocked(http2.connect)
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);

    const sending = createGateway().send(sendInput());
    request.emit('response', { ':status': 200 });
    request.emit('end');

    await expect(sending).resolves.toBeUndefined();
    expect(() =>
      session.emit('error', new Error('late socket error')),
    ).not.toThrow();
  });

  it('normalizes non-success APNs responses while preserving known invalid-token codes', async () => {
    configureApnsCredentials();
    const request = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });
    const session = createSession(request);
    jest
      .mocked(http2.connect)
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);

    const sending = createGateway().send(sendInput());
    request.emit('response', { ':status': 410 });
    request.emit('data', JSON.stringify({ reason: 'Unregistered' }));
    request.emit('end');

    await expect(sending).rejects.toMatchObject({ code: 'apns/Unregistered' });
  });

  it('logs the APNs rejection reason without the device token', async () => {
    configureApnsCredentials();
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const request = Object.assign(new EventEmitter(), {
      setEncoding: jest.fn(),
      end: jest.fn(),
    });
    const session = createSession(request);
    jest
      .mocked(http2.connect)
      .mockReturnValue(session as unknown as http2.ClientHttp2Session);

    const sending = createGateway().send(sendInput());
    request.emit('response', { ':status': 403 });
    request.emit('data', JSON.stringify({ reason: 'InvalidProviderToken' }));
    request.emit('end');

    await expect(sending).rejects.toMatchObject({ code: 'apns/http_error' });
    expect(warn).toHaveBeenCalledWith(
      'APNs VoIP push rejected: status=403 reason=InvalidProviderToken environment=development topic=com.example.velora.voip',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('device-token');
    warn.mockRestore();
  });

  it('rejects an unsafe APNs timeout configuration', async () => {
    configureApnsCredentials();
    process.env.NOTIFICATION_APNS_REQUEST_TIMEOUT_MS = '999';

    await expect(createGateway().send(sendInput())).rejects.toThrow(
      'NOTIFICATION_APNS_REQUEST_TIMEOUT_MS must be an integer between 1000 and 15000',
    );
  });
});
