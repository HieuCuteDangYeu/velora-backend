import type { SendApnsVoipPushInput } from '../../domain/interfaces/apns-voip.gateway.interface';
import type { SendFcmPushInput } from '../../domain/interfaces/fcm-push.gateway.interface';
import { ProcessNotificationJobUseCase } from './process-notification-job.use-case';
import { SendCallStateUpdateUseCase } from './send-call-state-update.use-case';

describe('notification delivery use cases', () => {
  const baseJob = {
    id: 'job-1',
    type: 'NEW_MESSAGE',
    recipientUserId: 'user-1',
    actorUserId: 'user-2',
    conversationId: 'conversation-1',
    messageId: 'message-1',
    callId: null,
    title: 'New message',
    body: 'You have a new message from Velora.',
    dataJson: null,
    expiresAt: null,
    status: 'pending',
    attemptCount: 0,
    nextAttemptAt: null,
  };

  const createUseCases = () => {
    const markFailedInputs: Array<
      [id: string, error: string, nextAttemptAt?: Date]
    > = [];
    const fcmInputs: SendFcmPushInput[] = [];
    const apnsVoipInputs: SendApnsVoipPushInput[] = [];
    const createdJobs = new Map<string, Record<string, unknown>>();
    let createdJobCount = 0;
    const markFailed = (
      id: string,
      error: string,
      nextAttemptAt?: Date,
    ): Promise<unknown> => {
      markFailedInputs.push([id, error, nextAttemptAt]);
      return Promise.resolve(undefined);
    };
    const sendFcmPush = (input: SendFcmPushInput): Promise<string> => {
      fcmInputs.push(input);
      return Promise.resolve('fcm-message-id');
    };
    const sendApnsVoipPush = (input: SendApnsVoipPushInput): Promise<void> => {
      apnsVoipInputs.push(input);
      return Promise.resolve();
    };
    const notificationJobRepository = {
      create: jest.fn((input) => {
        const id = `created-job-${++createdJobCount}`;
        const job = {
          id,
          actorUserId: null,
          conversationId: null,
          messageId: null,
          callId: null,
          dataJson: null,
          expiresAt: null,
          status: 'pending',
          attemptCount: 0,
          nextAttemptAt: null,
          ...input,
        };
        createdJobs.set(id, job);

        return Promise.resolve(job);
      }),
      claimForProcessing: jest.fn((id: string) => {
        const job = createdJobs.get(id);

        if (!job) {
          return Promise.resolve(undefined);
        }

        return Promise.resolve({
          ...job,
          status: 'processing',
          attemptCount: (job.attemptCount as number) + 1,
        });
      }),
      markSkipped: jest.fn(),
      markSent: jest.fn(),
      markFailed: jest.fn(markFailed),
    };
    const pushTokenRepository = {
      findActiveByUserId: jest.fn(),
      deactivateById: jest.fn(),
    };
    const fcmPushGateway = {
      send: jest.fn(sendFcmPush),
    };
    const apnsVoipGateway = {
      send: jest.fn(sendApnsVoipPush),
    };

    const processNotificationJob = new ProcessNotificationJobUseCase(
      notificationJobRepository as never,
      pushTokenRepository as never,
      fcmPushGateway,
      apnsVoipGateway,
    );
    const sendCallStateUpdate = new SendCallStateUpdateUseCase(
      notificationJobRepository as never,
      processNotificationJob,
    );

    return {
      processNotificationJob,
      sendCallStateUpdate,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
      apnsVoipGateway,
      markFailedInputs,
      fcmInputs,
      apnsVoipInputs,
    };
  };

  it('schedules the next attempt when every send fails before the max retry count', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
      markFailedInputs,
    } = createUseCases();
    const startedAt = Date.now();

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...baseJob,
      status: 'processing',
      attemptCount: 1,
    });
    pushTokenRepository.findActiveByUserId.mockResolvedValue([
      {
        id: 'token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'android',
        token: 'fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
    ]);
    fcmPushGateway.send.mockRejectedValue({
      code: 'messaging/internal-error',
      message: 'FCM unavailable',
    });

    const result = await processNotificationJob.execute(baseJob as never);

    expect(result.status).toBe('failed');
    expect(notificationJobRepository.markFailed).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('token-1: messaging/internal-error'),
      expect.any(Date),
    );

    const scheduledAt = markFailedInputs[0][2];

    expect(scheduledAt).toBeInstanceOf(Date);
    expect(scheduledAt?.getTime()).toBeGreaterThanOrEqual(startedAt + 59_000);
    expect(scheduledAt?.getTime()).toBeLessThanOrEqual(startedAt + 61_000);
  });

  it('does not send a job that another worker already claimed', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
    } = createUseCases();

    notificationJobRepository.claimForProcessing.mockResolvedValue(null);

    await expect(
      processNotificationJob.execute(baseJob as never),
    ).resolves.toEqual(
      expect.objectContaining({
        jobId: 'job-1',
        status: 'deferred',
      }),
    );
    expect(pushTokenRepository.findActiveByUserId).not.toHaveBeenCalled();
    expect(fcmPushGateway.send).not.toHaveBeenCalled();
  });

  it('stops scheduling retries after the max retry count is reached', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
    } = createUseCases();

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...baseJob,
      status: 'processing',
      attemptCount: 3,
    });
    pushTokenRepository.findActiveByUserId.mockResolvedValue([
      {
        id: 'token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'android',
        token: 'fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
    ]);
    fcmPushGateway.send.mockRejectedValue({
      code: 'messaging/internal-error',
      message: 'FCM unavailable',
    });

    await processNotificationJob.execute(baseJob as never);

    expect(notificationJobRepository.markFailed).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('token-1: messaging/internal-error'),
      undefined,
    );
  });

  it('delivers incoming calls through Android FCM data and iOS APNs VoIP', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmInputs,
      apnsVoipInputs,
    } = createUseCases();
    const expiresAt = new Date(Date.now() + 30_000);
    const incomingCallJob = {
      ...baseJob,
      id: 'call-job-1',
      type: 'INCOMING_CALL',
      actorUserId: 'user-2',
      messageId: null,
      callId: 'call-1',
      title: 'Ada',
      body: 'Incoming voice call',
      expiresAt,
      dataJson: {
        type: 'INCOMING_CALL',
        callId: 'call-1',
        initiatorId: 'user-2',
        targetUserId: 'user-1',
        callType: 'VOICE',
        initiatorDisplayName: 'Ada',
        initiatorAvatarUrl: 'https://cdn.example/avatar.png',
        ringTimeoutMs: 30000,
        expiresAt: expiresAt.toISOString(),
      },
    };

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...incomingCallJob,
      status: 'processing',
      attemptCount: 1,
    });
    pushTokenRepository.findActiveByUserId
      .mockResolvedValueOnce([
        {
          id: 'android-token-1',
          userId: 'user-1',
          provider: 'fcm',
          platform: 'android',
          token: 'fcm-token-1',
          bundleId: null,
          deliveryEnvironment: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'voip-token-1',
          userId: 'user-1',
          provider: 'apns_voip',
          platform: 'ios',
          token: 'voip-token-1',
          bundleId: 'com.quan.velora',
          deliveryEnvironment: 'production',
        },
      ]);
    const result = await processNotificationJob.execute(
      incomingCallJob as never,
    );

    expect(result.status).toBe('sent');
    const incomingCallFcmInput = fcmInputs[0];
    expect(incomingCallFcmInput).toMatchObject({
      token: 'fcm-token-1',
      includeNotification: false,
      data: {
        type: 'INCOMING_CALL',
        callId: 'call-1',
        initiatorId: 'user-2',
        targetUserId: 'user-1',
        initiatorDisplayName: 'Ada',
      },
    });
    const incomingCallVoipInput = apnsVoipInputs[0];
    expect(incomingCallVoipInput).toMatchObject({
      token: 'voip-token-1',
      bundleId: 'com.quan.velora',
      deliveryEnvironment: 'production',
      payload: {
        type: 'INCOMING_CALL',
        callId: 'call-1',
        initiatorId: 'user-2',
        targetUserId: 'user-1',
      },
    });
    expect(notificationJobRepository.markSent).toHaveBeenCalledWith(
      'call-job-1',
    );
  });

  it('delivers terminal call state updates through Android and iOS FCM without using APNs VoIP', async () => {
    const {
      sendCallStateUpdate,
      notificationJobRepository,
      pushTokenRepository,
      apnsVoipGateway,
      fcmInputs,
    } = createUseCases();

    pushTokenRepository.findActiveByUserId.mockResolvedValue([
      {
        id: 'android-token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'android',
        token: 'fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
      {
        id: 'ios-token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'ios',
        token: 'ios-fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
    ]);
    const result = await sendCallStateUpdate.execute({
      recipientUserIds: ['user-1'],
      conversationId: 'conversation-1',
      callId: 'call-1',
      status: 'ended',
      reason: 'ended',
      lifecycleRevision: 4,
      at: '2026-07-08T00:00:00.000Z',
    });

    expect(result.status).toBe('sent');
    expect(notificationJobRepository.create).toHaveBeenCalledWith({
      type: 'CALL_STATE_UPDATE',
      recipientUserId: 'user-1',
      conversationId: 'conversation-1',
      callId: 'call-1',
      title: 'Call update',
      body: '',
      idempotencyKey: 'call-state:call-1:user-1:revision:4',
      dataJson: {
        type: 'CALL_STATE_UPDATE',
        platforms: ['android', 'ios'],
        status: 'ended',
        reason: 'ended',
        lifecycleRevision: 4,
        at: '2026-07-08T00:00:00.000Z',
      },
    });
    expect(pushTokenRepository.findActiveByUserId).toHaveBeenCalledWith(
      'user-1',
      {
        provider: 'fcm',
      },
    );
    expect(
      fcmInputs.find((input) => input.token === 'fcm-token-1'),
    ).toMatchObject({
      includeNotification: false,
      data: {
        type: 'CALL_STATE_UPDATE',
        callId: 'call-1',
        recipientUserId: 'user-1',
        status: 'ended',
        lifecycleRevision: 4,
      },
    });
    expect(
      fcmInputs.find((input) => input.token === 'ios-fcm-token-1'),
    ).toMatchObject({
      includeNotification: false,
      apnsContentAvailable: true,
      apnsBackground: true,
      data: {
        type: 'CALL_STATE_UPDATE',
        callId: 'call-1',
        recipientUserId: 'user-1',
        status: 'ended',
        lifecycleRevision: 4,
      },
    });
    expect(apnsVoipGateway.send).not.toHaveBeenCalled();
  });

  it('delivers active call state updates through Android and iOS FCM without using APNs VoIP', async () => {
    const {
      sendCallStateUpdate,
      pushTokenRepository,
      apnsVoipGateway,
      fcmInputs,
    } = createUseCases();

    pushTokenRepository.findActiveByUserId.mockImplementation(
      (userId: string) =>
        Promise.resolve([
          {
            id: `android-token-${userId}`,
            userId,
            provider: 'fcm',
            platform: 'android',
            token: `android-fcm-token-${userId}`,
            bundleId: null,
            deliveryEnvironment: null,
          },
          {
            id: `ios-token-${userId}`,
            userId,
            provider: 'fcm',
            platform: 'ios',
            token: `ios-fcm-token-${userId}`,
            bundleId: null,
            deliveryEnvironment: null,
          },
        ]),
    );
    const result = await sendCallStateUpdate.execute({
      recipientUserIds: ['user-1', 'user-2'],
      iosRecipientUserIds: ['user-1'],
      conversationId: 'conversation-1',
      callId: 'call-1',
      status: 'active',
      lifecycleRevision: 3,
      at: '2026-07-08T00:00:00.000Z',
    });

    expect(result.status).toBe('sent');
    expect(pushTokenRepository.findActiveByUserId).toHaveBeenCalledTimes(2);
    expect(pushTokenRepository.findActiveByUserId).toHaveBeenCalledWith(
      'user-1',
      {
        provider: 'fcm',
      },
    );
    expect(pushTokenRepository.findActiveByUserId).toHaveBeenCalledWith(
      'user-2',
      {
        provider: 'fcm',
      },
    );
    const activeCallStateMessage = fcmInputs[0];
    expect(activeCallStateMessage).toEqual(
      expect.objectContaining({
        token: 'android-fcm-token-user-1',
      }),
    );
    expect(activeCallStateMessage.apnsContentAvailable).toBeUndefined();
    expect(activeCallStateMessage.apnsBackground).toBeUndefined();
    const iosActiveCallInput = fcmInputs.find(
      (input) => input.token === 'ios-fcm-token-user-1',
    );
    expect(iosActiveCallInput).toMatchObject({
      apnsContentAvailable: true,
      apnsBackground: true,
      data: {
        type: 'CALL_STATE_UPDATE',
        callId: 'call-1',
        recipientUserId: 'user-1',
        status: 'active',
        lifecycleRevision: 3,
      },
    });
    expect(
      fcmInputs.find((input) => input.token === 'ios-fcm-token-user-2'),
    ).toBeUndefined();
    expect(apnsVoipGateway.send).not.toHaveBeenCalled();
  });

  it('keeps a partially delivered call-state update retryable for another signed-in device', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
      markFailedInputs,
    } = createUseCases();
    const startedAt = Date.now();
    const callStateJob = {
      ...baseJob,
      id: 'call-state-job-1',
      type: 'CALL_STATE_UPDATE',
      actorUserId: null,
      messageId: null,
      callId: 'call-1',
      title: 'Call update',
      body: '',
      dataJson: {
        type: 'CALL_STATE_UPDATE',
        platforms: ['android', 'ios'],
        status: 'ended',
        lifecycleRevision: 4,
        at: '2026-07-08T00:00:00.000Z',
      },
    };

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...callStateJob,
      status: 'processing',
      attemptCount: 1,
    });
    pushTokenRepository.findActiveByUserId.mockResolvedValue([
      {
        id: 'android-token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'android',
        token: 'fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
      {
        id: 'ios-token-1',
        userId: 'user-1',
        provider: 'fcm',
        platform: 'ios',
        token: 'ios-fcm-token-1',
        bundleId: null,
        deliveryEnvironment: null,
      },
    ]);
    fcmPushGateway.send
      .mockResolvedValueOnce('android-message-id')
      .mockRejectedValueOnce({
        code: 'messaging/internal-error',
        message: 'FCM unavailable',
      });

    const result = await processNotificationJob.execute(callStateJob as never);

    expect(result.status).toBe('failed');
    expect(notificationJobRepository.markSent).not.toHaveBeenCalled();
    expect(notificationJobRepository.markFailed).toHaveBeenCalledWith(
      'call-state-job-1',
      expect.stringContaining('ios-token-1: messaging/internal-error'),
      expect.any(Date),
    );
    expect(markFailedInputs[0][2]?.getTime()).toBeGreaterThanOrEqual(
      startedAt + 59_000,
    );
  });

  it('skips a malformed persisted call-state update without sending it', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
    } = createUseCases();
    const malformedCallStateJob = {
      ...baseJob,
      id: 'call-state-job-1',
      type: 'CALL_STATE_UPDATE',
      actorUserId: null,
      messageId: null,
      callId: null,
      title: 'Call update',
      body: '',
      dataJson: {
        type: 'CALL_STATE_UPDATE',
        platforms: ['android'],
        status: 'ended',
        at: '2026-07-08T00:00:00.000Z',
      },
    };

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...malformedCallStateJob,
      status: 'processing',
      attemptCount: 1,
    });

    const result = await processNotificationJob.execute(
      malformedCallStateJob as never,
    );

    expect(result.status).toBe('skipped');
    expect(pushTokenRepository.findActiveByUserId).not.toHaveBeenCalled();
    expect(notificationJobRepository.markSkipped).toHaveBeenCalledWith(
      'call-state-job-1',
      'Malformed call state update payload',
    );
  });

  it('does not retry incoming calls past expiresAt', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
      fcmPushGateway,
    } = createUseCases();
    const expiresAt = new Date(Date.now() + 1000);
    const incomingCallJob = {
      ...baseJob,
      id: 'call-job-1',
      type: 'INCOMING_CALL',
      callId: 'call-1',
      title: 'Ada',
      body: 'Incoming voice call',
      expiresAt,
      dataJson: {
        type: 'INCOMING_CALL',
        callId: 'call-1',
        callType: 'VOICE',
        initiatorDisplayName: 'Ada',
        ringTimeoutMs: 30000,
        expiresAt: expiresAt.toISOString(),
      },
    };

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...incomingCallJob,
      status: 'processing',
      attemptCount: 1,
    });
    pushTokenRepository.findActiveByUserId
      .mockResolvedValueOnce([
        {
          id: 'android-token-1',
          userId: 'user-1',
          provider: 'fcm',
          platform: 'android',
          token: 'fcm-token-1',
          bundleId: null,
          deliveryEnvironment: null,
        },
      ])
      .mockResolvedValueOnce([]);
    fcmPushGateway.send.mockRejectedValue({
      code: 'messaging/internal-error',
      message: 'FCM unavailable',
    });

    await processNotificationJob.execute(incomingCallJob as never);

    expect(notificationJobRepository.markFailed).toHaveBeenCalledWith(
      'call-job-1',
      expect.stringContaining('android-token-1: messaging/internal-error'),
      undefined,
    );
  });

  it('skips incoming calls that expired before processing', async () => {
    const {
      processNotificationJob,
      notificationJobRepository,
      pushTokenRepository,
    } = createUseCases();
    const expiredJob = {
      ...baseJob,
      id: 'call-job-1',
      type: 'INCOMING_CALL',
      callId: 'call-1',
      expiresAt: new Date(Date.now() - 1000),
      dataJson: {
        type: 'INCOMING_CALL',
        callId: 'call-1',
        callType: 'VOICE',
        initiatorDisplayName: 'Ada',
        ringTimeoutMs: 30000,
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      },
    };

    notificationJobRepository.claimForProcessing.mockResolvedValue({
      ...expiredJob,
      status: 'processing',
      attemptCount: 1,
    });

    const result = await processNotificationJob.execute(expiredJob as never);

    expect(result.status).toBe('skipped');
    expect(pushTokenRepository.findActiveByUserId).not.toHaveBeenCalled();
    expect(notificationJobRepository.markSkipped).toHaveBeenCalledWith(
      'call-job-1',
      'Incoming call expired before delivery',
    );
  });
});
