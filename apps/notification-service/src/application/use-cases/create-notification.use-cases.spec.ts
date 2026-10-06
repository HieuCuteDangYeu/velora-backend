import type { CreateNotificationJobInput } from '../../domain/entities/notification-job.entity';
import { SendIncomingCallNotificationUseCase } from './send-incoming-call-notification.use-case';

describe('notification creation use cases', () => {
  it('persists incoming-call metadata and processes the job', async () => {
    const job = { id: 'call-job-1' };
    let createdJob: CreateNotificationJobInput | undefined;
    const createJob = (input: CreateNotificationJobInput) => {
      createdJob = input;
      return Promise.resolve(job);
    };
    const notificationJobRepository = {
      create: jest.fn(createJob),
    };
    const processNotificationJob = {
      execute: jest.fn().mockResolvedValue({ status: 'sent' }),
    };
    const useCase = new SendIncomingCallNotificationUseCase(
      notificationJobRepository as never,
      processNotificationJob as never,
    );
    const input = {
      recipientUserId: 'user-1',
      initiatorId: 'user-2',
      targetUserId: 'user-1',
      conversationId: 'conversation-1',
      callId: 'call-1',
      callType: 'VOICE' as const,
      initiatorDisplayName: 'Ada',
      ringTimeoutMs: 30_000,
      expiresAt: '2026-07-28T00:00:30.000Z',
    };

    await useCase.execute(input);

    expect(createdJob).toMatchObject({
      type: 'INCOMING_CALL',
      recipientUserId: 'user-1',
      callId: 'call-1',
      expiresAt: new Date(input.expiresAt),
      idempotencyKey: 'incoming-call:call-1:user-1',
      dataJson: {
        type: 'INCOMING_CALL',
        initiatorId: 'user-2',
        targetUserId: 'user-1',
        callType: 'VOICE',
      },
    });
    expect(processNotificationJob.execute).toHaveBeenCalledWith(job);
  });
});
