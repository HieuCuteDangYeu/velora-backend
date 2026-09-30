export type PushProvider = 'fcm' | 'apns_voip';
export type PushPlatform = 'ios' | 'android';
export type PushDeliveryEnvironment = 'development' | 'production';

export type RegisterPushTokenInput =
  | {
      provider: 'fcm';
      platform: PushPlatform;
      token: string;
      deviceId?: string;
      appVersion?: string;
      groupLifecycleVersion?: number;
      lifecycleVersion?: number;
    }
  | {
      provider: 'apns_voip';
      platform: 'ios';
      token: string;
      deviceId?: string;
      appVersion?: string;
      groupLifecycleVersion?: number;
      lifecycleVersion?: number;
      bundleId: string;
      deliveryEnvironment: PushDeliveryEnvironment;
    };

export type DeactivatePushTokenInput = {
  provider: PushProvider;
  token: string;
  deviceId?: string;
  lifecycleVersion?: number;
};

export type PushTokenProps = {
  id: string;
  userId: string;
  provider: PushProvider;
  platform: PushPlatform;
  token: string;
  deviceId: string | null;
  appVersion: string | null;
  groupLifecycleVersion?: number;
  bundleId: string | null;
  deliveryEnvironment: PushDeliveryEnvironment | null;
  isActive: boolean;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
};

export class PushToken {
  readonly id: string;
  readonly userId: string;
  readonly provider: PushProvider;
  readonly platform: PushPlatform;
  readonly token: string;
  readonly deviceId: string | null;
  readonly appVersion: string | null;
  readonly groupLifecycleVersion: number;
  readonly bundleId: string | null;
  readonly deliveryEnvironment: PushDeliveryEnvironment | null;
  readonly isActive: boolean;
  readonly lastSeenAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;

  constructor(props: PushTokenProps) {
    Object.assign(this, props);
    this.groupLifecycleVersion = props.groupLifecycleVersion ?? 1;
  }
}
