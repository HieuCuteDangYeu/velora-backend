import { LoginDto } from '@common/auth/dtos/login.dto';
import { RegisterDto } from '@common/auth/dtos/register.dto';
import { CreateSocialUserDto } from '@common/user/dtos/create-social-user.dto';
import { CreateUserResponse } from '@common/user/interfaces/create-user-response.types';
import {
  UpdateUserPayload,
  UpdateUserResponse,
} from '@common/user/interfaces/update-user.types';
import { ValidateUserResponse } from '@common/user/interfaces/validate-user-response.types';

export interface IUserService {
  createUser(dto: RegisterDto): Promise<CreateUserResponse>;
  validateUser(dto: LoginDto): Promise<ValidateUserResponse | null>;
  verifyUser(id: string): Promise<void>;
  findById(id: string): Promise<ValidateUserResponse | null>;
  findByIdForAuth(id: string): Promise<ValidateUserResponse | null>;
  invalidateCachedUser(id: string): Promise<void>;
  findByEmail(email: string): Promise<ValidateUserResponse | null>;
  createSocialUser(dto: CreateSocialUserDto): Promise<ValidateUserResponse>;
  rollbackUser(id: string): void;
  updateUser(payload: UpdateUserPayload): Promise<UpdateUserResponse>;
}
