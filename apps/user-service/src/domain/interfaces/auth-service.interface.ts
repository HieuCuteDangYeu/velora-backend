export interface IAuthService {
  deleteUserRoles(userId: string): void;
  assignRole(userId: string, roleName: string): Promise<void>;
  banUser(userId: string): Promise<void>;
  unbanUser(userId: string): Promise<void>;
}
