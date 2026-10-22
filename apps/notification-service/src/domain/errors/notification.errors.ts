export class PushTokenLifecycleConflictError extends Error {
  constructor() {
    super('Push token lifecycle has advanced');
    this.name = PushTokenLifecycleConflictError.name;
  }
}

export class FcmPushTokenInvalidatedError extends Error {
  readonly code = 'FCM_TOKEN_INVALIDATED';

  constructor() {
    super('FCM push token has been invalidated');
    this.name = FcmPushTokenInvalidatedError.name;
  }
}
