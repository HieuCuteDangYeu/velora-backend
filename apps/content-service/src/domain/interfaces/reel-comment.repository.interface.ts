export interface CommentRecord {
  id: string;
  reelId: string;
  authorId: string;
  parentId: string | null;
  text: string;
  replyCount: number;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
export class CommentError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}
export interface IReelCommentRepository {
  find(id: string, reelId: string): Promise<CommentRecord | null>;
  create(input: {
    reelId: string;
    authorId: string;
    parentId: string | null;
    clientRequestId: string;
    text: string;
  }): Promise<CommentRecord>;
  list(input: {
    reelId: string;
    parentId: string | null;
    limit: number;
    cursor?: string;
  }): Promise<{ items: CommentRecord[]; nextCursor: string | null }>;
  update(input: {
    id: string;
    reelId: string;
    authorId: string;
    text: string;
  }): Promise<CommentRecord | null>;
  delete(input: {
    id: string;
    reelId: string;
    actorId: string;
    ownerId: string;
  }): Promise<boolean>;
}
