import { Inject, Injectable } from '@nestjs/common';
import { GetReelUseCase } from './get-reel.use-case';
import type { IContentRepository } from '@content/domain/interfaces/content.repository.interface';
import {
  CommentError,
  type IReelCommentRepository,
} from '@content/domain/interfaces/reel-comment.repository.interface';

@Injectable()
export class CreateReelCommentUseCase {
  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IReelCommentRepository')
    private readonly comments: IReelCommentRepository,
  ) {}
  async execute(input: {
    reelId: string;
    authorId: string;
    parentId: string | null;
    text: string;
    clientRequestId: string;
  }) {
    const reel = await this.getReel.execute(input.reelId, input.authorId);
    if (!reel) throw new CommentError(404, 'Reel not found');
    if (reel.mediaStatus !== 'COMPLETED')
      throw new CommentError(409, 'Reel is not ready');
    return this.comments.create(input);
  }
}
@Injectable()
export class ListReelCommentsUseCase {
  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IReelCommentRepository')
    private readonly comments: IReelCommentRepository,
  ) {}
  async execute(input: {
    reelId: string;
    viewerId: string;
    parentId: string | null;
    limit: number;
    cursor?: string;
  }) {
    if (!(await this.getReel.execute(input.reelId, input.viewerId)))
      throw new CommentError(404, 'Reel not found');
    if (input.parentId) {
      const parent = await this.comments.find(input.parentId, input.reelId);
      if (!parent || parent.parentId)
        throw new CommentError(404, 'Comment not found');
    }
    return this.comments.list(input);
  }
}
@Injectable()
export class UpdateReelCommentUseCase {
  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IReelCommentRepository')
    private readonly comments: IReelCommentRepository,
  ) {}
  async execute(input: {
    id: string;
    reelId: string;
    authorId: string;
    text: string;
  }) {
    if (!(await this.getReel.execute(input.reelId, input.authorId)))
      throw new CommentError(404, 'Reel not found');
    const result = await this.comments.update(input);
    if (!result) throw new CommentError(404, 'Comment not found');
    return result;
  }
}
@Injectable()
export class DeleteReelCommentUseCase {
  constructor(
    private readonly getReel: GetReelUseCase,
    @Inject('IContentRepository') private readonly reels: IContentRepository,
    @Inject('IReelCommentRepository')
    private readonly comments: IReelCommentRepository,
  ) {}
  async execute(input: { id: string; reelId: string; actorId: string }) {
    const comment = await this.comments.find(input.id, input.reelId);
    const reel = await this.reels.findById(input.reelId);
    if (!comment || !reel) throw new CommentError(404, 'Comment not found');
    if (
      comment.authorId !== input.actorId &&
      !(await this.getReel.execute(input.reelId, input.actorId))
    )
      throw new CommentError(404, 'Reel not found');
    if (!(await this.comments.delete({ ...input, ownerId: reel.userId })))
      throw new CommentError(404, 'Comment not found');
    return { success: true };
  }
}
