import { Injectable } from '@nestjs/common';
import type {
  CallHistoryItem,
  CallHistoryPage,
  CallParticipantResult,
  CallParticipantRole,
  CallRecordOutcome,
} from '@common/calls/call-history.types';
import type { Prisma } from '@prisma/call-client';

import {
  type CallHistoryRecord,
  ICallHistoryRepository,
  InvalidCallHistoryCursorError,
} from '../../domain/interfaces/call-history.repository.interface';
import { CallPrismaService } from '../prisma/call-prisma.service';

type ParticipantWithRecord = Prisma.CallRecordParticipantGetPayload<{
  include: { record: { include: { participants: true } } };
}>;

@Injectable()
export class PrismaCallHistoryRepository implements ICallHistoryRepository {
  constructor(private readonly prisma: CallPrismaService) {}

  isEnabled(): boolean {
    return this.prisma.enabled;
  }

  async record(record: CallHistoryRecord): Promise<void> {
    if (!this.isEnabled()) return;

    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.callRecord.findUnique({
        where: { callId: record.callId },
        select: { lifecycleRevision: true },
      });
      if (existing && existing.lifecycleRevision >= record.lifecycleRevision) {
        return;
      }

      const data = {
        conversationId: record.conversationId,
        isGroupCall: record.isGroupCall,
        callType: record.callType,
        groupName: record.groupName ?? null,
        groupAvatarUrl: record.groupAvatarUrl ?? null,
        initiatorId: record.initiatorId,
        outcome: record.outcome,
        terminalReason: record.terminalReason ?? null,
        startedAt: record.startedAt,
        answeredAt: record.answeredAt ?? null,
        endedAt: record.endedAt,
        durationSec: record.durationSec ?? null,
        lifecycleRevision: record.lifecycleRevision,
      };
      await tx.callRecord.upsert({
        where: { callId: record.callId },
        create: { callId: record.callId, ...data },
        update: data,
      });

      for (const participant of record.participants) {
        const fields = {
          role: participant.role,
          result: participant.result,
          startedAt: record.startedAt,
        };
        // seenAt is the user's own state and survives a rewrite.
        await tx.callRecordParticipant.upsert({
          where: {
            callId_userId: {
              callId: record.callId,
              userId: participant.userId,
            },
          },
          create: {
            callId: record.callId,
            userId: participant.userId,
            ...fields,
          },
          update: fields,
        });
      }
    });
  }

  async listForUser(
    userId: string,
    options: { cursor?: string; limit: number },
  ): Promise<CallHistoryPage> {
    if (!this.isEnabled()) return { items: [], nextCursor: null };

    const limit = Math.min(Math.max(1, Math.trunc(options.limit)), 100);
    const cursor = options.cursor ? decodeCursor(options.cursor) : undefined;
    const rows = await this.prisma.callRecordParticipant.findMany({
      where: {
        userId,
        ...(cursor
          ? {
              OR: [
                { startedAt: { lt: cursor.startedAt } },
                {
                  startedAt: cursor.startedAt,
                  callId: { lt: cursor.callId },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { callId: 'desc' }],
      take: limit + 1,
      include: { record: { include: { participants: true } } },
    });

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toHistoryItem(row)),
      nextCursor:
        rows.length > limit && last
          ? encodeCursor(last.startedAt, last.callId)
          : null,
    };
  }

  async countUnseenMissed(userId: string): Promise<number> {
    if (!this.isEnabled()) return 0;
    return this.prisma.callRecordParticipant.count({
      where: { userId, result: 'MISSED', seenAt: null },
    });
  }

  async markMissedSeen(userId: string, seenAt: Date): Promise<number> {
    if (!this.isEnabled()) return 0;
    const result = await this.prisma.callRecordParticipant.updateMany({
      where: { userId, result: 'MISSED', seenAt: null },
      data: { seenAt },
    });
    return result.count;
  }
}

function toHistoryItem(row: ParticipantWithRecord): CallHistoryItem {
  const { record } = row;
  const peers = record.participants
    .filter((participant) => participant.userId !== row.userId)
    .sort(
      (left, right) =>
        Number(right.role === 'CALLER') - Number(left.role === 'CALLER'),
    )
    .map((participant) => participant.userId);

  return {
    callId: record.callId,
    conversationId: record.conversationId,
    callType: record.callType === 'VIDEO' ? 'VIDEO' : 'VOICE',
    isGroupCall: record.isGroupCall,
    ...(record.groupName ? { groupName: record.groupName } : {}),
    ...(record.groupAvatarUrl ? { groupAvatarUrl: record.groupAvatarUrl } : {}),
    initiatorId: record.initiatorId,
    outcome: record.outcome as CallRecordOutcome,
    ...(record.terminalReason ? { terminalReason: record.terminalReason } : {}),
    role: row.role as CallParticipantRole,
    result: row.result as CallParticipantResult,
    startedAt: record.startedAt.toISOString(),
    endedAt: record.endedAt.toISOString(),
    ...(record.durationSec !== null ? { durationSec: record.durationSec } : {}),
    peerUserIds: peers,
  };
}

export function encodeCursor(startedAt: Date, callId: string): string {
  return Buffer.from(`${startedAt.toISOString()}|${callId}`).toString(
    'base64url',
  );
}

export function decodeCursor(cursor: string): {
  startedAt: Date;
  callId: string;
} {
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  const startedAt = new Date(decoded.slice(0, separator));
  const callId = decoded.slice(separator + 1);
  if (separator < 0 || Number.isNaN(startedAt.getTime()) || !callId) {
    throw new InvalidCallHistoryCursorError();
  }
  return { startedAt, callId };
}
