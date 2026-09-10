import { Controller, Inject } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import {
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

type GetCallStatePayload = {
  callId?: string;
  userId?: string;
};

@Controller()
export class CallStateController {
  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
  ) {}

  @MessagePattern('call.get_state')
  async getCallState(@Payload() payload: GetCallStatePayload) {
    if (!payload.callId || !payload.userId) {
      return {
        found: false,
        authorized: false,
      };
    }

    const session = await this.sessionRepository.findByCallId(payload.callId);

    if (!session) {
      return {
        found: false,
        authorized: false,
      };
    }

    const authorized =
      payload.userId === session.initiatorId ||
      payload.userId === session.targetUserId ||
      session.participantIds.includes(payload.userId);

    if (!authorized) {
      return {
        found: true,
        authorized: false,
      };
    }

    return {
      found: true,
      authorized: true,
      call: {
        callId: session.callId,
        conversationId: session.conversationId,
        initiatorId: session.initiatorId,
        targetUserId: session.targetUserId,
        recipientUserId: session.targetUserId,
        callType: session.callType,
        status: session.status,
        initiatorDisplayName: session.initiatorDisplayName ?? 'Incoming call',
        initiatorAvatarUrl: session.initiatorAvatarUrl,
        ringTimeoutMs: getSessionRingTimeoutMs(session.ringTimeoutMs),
        expiresAt: getSessionExpiryDate(
          session.expiresAt,
          session.ringTimeoutMs,
        ).toISOString(),
      },
    };
  }
}
