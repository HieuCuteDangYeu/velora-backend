import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { lastValueFrom, timeout } from 'rxjs';
import { IAuthService } from '../../domain/interfaces/auth-service.interface';

@Injectable()
export class AuthServiceAdapter implements IAuthService {
  private readonly logger = new Logger(AuthServiceAdapter.name);

  constructor(
    @Inject('AUTH_SERVICE_RMQ') private readonly rmqClient: ClientProxy,
  ) {}

  async assignRole(userId: string, roleName: string): Promise<void> {
    const pattern = 'auth.assign_role';
    try {
      await lastValueFrom(
        this.rmqClient.send(pattern, { userId, roleName }).pipe(timeout(10000)),
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';

      this.logger.error(`Failed to assign role: ${errorMessage}`);
      throw error;
    }
  }

  async banUser(userId: string): Promise<void> {
    await lastValueFrom(
      this.rmqClient.send('auth.ban_user', { userId }).pipe(timeout(10000)),
    );
  }

  async unbanUser(userId: string): Promise<void> {
    await lastValueFrom(
      this.rmqClient.send('auth.unban_user', { userId }).pipe(timeout(10000)),
    );
  }

  deleteUserRoles(userId: string): void {
    this.rmqClient.emit('auth.delete_user_roles', { userId });
  }
}
