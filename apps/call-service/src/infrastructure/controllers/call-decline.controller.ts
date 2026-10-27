import { Controller, HttpException, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { CallDeclineTokenService } from '@common/calls/call-decline-token.service';
import { CallGateway } from '../gateways/call.gateway';
import { safeCallErrorCode, shortCallIdentifier } from '../gateways/call-debug';

type DeclineWithTokenPayload = {
  callId?: unknown;
  token?: unknown;
};

export type DeclineWithTokenResult =
  | { ok: true }
  | { ok: false; reason: 'invalid_token' | 'not_declinable' };

/**
 * The Android notification Decline button posts here (through the gateway)
 * when the app process is dead, so there is no call socket. The signed token
 * from the incoming-call push is the only credential and names the user and
 * the invitation it may decline.
 */
@Controller()
export class CallDeclineController {
  private readonly logger = new Logger(CallDeclineController.name);

  constructor(
    private readonly declineTokenService: CallDeclineTokenService,
    private readonly callGateway: CallGateway,
  ) {}

  @MessagePattern('call.decline_with_token')
  async declineWithToken(
    @Payload() payload: DeclineWithTokenPayload,
  ): Promise<DeclineWithTokenResult> {
    if (
      typeof payload?.token !== 'string' ||
      typeof payload.callId !== 'string'
    )
      return { ok: false, reason: 'invalid_token' };

    const token = this.declineTokenService.verify(payload.token);
    // The push carries the invitation id as its call id for a group re-invite.
    if (
      !token ||
      (payload.callId !== token.callId && payload.callId !== token.invitationId)
    )
      return { ok: false, reason: 'invalid_token' };

    try {
      await this.callGateway.rejectForUser(
        {
          callId: token.callId,
          ...(token.invitationId ? { invitationId: token.invitationId } : {}),
        },
        token.userId,
      );
      return { ok: true };
    } catch (error) {
      // Already answered, ended, or no longer this user's invitation: the
      // ring has nothing left to decline.
      if (error instanceof HttpException)
        return { ok: false, reason: 'not_declinable' };
      this.logger.warn(
        `Push decline failed call=${shortCallIdentifier(token.callId)} errorCode=${safeCallErrorCode(error)}`,
      );
      throw error;
    }
  }
}
