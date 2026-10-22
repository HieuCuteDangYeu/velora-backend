import { Inject, Injectable } from '@nestjs/common';
import type { CallLoggedEvent } from '@common/calls/call-history.types';

import { Message } from '../../domain/entities/message.entity';
import { IChatRepository } from '../../domain/interfaces/chat.repository.interface';
import { IConversationRealtimePublisher } from '../../domain/interfaces/conversation-realtime-publisher.interface';

/**
 * Adds one call row to the conversation for each finished call. Call history
 * itself is owned by call-service; this row only mirrors it in the chat.
 */
@Injectable()
export class CallLogService {
  constructor(
    @Inject('IChatRepository')
    private readonly chatRepository: IChatRepository,
    @Inject('IConversationRealtimePublisher')
    private readonly realtimePublisher: IConversationRealtimePublisher,
  ) {}

  /** Returns false when the conversation no longer exists. */
  async record(event: CallLoggedEvent): Promise<boolean> {
    const conversation = await this.chatRepository.findConversation(
      event.conversationId,
    );
    if (!conversation) return false;

    // A sender must be a member; a caller who has left a group since is
    // represented by the group creator, as for group system activities.
    const senderId = conversation.participantIds.includes(event.initiatorId)
      ? event.initiatorId
      : conversation.creatorId;

    const message = new Message({
      conversationId: event.conversationId,
      senderId,
      // One row per call: replays of `call.logged` hit the unique index.
      clientMessageId: `call:${event.callId}`,
      content: buildCallLogContent(event),
      type: 'text',
      metadata: {
        kind: 'call_log',
        callLog: {
          callId: event.callId,
          callType: event.callType,
          isGroupCall: event.isGroupCall,
          initiatorId: event.initiatorId,
          outcome: event.outcome,
          ...(event.terminalReason
            ? { terminalReason: event.terminalReason }
            : {}),
          ...(event.durationSec !== undefined
            ? { durationSec: event.durationSec }
            : {}),
          participants: event.participants,
        },
      },
      // Placed when the call ended, not when it started: a row inserted in the
      // past could be skipped by clients syncing only newer messages.
      createdAt: new Date(),
      readBy: [],
    });

    const result = await this.chatRepository.createMessageIdempotently(message);
    if (!result.created) return true;

    this.realtimePublisher.emitNewMessage(event.conversationId, result.message);
    const updatedConversation = await this.chatRepository.findConversation(
      event.conversationId,
    );
    if (updatedConversation) {
      this.realtimePublisher.emitConversationUpdated(updatedConversation);
    }
    return true;
  }
}

/** Neutral text for the sidebar preview; clients render their own wording. */
export function buildCallLogContent(event: CallLoggedEvent): string {
  const kind = `${event.isGroupCall ? 'group ' : ''}${
    event.callType === 'VIDEO' ? 'video' : 'voice'
  } call`;
  const label = kind.charAt(0).toUpperCase() + kind.slice(1);

  switch (event.outcome) {
    case 'COMPLETED':
      return event.durationSec !== undefined
        ? `${label} · ${formatDuration(event.durationSec)}`
        : label;
    case 'MISSED':
      return `Missed ${kind}`;
    case 'DECLINED':
      return `Declined ${kind}`;
    case 'FAILED':
      return `${label} failed`;
  }
}

function formatDuration(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}
