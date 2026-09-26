import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';

export async function assertCurrentGroupMember(
  conversationClient: ClientProxy,
  conversationId: string,
  userId: string,
): Promise<void> {
  let conversation: {
    id: string;
    isGroup: boolean;
    participantIds: string[];
  };
  try {
    conversation = await lastValueFrom(
      conversationClient
        .send<{
          id: string;
          isGroup: boolean;
          participantIds: string[];
        }>('get_conversation_detail', { id: conversationId, userId })
        .pipe(timeout(5000)),
    );
  } catch (error: unknown) {
    const message =
      error &&
      typeof error === 'object' &&
      'message' in error &&
      typeof error.message === 'string'
        ? error.message
        : '';
    if (
      message.includes('not a participant') ||
      message.includes('Conversation not found')
    ) {
      throw new ForbiddenException('Not a current group member');
    }
    throw new ServiceUnavailableException('Group membership unavailable');
  }
  if (
    conversation?.id !== conversationId ||
    !conversation.isGroup ||
    !Array.isArray(conversation.participantIds) ||
    !conversation.participantIds.includes(userId)
  ) {
    throw new ForbiddenException('Not a current group member');
  }
}
