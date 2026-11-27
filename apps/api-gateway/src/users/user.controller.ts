import { isRpcError } from '@common/constants/rpc-error.types';
import { BanUserDto } from '@common/user/dtos/ban-user.dto';
import { CheckUsernameAvailabilityDto } from '@common/user/dtos/check-username-availability.dto';
import { CreateUserDto } from '@common/user/dtos/create-user.dto';
import { RecommendedPublicUsersQueryDto } from '@common/user/dtos/recommended-public-users-query.dto';
import { SearchPublicUsersDto } from '@common/user/dtos/search-public-users.dto';
import { UpdateAvatarDto } from '@common/user/dtos/update-avatar.dto';
import { UpdateUserDto } from '@common/user/dtos/update-user.dto';
import { CreateUserResponse } from '@common/user/interfaces/create-user-response.types';
import {
  BanUserPayload,
  BanUserResponse,
  UnbanUserPayload,
} from '@common/user/interfaces/ban-user.types';
import { PaginatedUsersResponse } from '@common/user/interfaces/find-all-users.types';
import {
  PublicUserProfile,
  RecommendedPublicUserProfile,
} from '@common/user/interfaces/public-user-profile.types';
import {
  UpdateUserPayload,
  UpdateUserResponse,
} from '@common/user/interfaces/update-user.types';
import { UsernameAvailabilityResponse } from '@common/user/interfaces/username-availability.types';
import { Role, Roles } from '@gateway/auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '@gateway/auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '@gateway/auth/guards/jwt-auth.guard';
import { OwnershipGuard } from '@gateway/auth/guards/ownership.guard';
import { RolesGuard } from '@gateway/auth/guards/roles.guard';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Delete,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { catchError, lastValueFrom } from 'rxjs';
import { PaginationDto } from './dto/pagination.dto';

export interface MicroserviceUser {
  id: string;
  email: string;
  fullName: string;
  username: string | null;
  picture?: string | null;
  avatarKey?: string | null;
  password?: string | null;
  [key: string]: unknown;
}

@ApiTags('Users')
@Controller('users')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserController {
  constructor(
    @Inject('USER_SERVICE')
    private readonly userClient: ClientProxy,
  ) {}

  @Get('username-availability')
  @ApiOperation({
    summary: 'Check username availability',
  })
  @Roles(Role.ADMIN, Role.USER)
  async checkUsernameAvailability(
    @Query()
    query: CheckUsernameAvailabilityDto,
  ): Promise<UsernameAvailabilityResponse> {
    return await lastValueFrom(
      this.userClient
        .send<UsernameAvailabilityResponse>(
          'user.check_username_availability',
          query,
        )
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Create a new user',
  })
  @Roles(Role.ADMIN)
  async register(@Body() dto: CreateUserDto): Promise<CreateUserResponse> {
    return await lastValueFrom(
      this.userClient.send<CreateUserResponse>('create_user', dto).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );
  }

  @Get('recommended')
  @ApiOperation({
    summary: 'Get recommended public users for contact suggestions',
  })
  @Roles(Role.ADMIN, Role.USER)
  async getRecommendedUsers(
    @Req() request: AuthenticatedRequest,
    @Query()
    query: RecommendedPublicUsersQueryDto,
  ): Promise<RecommendedPublicUserProfile[]> {
    return await lastValueFrom(
      this.userClient
        .send<RecommendedPublicUserProfile[]>('user.get_recommended_public', {
          viewerId: request.user!.id,
          limit: query.limit,
          feedSessionId: query.feedSessionId,
          offset: query.offset,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('discover')
  @ApiOperation({
    summary: 'Search public users for friend discovery',
  })
  @Roles(Role.ADMIN, Role.USER)
  async discoverUsers(
    @Req() request: AuthenticatedRequest,
    @Query() query: SearchPublicUsersDto,
  ): Promise<PublicUserProfile[]> {
    return await lastValueFrom(
      this.userClient
        .send<PublicUserProfile[]>('user.search_public', {
          ...query,
          viewerId: request.user!.id,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get('public/:username')
  @ApiOperation({
    summary: 'Lookup a public profile by username',
  })
  @Roles(Role.ADMIN, Role.USER)
  async findPublicProfile(
    @Param('username') username: string,
  ): Promise<PublicUserProfile> {
    return await lastValueFrom(
      this.userClient
        .send<PublicUserProfile>('user.find_public_by_username', { username })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'Get all users',
  })
  @Roles(Role.ADMIN)
  async findAll(
    @Query() query: PaginationDto,
  ): Promise<PaginatedUsersResponse> {
    return await lastValueFrom(
      this.userClient
        .send<PaginatedUsersResponse>('find_all_users', query)
        .pipe(
          catchError((error) => {
            this.handleMicroserviceError(error);
          }),
        ),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update a user',
  })
  @Roles(Role.ADMIN, Role.USER)
  @UseGuards(OwnershipGuard)
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ): Promise<UpdateUserResponse> {
    const payload: UpdateUserPayload = {
      id,
      data: dto,
    };

    return await lastValueFrom(
      this.userClient.send<UpdateUserResponse>('update_user', payload).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );
  }

  @Delete('me')
  @Roles(Role.ADMIN, Role.USER)
  @ApiOperation({
    summary:
      'Delete the signed-in account: sessions end and personal data is erased',
  })
  async deleteOwnAccount(@Req() request: AuthenticatedRequest) {
    return await lastValueFrom(
      this.userClient
        .send<{ id: string; message: string }>('user.delete_own_account', {
          userId: request.user!.id,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Patch('me/avatar')
  @Roles(Role.ADMIN, Role.USER)
  @ApiOperation({
    summary: 'Update user avatar using an uploaded R2 key',
  })
  async updateAvatar(
    @Req() request: AuthenticatedRequest,
    @Body() body: UpdateAvatarDto,
  ) {
    return await lastValueFrom(
      this.userClient
        .send<MicroserviceUser>('user.update_avatar', {
          userId: request.user!.id,
          payload: body,
        })
        .pipe(catchError((error) => this.handleMicroserviceError(error))),
    );
  }

  @Post(':id/ban')
  @ApiOperation({
    summary:
      'Ban a user: every session ends at once and the account can no longer sign in',
  })
  @Roles(Role.ADMIN)
  async ban(
    @Param('id') id: string,
    @Body() dto: BanUserDto,
    @Req() request: AuthenticatedRequest,
  ): Promise<BanUserResponse> {
    if (id === request.user!.id) {
      throw new HttpException('You cannot ban yourself', HttpStatus.CONFLICT);
    }
    const payload: BanUserPayload = {
      id,
      bannedBy: request.user!.id,
      reason: dto.reason,
    };

    return await lastValueFrom(
      this.userClient.send<BanUserResponse>('user.ban', payload).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
    );
  }

  @Post(':id/unban')
  @ApiOperation({ summary: 'Lift a ban; the user signs in again as normal' })
  @Roles(Role.ADMIN)
  async unban(@Param('id') id: string): Promise<BanUserResponse> {
    const payload: UnbanUserPayload = { id };

    return await lastValueFrom(
      this.userClient.send<BanUserResponse>('user.unban', payload).pipe(
        catchError((error) => {
          this.handleMicroserviceError(error);
        }),
      ),
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
