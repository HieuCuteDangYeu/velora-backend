import { ConfigService } from '@nestjs/config';
import { CallDeclineTokenService } from './call-decline-token.service';
import { CallTelemetryTokenService } from './call-telemetry-token.service';

const config = (secret = 'test-secret') =>
  ({ get: () => secret }) as unknown as ConfigService;

describe('CallDeclineTokenService', () => {
  const ringExpiresAt = new Date('2026-10-24T10:00:30.000Z');
  const beforeExpiry = ringExpiresAt.getTime() - 1_000;

  it('round-trips the user, call and group invitation it was issued for', () => {
    const service = new CallDeclineTokenService(config());
    const token = service.issue({
      callId: 'room-1',
      userId: 'user-1',
      invitationId: 'invite-2',
      ringExpiresAt,
    });

    expect(service.verify(token, beforeExpiry)).toEqual({
      callId: 'room-1',
      userId: 'user-1',
      invitationId: 'invite-2',
      expiresAt: ringExpiresAt.getTime() + 60_000,
    });
  });

  it('omits the invitation for a 1:1 call', () => {
    const service = new CallDeclineTokenService(config());
    const token = service.issue({
      callId: 'call-1',
      userId: 'user-1',
      ringExpiresAt,
    });

    expect(service.verify(token, beforeExpiry)).toEqual({
      callId: 'call-1',
      userId: 'user-1',
      expiresAt: ringExpiresAt.getTime() + 60_000,
    });
  });

  it('stays valid for a minute after the ring ends, then expires', () => {
    const service = new CallDeclineTokenService(config());
    const token = service.issue({
      callId: 'call-1',
      userId: 'user-1',
      ringExpiresAt,
    });

    expect(
      service.verify(token, ringExpiresAt.getTime() + 59_000),
    ).not.toBeNull();
    expect(service.verify(token, ringExpiresAt.getTime() + 60_000)).toBeNull();
  });

  it('rejects a tampered payload, a foreign secret and malformed input', () => {
    const service = new CallDeclineTokenService(config());
    const token = service.issue({
      callId: 'call-1',
      userId: 'user-1',
      ringExpiresAt,
    });
    const [, signature] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        callId: 'call-1',
        userId: 'someone-else',
        expiresAt: ringExpiresAt.getTime() + 60_000,
      }),
    ).toString('base64url');

    expect(service.verify(`${forged}.${signature}`, beforeExpiry)).toBeNull();
    expect(
      new CallDeclineTokenService(config('other-secret')).verify(
        token,
        beforeExpiry,
      ),
    ).toBeNull();
    for (const malformed of ['', 'abc', 'a.b.c', `${token}.extra`]) {
      expect(service.verify(malformed, beforeExpiry)).toBeNull();
    }
  });

  it('never accepts a telemetry token signed with the same secret', () => {
    const telemetryToken = new CallTelemetryTokenService(config()).issue(
      'call-1',
      'guest',
    );

    expect(
      new CallDeclineTokenService(config()).verify(
        telemetryToken,
        beforeExpiry,
      ),
    ).toBeNull();
  });
});
