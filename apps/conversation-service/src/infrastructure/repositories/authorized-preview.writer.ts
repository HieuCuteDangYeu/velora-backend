import {
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Conversation, Prisma } from '@prisma/conversation-client';
import { z } from 'zod';

const bsonDate = z
  .union([
    z
      .object({ $date: z.iso.datetime() })
      .transform(({ $date }) => new Date($date)),
    z
      .object({ $date: z.object({ $numberLong: z.string().regex(/^-?\d+$/) }) })
      .transform(({ $date }) => new Date(Number($date.$numberLong))),
  ])
  .refine((value) => Number.isFinite(value.getTime()));

const snapshot = z.object({
  _id: z.object({ $oid: z.string().regex(/^[a-f0-9]{24}$/i) }),
  creator_id: z.string(),
  participantIds: z.array(z.string()),
  isGroup: z.boolean(),
  name: z.string().nullish(),
  picture: z.string().nullish(),
  memberJoinedAt: z.json().nullish(),
  createdAt: bsonDate,
  updatedAt: bsonDate,
  lastMessage: z.string(),
  lastMessageAt: bsonDate,
});

// Must run on the transaction client: a failed/duplicate message insert must
// roll this preview back. Matching membership acquires the same document write
// conflict protection as the previous read + preview update, in one command.
export async function writeAuthorizedPreview(
  tx: Pick<Prisma.TransactionClient, '$runCommandRaw' | 'conversation'>,
  conversationId: string,
  senderId: string,
  preview: string,
  timestamp: Date,
): Promise<Conversation> {
  const result = await tx.$runCommandRaw({
    findAndModify: 'conversations',
    query: { _id: { $oid: conversationId }, participantIds: senderId },
    update: {
      $set: {
        lastMessage: preview,
        lastMessageAt: { $date: timestamp.toISOString() },
        updatedAt: { $date: timestamp.toISOString() },
      },
    },
    new: true,
    upsert: false,
  });
  const receipt = z
    .object({
      ok: z.literal(1),
      lastErrorObject: z.object({
        n: z.union([z.literal(0), z.literal(1)]),
        updatedExisting: z.boolean(),
        upserted: z.never().optional(),
      }),
      value: snapshot.nullable(),
      writeErrors: z.never().optional(),
      writeConcernError: z.never().optional(),
    })
    .safeParse(result);
  if (!receipt.success) {
    throw new InternalServerErrorException(
      'Conversation preview was not acknowledged',
    );
  }
  const { value, lastErrorObject } = receipt.data;
  if (
    lastErrorObject.n === 0 &&
    !lastErrorObject.updatedExisting &&
    value === null
  ) {
    // Failure only: retain the existing 404/403 distinction without adding a
    // read to the successful send path. No message has been inserted yet.
    const existing = await tx.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!existing) throw new NotFoundException('Conversation not found');
    if (!existing.participantIds.includes(senderId)) {
      throw new ForbiddenException(
        'You are not allowed to access messages in this conversation',
      );
    }
    throw new InternalServerErrorException(
      'Conversation preview did not match its authorized sender',
    );
  }
  if (
    !value ||
    lastErrorObject.n !== 1 ||
    !lastErrorObject.updatedExisting ||
    value._id.$oid.toLowerCase() !== conversationId.toLowerCase() ||
    !value.participantIds.includes(senderId) ||
    value.lastMessage !== preview ||
    value.lastMessageAt.getTime() !== timestamp.getTime() ||
    value.updatedAt.getTime() !== timestamp.getTime()
  ) {
    throw new InternalServerErrorException(
      'Conversation preview returned an inconsistent snapshot',
    );
  }
  return {
    id: value._id.$oid,
    creatorId: value.creator_id,
    participantIds: value.participantIds,
    isGroup: value.isGroup,
    name: value.name ?? null,
    picture: value.picture ?? null,
    memberJoinedAt: value.memberJoinedAt ?? null,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastMessage: value.lastMessage,
    lastMessageAt: value.lastMessageAt,
  };
}
