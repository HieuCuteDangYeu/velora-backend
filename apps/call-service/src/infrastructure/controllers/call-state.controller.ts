import { Controller, ForbiddenException, Inject } from '@nestjs/common';
import { ClientProxy, MessagePattern, Payload } from '@nestjs/microservices';
import { assertCurrentGroupMember } from '../../application/use-cases/assert-current-group-member';
import {
  getSessionExpiryDate,
  getSessionRingTimeoutMs,
} from '../../domain/call-lifecycle-config';
import type { ICallSessionRepository } from '../../domain/interfaces/call-session.repository.interface';

type GetCallStatePayload = {
  callId?: string;
  conversationId?: string;
  userId?: string;
};

@Controller()
export class CallStateController {
  constructor(
    @Inject('ICallSessionRepository')
    private readonly sessionRepository: ICallSessionRepository,
    @Inject('CONVERSATION_SERVICE_RMQ')
    private readonly conversationClient: ClientProxy,
  ) {}

  @MessagePattern('call.get_active_group_by_conversation')
  async getActiveGroupByConversation(@Payload() payload: GetCallStatePayload) {
    if (!payload.conversationId || !payload.userId) return { call: null };
    try {
      await assertCurrentGroupMember(
        this.conversationClient,
        payload.conversationId,
        payload.userId,
      );
    } catch (error) {
      if (error instanceof ForbiddenException) return { call: null };
      throw error;
    }
    const session =
      await this.sessionRepository.findActiveGroupCallByConversationId(
        payload.conversationId,
      );
    if (!session) return { call: null };
    return {
      call: {
        callId: session.callId,
        conversationId: session.conversationId,
        participantCount: session.participantIds.length,
        startedAt: (session.answeredAt ?? session.createdAt).toISOString(),
        elapsedSeconds: Math.max(
          0,
          Math.floor(
            (Date.now() - (session.answeredAt ?? session.createdAt).getTime()) /
              1000,
          ),
        ),
        joined: session.participantIds.includes(payload.userId),
      },
    };
  }

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
      session.invitedUserIds.includes(payload.userId) ||
      session.participantIds.includes(payload.userId);

    if (!authorized) {
      return {
        found: true,
        authorized: false,
      };
    }

    if (session.isGroupCall) {
      try {
        await assertCurrentGroupMember(
          this.conversationClient,
          session.conversationId,
          payload.userId,
        );
      } catch (error) {
        if (error instanceof ForbiddenException) {
          return { found: true, authorized: false };
        }
        throw error;
      }
    }

    return {
      found: true,
      authorized: true,
      call: {
        callId: session.callId,
        conversationId: session.conversationId,
        initiatorId: session.initiatorId,
        targetUserId: session.targetUserId,
        recipientUserId: payload.userId,
        callType: session.callType,
        status:
          session.isGroupCall &&
          session.status === 'active' &&
          session.declinedUserIds.includes(payload.userId)
            ? 'rejected'
            : session.isGroupCall &&
                session.status === 'active' &&
                !session.participantIds.includes(payload.userId)
              ? session.expiresAt && session.expiresAt <= new Date()
                ? 'ended'
                : 'ringing'
              : session.status,
        initiatorDisplayName: session.initiatorDisplayName ?? 'Incoming call',
        initiatorAvatarUrl: session.initiatorAvatarUrl,
        isGroupCall: session.isGroupCall,
        groupName: session.groupName,
        groupAvatarUrl: session.groupAvatarUrl,
        ringTimeoutMs: getSessionRingTimeoutMs(session.ringTimeoutMs),
        expiresAt: getSessionExpiryDate(
          session.expiresAt,
          session.ringTimeoutMs,
        ).toISOString(),
      },
    };
  }
}
