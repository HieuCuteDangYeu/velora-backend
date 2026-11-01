import { Controller } from '@nestjs/common';
import { MessagePattern, Payload, RpcException } from '@nestjs/microservices';
import { z } from 'zod';
import {
  CreateReelCommentSchema,
  ListReelCommentsSchema,
  UpdateReelCommentSchema,
} from '@common/content/dtos/reel-comment.dto';
import { CommentError } from '@content/domain/interfaces/reel-comment.repository.interface';
import {
  CreateReelCommentUseCase,
  ListReelCommentsUseCase,
  UpdateReelCommentUseCase,
  DeleteReelCommentUseCase,
} from '@content/application/use-cases/reel-comments.use-cases';

const id = z.string().trim().min(1).max(256);
const base = z.object({ reelId: id, userId: id, commentId: id.optional() });
@Controller()
export class ReelCommentsController {
  constructor(
    private readonly create: CreateReelCommentUseCase,
    private readonly list: ListReelCommentsUseCase,
    private readonly update: UpdateReelCommentUseCase,
    private readonly remove: DeleteReelCommentUseCase,
  ) {}
  private async run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof CommentError)
        throw new RpcException({
          statusCode: error.statusCode,
          message: error.message,
        });
      if (error instanceof z.ZodError)
        throw new RpcException({
          statusCode: 400,
          message: 'Invalid comment request',
        });
      throw new RpcException({
        statusCode: 500,
        message: 'Comment operation failed',
      });
    }
  }
  @MessagePattern('content.create_reel_comment')
  createComment(@Payload() data: unknown) {
    return this.run(async () => {
      const b = base.parse(data);
      const body = CreateReelCommentSchema.parse((data as any).body);
      return this.create.execute({
        reelId: b.reelId,
        authorId: b.userId,
        parentId: b.commentId ?? null,
        ...body,
      });
    });
  }
  @MessagePattern('content.list_reel_comments')
  listComments(@Payload() data: unknown) {
    return this.run(async () => {
      const b = base.parse(data);
      const query = ListReelCommentsSchema.parse((data as any).query);
      return this.list.execute({
        reelId: b.reelId,
        viewerId: b.userId,
        parentId: b.commentId ?? null,
        ...query,
      });
    });
  }
  @MessagePattern('content.update_reel_comment')
  updateComment(@Payload() data: unknown) {
    return this.run(async () => {
      const b = base.extend({ commentId: id }).parse(data);
      const body = UpdateReelCommentSchema.parse((data as any).body);
      return this.update.execute({
        reelId: b.reelId,
        authorId: b.userId,
        id: b.commentId,
        ...body,
      });
    });
  }
  @MessagePattern('content.delete_reel_comment')
  deleteComment(@Payload() data: unknown) {
    return this.run(async () => {
      const b = base.extend({ commentId: id }).parse(data);
      return this.remove.execute({
        reelId: b.reelId,
        actorId: b.userId,
        id: b.commentId,
      });
    });
  }
}
