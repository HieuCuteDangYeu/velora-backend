import { LoginDto } from '@common/auth/dtos/login.dto';
import { CheckUsernameAvailabilityDto } from '@common/user/dtos/check-username-availability.dto';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { CreateUserPayloadDto } from '@common/user/dtos/create-user.dto';
import { SearchPublicUsersDto } from '@common/user/dtos/search-public-users.dto';
import { UpdateAvatarDto } from '@common/user/dtos/update-avatar.dto';
import type { DeleteUserPayload } from '@common/user/interfaces/delete-user.types';
import type { FindAllUsersPayload } from '@common/user/interfaces/find-all-users.types';
import type { UpdateUserPayload } from '@common/user/interfaces/update-user.types';
import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Controller } from '@nestjs/common';
import {
  EventPattern,
  MessagePattern,
  Payload,
  RpcException,
} from '@nestjs/microservices';
import { CheckUsernameAvailabilityUseCase } from '@user/application/use-cases/check-username-availability.use-case';
import { CreateSocialUserUseCase } from '@user/application/use-cases/create-social-user.use-case';
import { CreateUserUseCase } from '@user/application/use-cases/create-user.use-case';
import { DeleteUserUseCase } from '@user/application/use-cases/delete-user.use-case';
import { FindAllUsersUseCase } from '@user/application/use-cases/find-all-users.use-case';
import { FindPublicUserByUsernameUseCase } from '@user/application/use-cases/find-public-user-by-username.use-case';
import { FindPublicUsersByIdsUseCase } from '@user/application/use-cases/find-public-users-by-ids.use-case';
import { FindUserByEmailUseCase } from '@user/application/use-cases/find-user-by-email.use-case';
import { FindUserByIdUseCase } from '@user/application/use-cases/find-user-by-id.use-case';
import { FindUsersByIdsUseCase } from '@user/application/use-cases/find-users-by-ids.use-case';
import { GetRecommendedPublicUsersUseCase } from '@user/application/use-cases/get-recommended-public-users.use-case';
import { SearchPublicUsersUseCase } from '@user/application/use-cases/search-public-users.use-case';
import { UpdateUserAvatarUseCase } from '@user/application/use-cases/update-user-avatar.use-case';
import { UpdateUserUseCase } from '@user/application/use-cases/update-user.use-case';
import { ValidateUserUseCase } from '@user/application/use-cases/validate-user.use-case';
import { ValidateUsersListUseCase } from '@user/application/use-cases/validate-users-list.use-case';
import { VerifyUserUseCase } from '@user/application/use-cases/verify-user.use-case';
import { InvalidAvatarFileError } from '@user/domain/errors/invalid-avatar-file.error';
import { InvalidFullNameError } from '@user/domain/errors/invalid-full-name.error';
import { InvalidUsernameError } from '@user/domain/errors/invalid-username.error';
import { RoleAssignmentError } from '@user/domain/errors/role-assignment.error';
import { UserAlreadyExistsError } from '@user/domain/errors/user-already-exists.error';
import { UserNotFoundError } from '@user/domain/errors/user-not-found.error';
import { UsernameAlreadyTakenError } from '@user/domain/errors/username-already-taken.error';
import { UsernameNotFoundError } from '@user/domain/errors/username-not-found.error';
import {
  type UserOperation,
  UserPrometheusMetricsService,
} from '../metrics/user-prometheus-metrics.service';

@Controller()
export class UserController {
  constructor(
    private readonly validateUserUseCase: ValidateUserUseCase,
    private readonly createUserUseCase: CreateUserUseCase,
    private readonly findAllUsersUseCase: FindAllUsersUseCase,
    private readonly updateUserUseCase: UpdateUserUseCase,
    private readonly deleteUserUseCase: DeleteUserUseCase,
    private readonly verifyUserUseCase: VerifyUserUseCase,
    private readonly findUserByEmailUseCase: FindUserByEmailUseCase,
    private readonly createSocialUserUseCase: CreateSocialUserUseCase,
    private readonly updateUserAvatarUseCase: UpdateUserAvatarUseCase,
    private readonly findUserByIdUseCase: FindUserByIdUseCase,
    private readonly findPublicUsersByIdsUseCase: FindPublicUsersByIdsUseCase,
    private readonly findUsersByIdsUseCase: FindUsersByIdsUseCase,
    private readonly validateUsersListUseCase: ValidateUsersListUseCase,
    private readonly findPublicUserByUsernameUseCase: FindPublicUserByUsernameUseCase,
    private readonly searchPublicUsersUseCase: SearchPublicUsersUseCase,
    private readonly checkUsernameAvailabilityUseCase: CheckUsernameAvailabilityUseCase,
    private readonly getRecommendedPublicUsersUseCase: GetRecommendedPublicUsersUseCase,
    private readonly metrics: UserPrometheusMetricsService,
  ) {}

  @MessagePattern('create_user')
  async handleCreateUser(@Payload() data: CreateUserPayloadDto) {
    try {
      return await this.observe('create', () =>
        this.createUserUseCase.execute(data),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('find_all_users')
  async handleFindAllUsers(@Payload() data: FindAllUsersPayload) {
    return this.observe('find_all', () => this.findAllUsersUseCase.execute(data));
  }

  @MessagePattern('update_user')
  async handleUpdateUser(@Payload() payload: UpdateUserPayload) {
    try {
      return await this.observe('update', () =>
        this.updateUserUseCase.execute(payload),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('delete_user')
  async handleDeleteUser(@Payload() payload: DeleteUserPayload) {
    try {
      return await this.observe('delete', () =>
        this.deleteUserUseCase.execute(payload),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('validate_user')
  async validateUser(@Payload() dto: LoginDto) {
    return await this.observe('validate', () =>
      this.validateUserUseCase.execute(dto),
    );
  }

  @MessagePattern('verify_user')
  async handleVerifyUser(@Payload() id: string) {
    return await this.observe('verify', () => this.verifyUserUseCase.execute(id));
  }

  @MessagePattern('user.find_by_email')
  async findByEmail(@Payload() data: { email: string }) {
    return await this.observe('find_by_email', () =>
      this.findUserByEmailUseCase.execute(data.email),
    );
  }

  @MessagePattern('user.create_social')
  async createSocialUser(@Payload() dto: CreateSocialUserDto) {
    return await this.observe('create_social', () =>
      this.createSocialUserUseCase.execute(dto),
    );
  }

  @EventPattern('user.rollback')
  async rollback(@Payload() data: DeleteUserPayload) {
    await this.deleteUserUseCase.execute(data);
  }

  @MessagePattern('user.update_avatar')
  async updateAvatar(
    @Payload()
    data: {
      userId: string;
      payload: UpdateAvatarDto;
    },
  ) {
    try {
      return await this.observe('avatar_update', () =>
        this.updateUserAvatarUseCase.execute(data.userId, data.payload),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('user.find_by_id')
  async findById(@Payload() id: string): Promise<ValidateUserResponse | null> {
    return await this.observe('find_by_id', () =>
      this.findUserByIdUseCase.execute(id),
    );
  }

  @MessagePattern('user.find_by_ids')
  async findByIds(@Payload() ids: string[]) {
    return await this.observe('find_by_ids', () =>
      this.findUsersByIdsUseCase.execute(ids),
    );
  }

  @MessagePattern('user.find_public_by_ids')
  async findPublicByIds(@Payload() ids: string[]) {
    return await this.observe('public_profile', () =>
      this.findPublicUsersByIdsUseCase.execute(ids),
    );
  }

  @MessagePattern('user.find_public_by_username')
  async findPublicByUsername(@Payload() data: { username: string }) {
    try {
      return await this.observe('public_profile', () =>
        this.findPublicUserByUsernameUseCase.execute(data.username),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('user.search_public')
  async searchPublicUsers(
    @Payload()
    data: SearchPublicUsersDto & {
      viewerId: string;
    },
  ) {
    return await this.observe('search', () =>
      this.searchPublicUsersUseCase.execute(
        data.query,
        data.limit,
        data.viewerId,
      ),
    );
  }

  @MessagePattern('user.get_recommended_public')
  async getRecommendedPublicUsers(
    @Payload()
    data: {
      viewerId: string;
      limit?: number;
      feedSessionId?: string;
    },
  ) {
    const result = await this.observe('recommendations', () =>
      this.getRecommendedPublicUsersUseCase.execute({
        viewerId: data.viewerId,
        limit: data.limit,
        feedSessionId: data.feedSessionId,
      }),
    );
    this.metrics.recordRecommendationCandidates(result.length);
    return result;
  }

  @MessagePattern('user.check_username_availability')
  async checkUsernameAvailability(
    @Payload()
    data: CheckUsernameAvailabilityDto,
  ) {
    try {
      return await this.observe('username_availability', () =>
        this.checkUsernameAvailabilityUseCase.execute(data.username),
      );
    } catch (error) {
      this.handleDomainError(error);
    }
  }

  @MessagePattern('user.validate_list')
  async handleValidateList(
    @Payload() data: { ids: string[] },
  ): Promise<boolean> {
    return await this.observe('validate_list', () =>
      this.validateUsersListUseCase.execute(data.ids),
    );
  }

  private async observe<T>(
    operation: UserOperation,
    action: () => Promise<T>,
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    try {
      const result = await action();
      this.metrics.recordRequest(
        operation,
        'success',
        this.elapsedSeconds(startedAt),
      );
      return result;
    } catch (error) {
      this.metrics.recordRequest(
        operation,
        this.isRejected(error) ? 'rejected' : 'error',
        this.elapsedSeconds(startedAt),
      );
      throw error;
    }
  }

  private isRejected(error: unknown): boolean {
    return (
      error instanceof UserNotFoundError ||
      error instanceof UsernameNotFoundError ||
      error instanceof UserAlreadyExistsError ||
      error instanceof UsernameAlreadyTakenError ||
      error instanceof InvalidAvatarFileError ||
      error instanceof InvalidUsernameError ||
      error instanceof InvalidFullNameError
    );
  }

  private elapsedSeconds(startedAt: bigint): number {
    return Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
  }

  private handleDomainError(error: unknown): never {
    if (
      error instanceof UserNotFoundError ||
      error instanceof UsernameNotFoundError
    ) {
      throw new RpcException({
        statusCode: 404,
        message: error.message,
      });
    }

    if (
      error instanceof UserAlreadyExistsError ||
      error instanceof UsernameAlreadyTakenError
    ) {
      throw new RpcException({
        statusCode: 409,
        message: error.message,
      });
    }

    if (
      error instanceof InvalidAvatarFileError ||
      error instanceof InvalidUsernameError ||
      error instanceof InvalidFullNameError
    ) {
      throw new RpcException({
        statusCode: 400,
        message: error.message,
      });
    }

    if (error instanceof RoleAssignmentError) {
      throw new RpcException({
        statusCode: 500,
        message: 'User creation failed due to role system error',
      });
    }

    throw new RpcException({
      statusCode: 500,
      message: 'Internal Server Error',
    });
  }
}
