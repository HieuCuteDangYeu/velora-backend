import { isRpcError } from '@common/constants/rpc-error.types';
import { FriendPaginationDto } from '@common/friend/dtos/friend-pagination.dto';
import { ListFriendsDto } from '@common/friend/dtos/list-friends.dto';
import { SendFriendRequestDto } from '@common/friend/dtos/send-friend-request.dto';
import type { BlockedUserSummary } from '@common/friend/interfaces/blocked-user.types';
import {
  FriendRequestSummary,
  FriendshipActionResponse,
  FriendshipStatusResponse,
  FriendSummary,
  PaginatedFriendResults,
} from '@common/friend/interfaces/friend.types';
import { UserBlockActionResponse } from '@common/friend/interfaces/user-block-action.interface';
import { RateLimit } from '@common/rate-limit/rate-limit.decorator';
import { RateLimitGuard } from '@common/rate-limit/rate-limit.guard';
import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';

@ApiTags('Friends')
@Controller('friends')
@UseGuards(JwtAuthGuard, RolesGuard, RateLimitGuard)
@Roles(Role.ADMIN, Role.USER)
export class FriendController {
  constructor(
    @Inject('FRIEND_SERVICE')
    private readonly friendClient: ClientProxy,
  ) {}

  @RateLimit({ policy: 'friend_request_user', by: 'user' })
  @Post('requests')
  @ApiOperation({
    summary: 'Send a friend request to another user',
  })
  async sendRequest(
    @Req() request: AuthenticatedRequest,
    @Body() dto: SendFriendRequestDto,
  ): Promise<FriendshipActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipActionResponse>('friend.send_request', {
          userId: request.user!.id,
          recipientId: dto.recipientId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Post('requests/:requestId/accept')
  @ApiOperation({
    summary: 'Accept an incoming friend request',
  })
  async acceptRequest(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe)
    requestId: string,
  ): Promise<FriendshipActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipActionResponse>('friend.accept_request', {
          userId: request.user!.id,
          requestId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Post('requests/:requestId/reject')
  @ApiOperation({
    summary: 'Reject an incoming friend request',
  })
  async rejectRequest(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe)
    requestId: string,
  ): Promise<FriendshipActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipActionResponse>('friend.reject_request', {
          userId: request.user!.id,
          requestId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Post(':userId/block')
  @ApiOperation({
    summary: 'Block a user and remove any relationship',
  })
  async blockUser(
    @Req()
    request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe)
    blockedUserId: string,
  ): Promise<UserBlockActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<UserBlockActionResponse>('friend.block_user', {
          userId: request.user!.id,
          blockedUserId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Delete(':userId/block')
  @ApiOperation({
    summary: 'Unblock a user',
  })
  async unblockUser(
    @Req()
    request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe)
    blockedUserId: string,
  ): Promise<UserBlockActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<UserBlockActionResponse>('friend.unblock_user', {
          userId: request.user!.id,
          blockedUserId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('blocked')
  @ApiOperation({
    summary: 'List users blocked by the authenticated user',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
  })
  async listBlockedUsers(
    @Req() request: AuthenticatedRequest,
    @Query() query: FriendPaginationDto,
  ): Promise<PaginatedFriendResults<BlockedUserSummary>> {
    return await lastValueFrom(
      this.friendClient
        .send<PaginatedFriendResults<BlockedUserSummary>>(
          'friend.list_blocked_users',
          {
            userId: request.user!.id,
            limit: query.limit,
            cursor: query.cursor,
          },
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Delete('requests/:requestId')
  @ApiOperation({
    summary: 'Cancel an outgoing friend request',
  })
  async cancelRequest(
    @Req() request: AuthenticatedRequest,
    @Param('requestId', ParseUUIDPipe)
    requestId: string,
  ): Promise<FriendshipActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipActionResponse>('friend.cancel_request', {
          userId: request.user!.id,
          requestId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('requests/incoming')
  @ApiOperation({
    summary: 'List incoming friend requests',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
  })
  async listIncomingRequests(
    @Req() request: AuthenticatedRequest,
    @Query() query: FriendPaginationDto,
  ): Promise<PaginatedFriendResults<FriendRequestSummary>> {
    return await lastValueFrom(
      this.friendClient
        .send<PaginatedFriendResults<FriendRequestSummary>>(
          'friend.list_incoming_requests',
          {
            userId: request.user!.id,
            limit: query.limit,
            cursor: query.cursor,
          },
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('requests/outgoing')
  @ApiOperation({
    summary: 'List outgoing friend requests',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
  })
  async listOutgoingRequests(
    @Req() request: AuthenticatedRequest,
    @Query() query: FriendPaginationDto,
  ): Promise<PaginatedFriendResults<FriendRequestSummary>> {
    return await lastValueFrom(
      this.friendClient
        .send<PaginatedFriendResults<FriendRequestSummary>>(
          'friend.list_outgoing_requests',
          {
            userId: request.user!.id,
            limit: query.limit,
            cursor: query.cursor,
          },
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List accepted friends',
  })
  @ApiQuery({
    name: 'userId',
    required: false,
    type: String,
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
  })
  async listFriends(
    @Req() request: AuthenticatedRequest,
    @Query() query: ListFriendsDto,
  ): Promise<PaginatedFriendResults<FriendSummary>> {
    return await lastValueFrom(
      this.friendClient
        .send<PaginatedFriendResults<FriendSummary>>('friend.list_friends', {
          userId: query.userId ?? request.user!.id,
          limit: query.limit,
          cursor: query.cursor,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @RateLimit({ policy: 'friend_write_user', by: 'user' })
  @Delete(':userId')
  @ApiOperation({
    summary: 'Remove an accepted friend',
  })
  async removeFriend(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe)
    friendUserId: string,
  ): Promise<FriendshipActionResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipActionResponse>('friend.remove', {
          userId: request.user!.id,
          friendUserId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('status/:userId')
  @ApiOperation({
    summary: 'Get friendship status with another user',
  })
  async getStatus(
    @Req() request: AuthenticatedRequest,
    @Param('userId', ParseUUIDPipe)
    otherUserId: string,
  ): Promise<FriendshipStatusResponse> {
    return await lastValueFrom(
      this.friendClient
        .send<FriendshipStatusResponse>('friend.get_status', {
          userId: request.user!.id,
          otherUserId,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  private handleMicroserviceError(error: unknown): never {
    if (isRpcError(error)) {
      throw new HttpException(error.message, error.statusCode);
    }

    throw new HttpException(
      'Internal Server Error',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
