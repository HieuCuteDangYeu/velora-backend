import { SendMissedCallNotificationUseCase } from './send-missed-call-notification.use-case';

describe('SendMissedCallNotificationUseCase', () => {
  const setup = () => {
    const notificationJobRepository = {
      create: jest.fn((input: Record<string, unknown>) =>
        Promise.resolve({
          id: `job-${String(input.recipientUserId)}`,
          ...input,
        }),
      ),
    };
    const processNotificationJob = {
      execute: jest.fn().mockResolvedValue({ status: 'sent' }),
    };
    const useCase = new SendMissedCallNotificationUseCase(
      notificationJobRepository as never,
      processNotificationJob as never,
    );
    return { useCase, notificationJobRepository, processNotificationJob };
  };

  it('creates and sends one durable job per callee for a 1-1 call', async () => {
    const { useCase, notificationJobRepository, processNotificationJob } =
      setup();

    await useCase.execute({
      recipientUserIds: ['callee', 'callee', ' '],
      callId: 'call-1',
      conversationId: 'conversation-1',
      callType: 'VIDEO',
      initiatorId: 'caller',
      initiatorDisplayName: 'Quân',
    });

    expect(notificationJobRepository.create).toHaveBeenCalledTimes(1);
    expect(notificationJobRepository.create).toHaveBeenCalledWith({
      type: 'MISSED_CALL',
      recipientUserId: 'callee',
      actorUserId: 'caller',
      conversationId: 'conversation-1',
      callId: 'call-1',
      title: 'Quân',
      body: 'Missed video call',
      dataJson: { type: 'MISSED_CALL', callType: 'VIDEO' },
      idempotencyKey: 'missed-call:["call-1","callee"]',
    });
    expect(processNotificationJob.execute).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'job-callee' }),
    );
  });

  it('titles group calls with the group and keys by invitation', async () => {
    const { useCase, notificationJobRepository } = setup();

    await useCase.execute({
      recipientUserIds: ['member', 'starter'],
      callId: 'group-call',
      invitationIdByUserId: { member: 'invite-2' },
      conversationId: 'group-1',
      callType: 'VOICE',
      isGroupCall: true,
      groupName: 'Team',
      initiatorId: 'starter',
      initiatorDisplayName: 'Quân',
    });

    // The initiator is never told they missed their own call.
    expect(notificationJobRepository.create).toHaveBeenCalledTimes(1);
    expect(notificationJobRepository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserId: 'member',
        title: 'Team',
        body: 'Missed group voice call from Quân',
        dataJson: { type: 'MISSED_CALL', callType: 'VOICE', isGroupCall: true },
        idempotencyKey: 'missed-call:["invite-2","member"]',
      }),
    );
  });
});
