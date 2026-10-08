import type { PrismaService } from '../prisma/prisma.service';
import { z } from 'zod';

const objectId = z.string().regex(/^[a-f0-9]{24}$/i);
const intentSchema = z.object({
  id: objectId,
  conversationId: objectId,
  senderId: z.string(),
  content: z.string(),
  type: z.string(),
  signalType: z.number().int(),
  createdAt: z.iso.datetime().transform((value) => new Date(value)),
  isRecalled: z.boolean(),
  notificationRecipientIds: z.array(z.string()),
  notificationClaimId: z.string(),
  notificationAttemptCount: z.number().int().positive(),
  conversation: z
    .object({
      id: objectId,
      participantIds: z.array(z.string()),
      isGroup: z.boolean(),
      name: z.string().nullable(),
    })
    .nullable(),
});

// Read after claim, without caching membership or moving the read before the
// lease. Prisma's include uses two commands; this indexed lookup uses one.
// Project only notification fields and normalize BSON IDs/dates in Mongo.
export async function readNotificationIntent(
  prisma: Pick<PrismaService, 'message'>,
  id: string,
  claimId: string,
): Promise<z.infer<typeof intentSchema> | null> {
  const result = await prisma.message.aggregateRaw({
    pipeline: [
      { $match: { _id: { $oid: id }, notificationClaimId: claimId } },
      {
        $lookup: {
          from: 'conversations',
          localField: 'conversationId',
          foreignField: '_id',
          pipeline: [
            {
              $project: {
                _id: 0,
                id: { $toString: '$_id' },
                participantIds: 1,
                isGroup: 1,
                name: { $ifNull: ['$name', null] },
              },
            },
          ],
          as: 'conversation',
        },
      },
      {
        $project: {
          _id: 0,
          id: { $toString: '$_id' },
          conversationId: { $toString: '$conversationId' },
          senderId: 1,
          content: 1,
          type: { $ifNull: ['$type', 'text'] },
          signalType: '$signal_type',
          createdAt: { $dateToString: { date: '$createdAt' } },
          isRecalled: { $ifNull: ['$isRecalled', false] },
          notificationRecipientIds: 1,
          notificationClaimId: 1,
          notificationAttemptCount: 1,
          conversation: {
            $ifNull: [{ $arrayElemAt: ['$conversation', 0] }, null],
          },
        },
      },
    ],
  });
  const records = z.array(intentSchema).max(1).parse(result);
  return records[0] ?? null;
}
