import {
  DeactivatePushTokenInput,
  PushPlatform,
  PushProvider,
  PushToken,
  RegisterPushTokenInput,
} from '../entities/push-token.entity';

export type PushTokenFilters = {
  provider?: PushProvider;
  platform?: PushPlatform;
};

export type UpdateCount = {
  count: number;
};

export abstract class IPushTokenRepository {
  abstract upsert(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<PushToken>;

  abstract deactivate(
    userId: string,
    input: DeactivatePushTokenInput,
    includeLegacyDeviceRegistration: boolean,
  ): Promise<UpdateCount>;

  abstract deactivateRegistration(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<UpdateCount>;

  abstract deactivateOtherDeviceTokens(
    userId: string,
    input: RegisterPushTokenInput,
  ): Promise<UpdateCount>;

  abstract findActiveByUserId(
    userId: string,
    filters?: PushTokenFilters,
  ): Promise<PushToken[]>;

  abstract deactivateById(id: string): Promise<UpdateCount>;
}
