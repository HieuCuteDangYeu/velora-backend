import { SendIncomingCallNotificationUseCase } from './send-incoming-call-notification.use-case';

it('persists group identity with the incoming notification job', async () => {
  const repository = { create: jest.fn().mockResolvedValue({ id: 'job-1' }) };
  const processor = {
    execute: jest.fn().mockResolvedValue({ status: 'sent' }),
  };
  const useCase = new SendIncomingCallNotificationUseCase(
    repository as never,
    processor as never,
  );

  await useCase.execute({
    recipientUserId: 'guest',
    initiatorId: 'host',
    targetUserId: 'guest',
    conversationId: 'conversation',
    callId: 'room-1',
    callType: 'VOICE',
    initiatorDisplayName: 'Ada',
    isGroupCall: true,
    groupName: 'Team Velora',
    groupAvatarUrl: 'https://cdn.example/group.png',
    ringTimeoutMs: 30_000,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });

  expect(repository.create).toHaveBeenCalledWith(
    expect.objectContaining({
      dataJson: expect.objectContaining({
        isGroupCall: true,
        groupName: 'Team Velora',
        groupAvatarUrl: 'https://cdn.example/group.png',
      }),
    }),
  );
  expect(processor.execute).toHaveBeenCalledWith({ id: 'job-1' });
});
