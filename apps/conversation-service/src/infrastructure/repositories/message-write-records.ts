import type {
  Conversation as PrismaConversation,
  Message as PrismaMessage,
} from '@prisma/conversation-client';

export type PreparedMessageWrite = {
  data: Omit<
    PrismaMessage,
    'createdAt' | 'notificationRecipientIds' | 'notificationNextAttemptAt'
  >;
  preview: string;
  enqueueNotification: boolean;
};

// The rows a batch inserts, including the embedded notification intent that is
// committed with the message. Shared by the Prisma and the native write paths
// so both store exactly the same thing.
export function buildMessageRecords(
  writes: readonly PreparedMessageWrite[],
  conversation: Pick<PrismaConversation, 'participantIds' | 'isGroup'>,
  timestamp: Date,
): PrismaMessage[] {
  return writes.map((write): PrismaMessage => {
    const recipients = write.enqueueNotification
      ? [...new Set(conversation.participantIds)].filter(
          (id) => Boolean(id) && id !== write.data.senderId,
        )
      : [];
    const notificationRecipientIds =
      conversation.isGroup ||
      (conversation.participantIds.length === 2 && recipients.length === 1)
        ? recipients
        : [];
    return {
      ...write.data,
      createdAt: timestamp,
      notificationRecipientIds,
      notificationNextAttemptAt:
        notificationRecipientIds.length > 0 ? timestamp : null,
    };
  });
}
