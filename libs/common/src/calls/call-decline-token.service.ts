import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Lets the Android notification Decline button reject one invitation over
 * HTTP while the app process is dead and no call socket exists. The token is
 * minted per recipient into the incoming-call push and only authorizes that
 * recipient declining that invitation until shortly after it stops ringing.
 */
export type CallDeclineTokenPayload = {
  callId: string;
  userId: string;
  /** Group invitation being declined; absent for a 1:1 call. */
  invitationId?: string;
  expiresAt: number;
};

// A decline tapped right at the end of the ring still reaches the server.
const DECLINE_TOKEN_GRACE_MS = 60_000;
// Domain separation: a telemetry token signed with the same secret can never
// verify as a decline token, and the other way round.
const SIGNATURE_CONTEXT = 'call-decline:';

@Injectable()
export class CallDeclineTokenService {
  constructor(private readonly configService: ConfigService) {}

  issue(input: {
    callId: string;
    userId: string;
    invitationId?: string;
    ringExpiresAt: Date;
  }): string {
    const payload: CallDeclineTokenPayload = {
      callId: input.callId,
      userId: input.userId,
      ...(input.invitationId ? { invitationId: input.invitationId } : {}),
      expiresAt: input.ringExpiresAt.getTime() + DECLINE_TOKEN_GRACE_MS,
    };
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
      'base64url',
    );
    return `${encodedPayload}.${this.sign(encodedPayload)}`;
  }

  verify(token: string, now = Date.now()): CallDeclineTokenPayload | null {
    const [encodedPayload, signature, extra] = token.split('.');
    if (!encodedPayload || !signature || extra !== undefined) return null;

    const expectedSignature = this.sign(encodedPayload);
    if (signature.length !== expectedSignature.length) return null;
    if (
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    )
      return null;

    try {
      const payload = JSON.parse(
        Buffer.from(encodedPayload, 'base64url').toString('utf8'),
      ) as Partial<CallDeclineTokenPayload>;
      if (
        typeof payload.callId !== 'string' ||
        !payload.callId ||
        typeof payload.userId !== 'string' ||
        !payload.userId ||
        (payload.invitationId !== undefined &&
          (typeof payload.invitationId !== 'string' ||
            !payload.invitationId)) ||
        typeof payload.expiresAt !== 'number' ||
        payload.expiresAt <= now
      )
        return null;
      return {
        callId: payload.callId,
        userId: payload.userId,
        ...(payload.invitationId ? { invitationId: payload.invitationId } : {}),
        expiresAt: payload.expiresAt,
      };
    } catch {
      return null;
    }
  }

  private sign(value: string) {
    // Same secret as the call telemetry token, so no new deployment variable.
    const configuredSecret = this.configService.get<string>(
      'CALL_TELEMETRY_SECRET',
    );
    if (!configuredSecret && process.env.NODE_ENV === 'production') {
      throw new Error('CALL_TELEMETRY_SECRET is required in production');
    }

    return createHmac(
      'sha256',
      configuredSecret || 'development-call-telemetry-secret',
    )
      .update(`${SIGNATURE_CONTEXT}${value}`)
      .digest('base64url');
  }
}
