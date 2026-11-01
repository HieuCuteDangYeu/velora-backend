import { createHash } from 'crypto';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/content-client';
import { PrismaService } from '@content/infrastructure/prisma/prisma.service';
import {
  CommentError,
  IReelCommentRepository,
} from '@content/domain/interfaces/reel-comment.repository.interface';

@Injectable()
export class ReelCommentRepository implements IReelCommentRepository {
  constructor(private readonly prisma: PrismaService) {}
  find(id: string, reelId: string) {
    return this.prisma.reelComment.findFirst({ where: { id, reelId } });
  }
  async create(input: {
    reelId: string;
    authorId: string;
    parentId: string | null;
    clientRequestId: string;
    text: string;
  }) {
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([input.reelId, input.parentId, input.text]))
      .digest('hex');
    const existing = async () => {
      const record = await this.prisma.reelComment.findUnique({
        where: {
          authorId_clientRequestId: {
            authorId: input.authorId,
            clientRequestId: input.clientRequestId,
          },
        },
      });
      if (record && record.fingerprint !== fingerprint)
        throw new CommentError(409, 'Client request ID already used');
      return record;
    };
    const previous = await existing();
    if (previous) return previous;
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (input.parentId) {
          await tx.$queryRaw`SELECT id FROM "ReelComment" WHERE id = ${input.parentId} FOR UPDATE`;
          const retry = await tx.reelComment.findUnique({
            where: {
              authorId_clientRequestId: {
                authorId: input.authorId,
                clientRequestId: input.clientRequestId,
              },
            },
          });
          if (retry) {
            if (retry.fingerprint !== fingerprint)
              throw new CommentError(409, 'Client request ID already used');
            return retry;
          }
          const parent = await tx.reelComment.findFirst({
            where: {
              id: input.parentId,
              reelId: input.reelId,
              parentId: null,
              deletedAt: null,
            },
          });
          if (!parent) throw new CommentError(404, 'Comment not found');
        }
        const record = await tx.reelComment.create({
          data: { ...input, fingerprint },
        });
        await tx.reel.update({
          where: { id: input.reelId },
          data: { commentCount: { increment: 1 } },
        });
        if (input.parentId)
          await tx.reelComment.update({
            where: { id: input.parentId },
            data: { replyCount: { increment: 1 } },
          });
        return record;
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const record = await existing();
        if (record) return record;
      }
      throw error;
    }
  }
  async list(input: {
    reelId: string;
    parentId: string | null;
    limit: number;
    cursor?: string;
  }) {
    const [date, id] = input.cursor?.split('|') ?? [];
    const items = await this.prisma.reelComment.findMany({
      where: {
        reelId: input.reelId,
        parentId: input.parentId,
        ...(input.parentId
          ? { deletedAt: null }
          : { OR: [{ deletedAt: null }, { replyCount: { gt: 0 } }] }),
        ...(date && id
          ? {
              AND: [
                {
                  OR: [
                    { createdAt: { lt: new Date(date) } },
                    { createdAt: new Date(date), id: { lt: id } },
                  ],
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
    const more = items.length > input.limit;
    const page = items.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page,
      nextCursor:
        more && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
    };
  }
  update(input: {
    id: string;
    reelId: string;
    authorId: string;
    text: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const changed = await tx.reelComment.updateMany({
        where: {
          id: input.id,
          reelId: input.reelId,
          authorId: input.authorId,
          deletedAt: null,
        },
        data: { text: input.text },
      });
      return changed.count
        ? tx.reelComment.findUnique({ where: { id: input.id } })
        : null;
    });
  }
  async delete(input: {
    id: string;
    reelId: string;
    actorId: string;
    ownerId: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const initial = await tx.reelComment.findFirst({
        where: { id: input.id, reelId: input.reelId },
      });
      if (
        !initial ||
        (initial.authorId !== input.actorId && input.ownerId !== input.actorId)
      )
        return false;
      const rootId = initial.parentId ?? initial.id;
      await tx.$queryRaw`SELECT id FROM "ReelComment" WHERE id = ${rootId} FOR UPDATE`;
      const changed = await tx.reelComment.updateMany({
        where: { id: input.id, reelId: input.reelId, deletedAt: null },
        data: { deletedAt: new Date(), text: '' },
      });
      if (!changed.count) return true;
      await tx.reel.update({
        where: { id: input.reelId },
        data: { commentCount: { decrement: 1 } },
      });
      if (initial.parentId)
        await tx.reelComment.update({
          where: { id: initial.parentId },
          data: { replyCount: { decrement: 1 } },
        });
      return true;
    });
  }
}
