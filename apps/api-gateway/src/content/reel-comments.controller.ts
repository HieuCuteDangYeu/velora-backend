import { isRpcError } from '@common/constants/rpc-error.types';
import {
  CreateReelCommentDto,
  ListReelCommentsDto,
  UpdateReelCommentDto,
} from '@common/content/dtos/reel-comment.dto';
import { RateLimit } from '@common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import {
  JwtAuthGuard,
  type AuthenticatedRequest,
} from '@gateway/auth/guards/jwt-auth.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { lastValueFrom } from 'rxjs';
import { ReelAuthorService } from './reel-author.service';

type Comment = {
  id: string;
  reelId: string;
  authorId: string;
  parentId: string | null;
  text: string;
  replyCount: number;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
};
@ApiTags('Content')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RateLimitGuard)
@Controller('content/reels/:reelId/comments')
export class ReelCommentsGatewayController {
  constructor(
    @Inject('CONTENT_SERVICE') private readonly client: ClientProxy,
    private readonly authors: ReelAuthorService,
  ) {}
  private async call<T>(pattern: string, payload: object): Promise<T> {
    try {
      return await lastValueFrom(this.client.send<T>(pattern, payload));
    } catch (error) {
      if (isRpcError(error))
        throw new HttpException(error.message, error.statusCode);
      throw new HttpException('Internal Server Error', 500);
    }
  }
  private async enrich(items: Comment[]) {
    const authors = await this.authors.loadAuthorMap(
      items.filter((item) => !item.deletedAt).map((item) => item.authorId),
    );
    return items.map((item) => ({
      id: item.id,
      reelId: item.reelId,
      parentId: item.parentId,
      text: item.deletedAt ? null : item.text,
      replyCount: item.replyCount,
      deletedAt: item.deletedAt,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      author: item.deletedAt
        ? null
        : this.authors.resolveAuthor(authors, item.authorId),
    }));
  }
  private async createOne(
    reelId: string,
    req: AuthenticatedRequest,
    body: CreateReelCommentDto,
    commentId?: string,
  ) {
    const item = await this.call<Comment>('content.create_reel_comment', {
      reelId,
      userId: req.user!.id,
      commentId,
      body,
    });
    return (await this.enrich([item]))[0];
  }
  private async listPage(
    reelId: string,
    req: AuthenticatedRequest,
    query: ListReelCommentsDto,
    commentId?: string,
  ) {
    const page = await this.call<{
      items: Comment[];
      nextCursor: string | null;
    }>('content.list_reel_comments', {
      reelId,
      userId: req.user!.id,
      commentId,
      query,
    });
    return {
      items: await this.enrich(page.items),
      nextCursor: page.nextCursor,
    };
  }
  @RateLimit({ policy: 'content_comment_user', by: 'user' })
  @Post()
  createRoot(
    @Param('reelId') reelId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateReelCommentDto,
  ) {
    return this.createOne(reelId, req, body);
  }
  @Get() listRoots(
    @Param('reelId') reelId: string,
    @Req() req: AuthenticatedRequest,
    @Query() query: ListReelCommentsDto,
  ) {
    return this.listPage(reelId, req, query);
  }
  @RateLimit({ policy: 'content_comment_user', by: 'user' })
  @Post(':commentId/replies')
  createReply(
    @Param('reelId') reelId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateReelCommentDto,
  ) {
    return this.createOne(reelId, req, body, commentId);
  }
  @Get(':commentId/replies') listReplies(
    @Param('reelId') reelId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Query() query: ListReelCommentsDto,
  ) {
    return this.listPage(reelId, req, query, commentId);
  }
  @RateLimit({ policy: 'content_comment_user', by: 'user' })
  @Patch(':commentId')
  async updateComment(
    @Param('reelId') reelId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
    @Body() body: UpdateReelCommentDto,
  ) {
    const item = await this.call<Comment>('content.update_reel_comment', {
      reelId,
      commentId,
      userId: req.user!.id,
      body,
    });
    return (await this.enrich([item]))[0];
  }
  @RateLimit({ policy: 'content_comment_user', by: 'user' })
  @Delete(':commentId')
  deleteComment(
    @Param('reelId') reelId: string,
    @Param('commentId') commentId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    return this.call('content.delete_reel_comment', {
      reelId,
      commentId,
      userId: req.user!.id,
    });
  }
}
