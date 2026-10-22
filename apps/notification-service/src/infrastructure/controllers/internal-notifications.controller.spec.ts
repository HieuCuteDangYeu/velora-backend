import { BadRequestException } from '@nestjs/common';
import type { SendNewMessageNotificationUseCase } from '../../application/use-cases/send-new-message-notification.use-case';
import { InternalNotificationsController } from './internal-notifications.controller';

const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const THIRD_ID = '33333333-3333-4333-8333-333333333333';
const INTERNAL_SECRET = 'internal-secret';

describe('InternalNotificationsController new-message compatibility', () => {
  let sendNewMessageNotification: { execute: jest.Mock };
  let controller: InternalNotificationsController;
  let previousSecret: string | undefined;

  beforeEach(() => {
    previousSecret = process.env.NOTIFICATION_INTERNAL_SECRET;
    process.env.NOTIFICATION_INTERNAL_SECRET = INTERNAL_SECRET;

    sendNewMessageNotification = {
      execute: jest.fn().mockResolvedValue({ recipientCount: 1, results: [] }),
    };

    controller = new InternalNotificationsController(
      sendNewMessageNotification as unknown as SendNewMessageNotificationUseCase,
    );
  });

  afterEach(() => {
    if (previousSecret === undefined) {
      delete process.env.NOTIFICATION_INTERNAL_SECRET;
    } else {
      process.env.NOTIFICATION_INTERNAL_SECRET = previousSecret;
    }
  });

  it('normalizes the legacy singular recipient contract into recipientUserIds', async () => {
    await controller.sendNewMessage(INTERNAL_SECRET, {
      recipientUserId: MEMBER_ID,
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Alice',
      body: 'Hello there',
    });

    expect(sendNewMessageNotification.execute).toHaveBeenCalledWith({
      recipientUserIds: [MEMBER_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Alice',
      body: 'Hello there',
    });
  });

  it('accepts and deduplicates the batched recipient contract', async () => {
    await controller.sendNewMessage(INTERNAL_SECRET, {
      recipientUserIds: [MEMBER_ID, THIRD_ID, MEMBER_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Core Team',
      body: 'Alice: Hello there',
    });

    expect(sendNewMessageNotification.execute).toHaveBeenCalledWith({
      recipientUserIds: [MEMBER_ID, THIRD_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Core Team',
      body: 'Alice: Hello there',
    });
  });

  it('merges singular and batched recipients during rolling deployments', async () => {
    await controller.sendNewMessage(INTERNAL_SECRET, {
      recipientUserId: MEMBER_ID,
      recipientUserIds: [THIRD_ID, MEMBER_ID],
      actorUserId: ACTOR_ID,
      conversationId: 'conversation-id',
      messageId: 'message-id',
      title: 'Core Team',
      body: 'Alice: Hello there',
    });

    expect(sendNewMessageNotification.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientUserIds: [THIRD_ID, MEMBER_ID],
      }),
    );
  });

  it('rejects requests that contain no recipient field', async () => {
    await expect(
      controller.sendNewMessage(INTERNAL_SECRET, {
        actorUserId: ACTOR_ID,
        conversationId: 'conversation-id',
        messageId: 'message-id',
        title: 'Alice',
        body: 'Hello there',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(sendNewMessageNotification.execute).not.toHaveBeenCalled();
  });
});
