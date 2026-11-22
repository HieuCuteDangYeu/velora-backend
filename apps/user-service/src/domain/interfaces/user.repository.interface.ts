import { UserResponse } from '@common/user/interfaces/find-all-users.types';
import { User } from '@user/domain/entities/user.entity';

export interface FindAllParams {
  skip: number;
  limit: number;
  search?: string;
  sort?: 'asc' | 'desc';
}

export interface SearchPublicUsersParams {
  query: string;
  limit: number;
  excludedUserIds?: string[];
}

export interface RecommendedPublicUsersParams {
  limit: number;
  excludedUserIds?: string[];
}

export interface IUserRepository {
  save(user: User): Promise<User>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findByIds(ids: string[]): Promise<User[]>;
  findAll(
    params: FindAllParams,
  ): Promise<{ users: UserResponse[]; total: number }>;
  searchPublicUsers(params: SearchPublicUsersParams): Promise<User[]>;
  findRecommendedPublicUsers(
    params: RecommendedPublicUsersParams,
  ): Promise<User[]>;
  isUsernameAvailable(
    username: string,
    excludeUserId?: string,
  ): Promise<boolean>;
  update(id: string, data: Partial<User>): Promise<User>;
  /** Hard delete. Only the registration rollback may use it; accounts are banned instead. */
  delete(id: string): Promise<User>;
  ban(id: string, data: { reason: string; bannedBy: string }): Promise<User>;
  unban(id: string): Promise<User>;
  findBannedIds(): Promise<string[]>;
  countUsersByIds(ids: string[]): Promise<number>;
}
