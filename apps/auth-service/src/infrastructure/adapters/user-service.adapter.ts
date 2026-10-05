import { LoginDto } from '@common/auth/dtos/login.dto';
import { RegisterDto } from '@common/auth/dtos/register.dto';
import { isRpcError } from '@common/constants/rpc-error.types';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { CreateUserPayloadDto } from '@common/user/dtos/create-user.dto';
import { CreateUserResponse } from '@common/user/interfaces/create-user-response.types';
import {
  UpdateUserPayload,
  UpdateUserResponse,
} from '@common/user/interfaces/update-user.types';
import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';
import { Inject, Injectable } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { UserAlreadyExistsError } from '@user/domain/errors/user-already-exists.error';
import { UsernameAlreadyTakenError } from '@user/domain/errors/username-already-taken.error';
import { catchError, lastValueFrom, of, throwError, timeout } from 'rxjs';
import { IUserService } from '../../domain/interfaces/user-service.interface';

@Injectable()
export class UserServiceAdapter implements IUserService {
  constructor(
    @Inject('USER_SERVICE_RMQ') private readonly rmqClient: ClientProxy,
  ) {}

  async createUser(dto: RegisterDto): Promise<CreateUserResponse> {
    const payload: CreateUserPayloadDto = {
      email: dto.email,
      password: dto.password,
      fullName: dto.fullName,
      isVerified: false,
    };

    return lastValueFrom(
      this.rmqClient.send<CreateUserResponse>('create_user', payload).pipe(
        catchError((err) => {
          if (isRpcError(err) && err.statusCode === 409) {
            if (
              typeof err.message === 'string' &&
              err.message.toLowerCase().includes('username')
            ) {
              return throwError(
                () => new UsernameAlreadyTakenError('username'),
              );
            }

            return throwError(() => new UserAlreadyExistsError(dto.email));
          }

          let errorMessage = 'User Service Failed';

          if (isRpcError(err)) {
            errorMessage = Array.isArray(err.message)
              ? err.message.join(', ')
              : err.message;
          } else if (err instanceof Error) {
            errorMessage = err.message;
          }

          return throwError(() => new Error(errorMessage));
        }),
      ),
    );
  }

  async validateUser(dto: LoginDto): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('validate_user', dto)
        .pipe(
          catchError(() => throwError(() => new Error('Validation failed'))),
        ),
    );
  }

  async verifyUser(id: string): Promise<void> {
    return lastValueFrom(
      this.rmqClient.send<void>('verify_user', id).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to verify user'));
        }),
      ),
      { defaultValue: undefined },
    );
  }

  async findByEmail(email: string): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('user.find_by_email', { email })
        .pipe(
          catchError(() => {
            return of(null);
          }),
        ),
      { defaultValue: null },
    );
  }

  async findById(id: string): Promise<ValidateUserResponse | null> {
    return lastValueFrom(
      this.rmqClient
        .send<ValidateUserResponse | null>('user.find_by_id', id)
        .pipe(timeout(5000)),
      { defaultValue: null },
    );
  }

  async createSocialUser(
    dto: CreateSocialUserDto,
  ): Promise<ValidateUserResponse> {
    return lastValueFrom(
      this.rmqClient.send<ValidateUserResponse>('user.create_social', dto).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to create social user'));
        }),
      ),
    );
  }

  rollbackUser(id: string): void {
    this.rmqClient.emit('user.rollback', { id });
  }

  async updateUser(payload: UpdateUserPayload): Promise<UpdateUserResponse> {
    return await lastValueFrom(
      this.rmqClient.send<UpdateUserResponse>('update_user', payload).pipe(
        catchError(() => {
          return throwError(() => new Error('Failed to update user'));
        }),
      ),
    );
  }
}
